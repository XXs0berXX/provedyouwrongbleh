import { describe, it, expect } from "vitest";
import {
  applyLevelSignal,
  applyLevelSignals,
  applySignalToDimension,
  createSnapshot,
  initialDimensionState,
  levelBand,
  summarizeSnapshot,
  type LevelSignal,
  type StudentLevelSnapshot,
} from "./studentLevel.js";

const DIMS = ["concept", "procedure"];

function fresh(): StudentLevelSnapshot {
  return createSnapshot("m1", DIMS);
}

describe("createSnapshot / initialDimensionState", () => {
  it("seeds every dimension at the neutral midpoint with zero confidence", () => {
    const snap = fresh();
    expect(snap.revision).toBe(0);
    for (const dim of DIMS) {
      expect(snap.dimensions[dim]).toEqual({
        level: 0.5,
        confidence: 0,
        streak: 0,
        observations: 0,
      });
    }
  });

  it("applies seed overrides", () => {
    const snap = createSnapshot("m1", DIMS, { concept: { level: 0.9 } });
    expect(snap.dimensions.concept!.level).toBe(0.9);
    expect(snap.dimensions.procedure!.level).toBe(0.5);
  });

  it("initialDimensionState honors overrides", () => {
    expect(initialDimensionState({ confidence: 0.4 }).confidence).toBe(0.4);
  });
});

describe("applySignalToDimension — determinism & bounds", () => {
  it("moves up by the magnitude delta on the first observation", () => {
    const s = applySignalToDimension(initialDimensionState(), "up", "medium");
    expect(s.level).toBe(0.6); // 0.5 + 0.1
    expect(s.streak).toBe(1);
    expect(s.observations).toBe(1);
    expect(s.confidence).toBeGreaterThan(0);
  });

  it("is a pure function — same input, same output", () => {
    const base = initialDimensionState();
    const a = applySignalToDimension(base, "up", "large");
    const b = applySignalToDimension(base, "up", "large");
    expect(a).toEqual(b);
    // input untouched
    expect(base).toEqual(initialDimensionState());
  });

  it("clamps level to [0,1] on repeated large pushes", () => {
    let s = initialDimensionState();
    for (let i = 0; i < 20; i += 1) s = applySignalToDimension(s, "up", "large");
    expect(s.level).toBe(1);
    for (let i = 0; i < 40; i += 1) s = applySignalToDimension(s, "down", "large");
    expect(s.level).toBe(0);
  });

  it("accelerates movement along an aligned streak", () => {
    // Second aligned 'up' moves more than the first because of streak acceleration.
    const first = applySignalToDimension(initialDimensionState(), "up", "small");
    const second = applySignalToDimension(first, "up", "small");
    const firstDelta = first.level - 0.5;
    const secondDelta = second.level - first.level;
    expect(secondDelta).toBeGreaterThan(firstDelta);
    expect(second.streak).toBe(2);
  });

  it("hold leaves level unchanged, resets streak, still counts as observation", () => {
    const up = applySignalToDimension(initialDimensionState(), "up", "large");
    const held = applySignalToDimension(up, "hold", "large");
    expect(held.level).toBe(up.level);
    expect(held.streak).toBe(0);
    expect(held.observations).toBe(up.observations + 1);
    expect(held.confidence).toBeGreaterThan(up.confidence);
  });

  it("penalizes confidence and resets streak on a direction reversal", () => {
    const up2 = applySignalToDimension(
      applySignalToDimension(initialDimensionState(), "up", "medium"),
      "up",
      "medium",
    );
    const reversed = applySignalToDimension(up2, "down", "medium");
    expect(reversed.streak).toBe(-1); // streak reset to the new direction
    // Confidence dropped relative to what a non-reversing observation would give.
    const nonReversing = applySignalToDimension(up2, "up", "medium");
    expect(reversed.confidence).toBeLessThan(nonReversing.confidence);
  });
});

describe("applyLevelSignal — snapshot immutability & lazy dimensions", () => {
  it("returns a new snapshot and never mutates the input", () => {
    const snap = fresh();
    const signal: LevelSignal = { dimension: "concept", direction: "up", magnitude: "medium" };
    const next = applyLevelSignal(snap, signal);
    expect(next).not.toBe(snap);
    expect(snap.dimensions.concept!.level).toBe(0.5); // original untouched
    expect(next.dimensions.concept!.level).toBe(0.6);
    expect(next.revision).toBe(1);
    // Other dimensions carried over unchanged.
    expect(next.dimensions.procedure).toEqual(snap.dimensions.procedure);
  });

  it("lazily creates an unknown dimension from the neutral default", () => {
    const next = applyLevelSignal(fresh(), {
      dimension: "newDim",
      direction: "up",
      magnitude: "small",
    });
    expect(next.dimensions.newDim!.level).toBe(0.55);
    expect(next.dimensions.newDim!.observations).toBe(1);
  });
});

describe("applyLevelSignals — answer sequences (deterministic)", () => {
  it("folds a sequence of correct answers into rising mastery", () => {
    const signals: LevelSignal[] = Array.from({ length: 4 }, () => ({
      dimension: "procedure",
      direction: "up" as const,
      magnitude: "medium" as const,
    }));
    const result = applyLevelSignals(fresh(), signals);
    expect(result.dimensions.procedure!.level).toBeGreaterThan(0.85);
    expect(result.dimensions.procedure!.streak).toBe(4);
    expect(result.revision).toBe(4);
  });

  it("a mixed sequence lands on a stable, reproducible value", () => {
    const signals: LevelSignal[] = [
      { dimension: "concept", direction: "up", magnitude: "medium" },
      { dimension: "concept", direction: "down", magnitude: "small" },
      { dimension: "concept", direction: "hold", magnitude: "small" },
      { dimension: "concept", direction: "up", magnitude: "large" },
    ];
    const a = applyLevelSignals(fresh(), signals);
    const b = applyLevelSignals(fresh(), signals);
    expect(a.dimensions.concept).toEqual(b.dimensions.concept);
    // Exact expected value guards against silent formula drift.
    // 0.5 +0.1 =0.60 ; -0.05 =0.55 ; hold =0.55 ; +0.2 =0.75
    expect(a.dimensions.concept!.level).toBe(0.75);
  });
});

describe("summaries", () => {
  it("levelBand maps ranges to bands", () => {
    expect(levelBand(0.1)).toBe("novice");
    expect(levelBand(0.45)).toBe("developing");
    expect(levelBand(0.7)).toBe("proficient");
    expect(levelBand(0.95)).toBe("advanced");
  });

  it("summarizeSnapshot is sorted and rounded", () => {
    const snap = createSnapshot("m1", ["b", "a"], {
      a: { level: 0.123456, confidence: 0.98765 },
    });
    const summary = summarizeSnapshot(snap);
    expect(summary.dimensions.map((d) => d.dimension)).toEqual(["a", "b"]);
    expect(summary.dimensions[0]!.level).toBe(0.123);
    expect(summary.dimensions[0]!.band).toBe("novice");
  });
});
