/**
 * domain/studentLevel — pure, deterministic student-level model + state transitions.
 *
 * This module holds NO LLM calls, NO I/O, NO clocks and NO randomness. Given the
 * same snapshot and the same signal it always produces the same next snapshot, so
 * the behaviour is exhaustively unit-testable on fixed answer sequences.
 *
 * The adaptation service (services/adaptation) is what turns a raw LLM decision
 * into an `updatedLevelSignal`; this module is the one place that decides how such
 * a signal mutates the student's mastery estimate.
 */

/** A learning dimension the course tracks mastery on, e.g. "conceptualUnderstanding". */
export type Dimension = string;

/** Direction a single response pushes a dimension. */
export type LevelDirection = "up" | "down" | "hold";

/** Coarse size of the push. Kept categorical so the LLM can only pick from a set. */
export type LevelMagnitude = "small" | "medium" | "large";

/**
 * A structured, validated instruction to move one dimension. This is exactly the
 * shape the LLM returns under `updatedLevelSignal` in the decision contract.
 */
export interface LevelSignal {
  dimension: Dimension;
  direction: LevelDirection;
  magnitude: LevelMagnitude;
}

/** Per-dimension mastery estimate. All fields are bounded and clamped. */
export interface DimensionState {
  /** Mastery estimate in [0, 1]. */
  level: number;
  /** How much evidence we have for `level`, in [0, 1]. */
  confidence: number;
  /**
   * Signed run length of consistent evidence. Positive after consecutive "up"
   * signals, negative after consecutive "down" signals, reset by "hold" or a
   * direction reversal. Used to let strong/weak streaks accelerate movement.
   */
  streak: number;
  /** Total number of signals ever applied to this dimension. */
  observations: number;
}

/** A full snapshot of a student's level within one module. Immutable by convention. */
export interface StudentLevelSnapshot {
  moduleId: string;
  /** One entry per dimension the module cares about. */
  dimensions: Readonly<Record<Dimension, DimensionState>>;
  /** Monotonic counter of applied signals; deterministic stand-in for a clock. */
  revision: number;
}

/** Base magnitude of movement, before streak acceleration, per magnitude bucket. */
const MAGNITUDE_DELTA: Readonly<Record<LevelMagnitude, number>> = {
  small: 0.05,
  medium: 0.1,
  large: 0.2,
};

/** How much each additional aligned streak step amplifies the base delta (capped). */
const STREAK_ACCELERATION = 0.25;
const MAX_STREAK_MULTIPLIER = 2;

/** Confidence gained per observation (as a fraction of the remaining gap to 1). */
const CONFIDENCE_GAIN = 0.2;
/** Confidence lost when the new direction reverses the current streak. */
const CONFIDENCE_REVERSAL_PENALTY = 0.15;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const roundTo = (n: number, places = 6): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** A fresh dimension starts at the neutral midpoint with zero confidence. */
export function initialDimensionState(
  overrides: Partial<DimensionState> = {},
): DimensionState {
  return {
    level: 0.5,
    confidence: 0,
    streak: 0,
    observations: 0,
    ...overrides,
  };
}

/** Build a fresh snapshot for a module given the dimensions it tracks. */
export function createSnapshot(
  moduleId: string,
  dimensions: readonly Dimension[],
  seed: Partial<Record<Dimension, Partial<DimensionState>>> = {},
): StudentLevelSnapshot {
  const dims: Record<Dimension, DimensionState> = {};
  for (const dimension of dimensions) {
    dims[dimension] = initialDimensionState(seed[dimension] ?? {});
  }
  return { moduleId, dimensions: dims, revision: 0 };
}

/**
 * The sign a direction contributes to a streak / level move.
 * "hold" contributes 0 (no movement, streak resets).
 */
function directionSign(direction: LevelDirection): -1 | 0 | 1 {
  if (direction === "up") return 1;
  if (direction === "down") return -1;
  return 0;
}

/**
 * Compute the next state of a single dimension under a signal. Pure.
 *
 * - "hold" leaves level untouched, decays the streak to 0, still counts as an
 *   observation and still earns a little confidence (we observed the student).
 * - "up"/"down" move the level by a streak-amplified delta and update the streak.
 * - A direction that reverses the current streak resets the streak to +/-1 and
 *   costs some confidence (the student surprised us).
 */
export function applySignalToDimension(
  state: DimensionState,
  direction: LevelDirection,
  magnitude: LevelMagnitude,
): DimensionState {
  const sign = directionSign(direction);
  const observations = state.observations + 1;

  if (sign === 0) {
    // Hold: no movement, streak collapses, modest confidence gain.
    return {
      level: state.level,
      confidence: clamp01(
        roundTo(state.confidence + (1 - state.confidence) * CONFIDENCE_GAIN),
      ),
      streak: 0,
      observations,
    };
  }

  const streakAligned = Math.sign(state.streak) === sign;
  const reversed = state.streak !== 0 && !streakAligned;

  // Streak after this signal.
  const nextStreak = streakAligned ? state.streak + sign : sign;

  // Amplify movement when the streak already runs the same way.
  const alignedRunBefore = streakAligned ? Math.abs(state.streak) : 0;
  const multiplier = Math.min(
    MAX_STREAK_MULTIPLIER,
    1 + alignedRunBefore * STREAK_ACCELERATION,
  );
  const delta = MAGNITUDE_DELTA[magnitude] * multiplier * sign;

  const level = clamp01(roundTo(state.level + delta));

  let confidence = state.confidence + (1 - state.confidence) * CONFIDENCE_GAIN;
  if (reversed) confidence -= CONFIDENCE_REVERSAL_PENALTY;
  confidence = clamp01(roundTo(confidence));

  return { level, confidence, streak: nextStreak, observations };
}

/**
 * Apply an `updatedLevelSignal` to a snapshot, returning a NEW snapshot (the input
 * is never mutated). If the signal names a dimension the snapshot does not track,
 * the dimension is created lazily from its neutral default before the signal is
 * applied — this keeps the transition total for any well-formed signal.
 */
export function applyLevelSignal(
  snapshot: StudentLevelSnapshot,
  signal: LevelSignal,
): StudentLevelSnapshot {
  const current =
    snapshot.dimensions[signal.dimension] ?? initialDimensionState();
  const next = applySignalToDimension(
    current,
    signal.direction,
    signal.magnitude,
  );

  return {
    moduleId: snapshot.moduleId,
    dimensions: { ...snapshot.dimensions, [signal.dimension]: next },
    revision: snapshot.revision + 1,
  };
}

/** Apply a sequence of signals in order. Pure fold over `applyLevelSignal`. */
export function applyLevelSignals(
  snapshot: StudentLevelSnapshot,
  signals: readonly LevelSignal[],
): StudentLevelSnapshot {
  return signals.reduce(applyLevelSignal, snapshot);
}

/**
 * A compact, LLM-facing summary of a snapshot: the numeric internals are rounded
 * and labelled so they can be dropped straight into a prompt without leaking the
 * full object graph. Deterministic.
 */
export interface LevelSummary {
  moduleId: string;
  dimensions: Array<{
    dimension: Dimension;
    level: number;
    band: "novice" | "developing" | "proficient" | "advanced";
    confidence: number;
    observations: number;
  }>;
}

export function levelBand(level: number): LevelSummary["dimensions"][number]["band"] {
  if (level < 0.3) return "novice";
  if (level < 0.6) return "developing";
  if (level < 0.85) return "proficient";
  return "advanced";
}

export function summarizeSnapshot(snapshot: StudentLevelSnapshot): LevelSummary {
  const dimensions = Object.entries(snapshot.dimensions)
    .map(([dimension, state]) => ({
      dimension,
      level: roundTo(state.level, 3),
      band: levelBand(state.level),
      confidence: roundTo(state.confidence, 3),
      observations: state.observations,
    }))
    .sort((a, b) => a.dimension.localeCompare(b.dimension));
  return { moduleId: snapshot.moduleId, dimensions };
}
