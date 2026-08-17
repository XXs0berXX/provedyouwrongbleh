/**
 * services/adaptation/contract — the single, versioned home of the decision
 * contract: the Zod schema the LLM output is validated against, the derived
 * TypeScript types, the input types, and the prompt that instructs the model.
 *
 * The LLM does the judging; this contract forces its decisions into a typed,
 * validated, testable shape. Nothing here calls a model — it is pure data + text.
 */

import { z } from "zod";
import type { LevelDirection, LevelMagnitude } from "../../domain/studentLevel.js";

/** Bump when the contract shape or prompt semantics change. */
export const CONTRACT_VERSION = "adaptation.decision.v1";

// ---------------------------------------------------------------------------
// Decision schema (what the LLM must return)
// ---------------------------------------------------------------------------

export const CorrectnessSchema = z.enum([
  "correct",
  "partially_correct",
  "incorrect",
]);
export type Correctness = z.infer<typeof CorrectnessSchema>;

export const ReasoningQualitySchema = z.enum([
  "strong",
  "adequate",
  "weak",
  "absent",
]);
export type ReasoningQuality = z.infer<typeof ReasoningQualitySchema>;

export const DirectionSchema = z.enum([
  "up",
  "down",
  "hold",
]) satisfies z.ZodType<LevelDirection>;

export const MagnitudeSchema = z.enum([
  "small",
  "medium",
  "large",
]) satisfies z.ZodType<LevelMagnitude>;

export const NextActionSchema = z.enum([
  "probe",
  "advance",
  "reinforce",
  "reframe",
  "stretch",
]);
export type NextAction = z.infer<typeof NextActionSchema>;

export const DifficultySchema = z.enum([
  "easier",
  "same",
  "harder",
  "much_harder",
]);
export type Difficulty = z.infer<typeof DifficultySchema>;

export const AssessmentSchema = z
  .object({
    correctness: CorrectnessSchema,
    reasoningQuality: ReasoningQualitySchema,
    misconceptions: z.array(z.string().min(1).max(400)).max(10),
  })
  .strict();

export const LevelSignalSchema = z
  .object({
    dimension: z.string().min(1).max(120),
    direction: DirectionSchema,
    magnitude: MagnitudeSchema,
  })
  .strict();

export const NextTaskDirectiveSchema = z
  .object({
    difficulty: DifficultySchema,
    focus: z.string().min(1).max(400),
    // The model is REQUIRED to affirm this. `z.literal(true)` rejects `false`.
    mustNotRevealSolution: z.literal(true),
  })
  .strict();

/**
 * The complete structured decision. `.strict()` at every level means any extra
 * key the model hallucinates is a schema violation, not silently accepted.
 */
export const AdaptationDecisionSchema = z
  .object({
    assessment: AssessmentSchema,
    updatedLevelSignal: LevelSignalSchema,
    nextAction: NextActionSchema,
    nextTaskDirective: NextTaskDirectiveSchema,
    socraticFollowup: z.string().min(1).max(600).nullable(),
  })
  .strict();

export type AdaptationDecision = z.infer<typeof AdaptationDecisionSchema>;

// ---------------------------------------------------------------------------
// Inputs to the adaptation engine
// ---------------------------------------------------------------------------

/** The learning objectives + tracked dimensions of the current module. */
export interface ModuleObjectives {
  moduleId: string;
  title: string;
  /** Human-readable objectives; used to keep the model on-scope. */
  objectives: string[];
  /** The dimensions the LLM is allowed to move (must match the snapshot). */
  dimensions: string[];
}

/**
 * A single task presented to the student. `solution` and `solutionKeywords` are
 * the answer key: they are NEVER sent to the model — they exist so the guardrail
 * layer can detect a leaked solution deterministically.
 */
export interface Task {
  id: string;
  prompt: string;
  /** Which dimensions this task primarily exercises. */
  targetDimensions: string[];
  /** The canonical solution. Guardrail-only; withheld from the prompt. */
  solution: string;
  /**
   * Distinctive tokens/phrases from the solution that would constitute a leak
   * if the model echoed them. Guardrail-only; withheld from the prompt.
   */
  solutionKeywords: string[];
}

/** Everything needed to adapt after one student response. */
export interface AdaptationInput {
  objectives: ModuleObjectives;
  snapshot: import("../../domain/studentLevel.js").StudentLevelSnapshot;
  task: Task;
  answer: string;
}

// ---------------------------------------------------------------------------
// Prompt (versioned, single source of truth)
// ---------------------------------------------------------------------------

/**
 * A JSON-schema-ish description embedded in the prompt so the model knows the
 * exact shape to emit. Kept in sync with the Zod schema above by the
 * `contract.test.ts` cross-check.
 */
const DECISION_SHAPE = `{
  "assessment": {
    "correctness": "correct" | "partially_correct" | "incorrect",
    "reasoningQuality": "strong" | "adequate" | "weak" | "absent",
    "misconceptions": string[]   // specific misconceptions observed, [] if none
  },
  "updatedLevelSignal": {
    "dimension": string,          // MUST be one of the module's tracked dimensions
    "direction": "up" | "down" | "hold",
    "magnitude": "small" | "medium" | "large"
  },
  "nextAction": "probe" | "advance" | "reinforce" | "reframe" | "stretch",
  "nextTaskDirective": {
    "difficulty": "easier" | "same" | "harder" | "much_harder",
    "focus": string,             // what the next task should target, on-scope
    "mustNotRevealSolution": true // always exactly true
  },
  "socraticFollowup": string | null  // a QUESTION that probes reasoning, never the answer
}`;

export const SYSTEM_PROMPT = `You are the adaptation engine for an adaptive course. After each student response you decide how to push the course forward. You are Socratic: when the student is wrong or unsure you probe their reasoning with questions; you never hand them the answer. When the student is strong you raise the challenge.

Hard rules (violating any of these makes your output invalid):
1. Output ONLY a single JSON object matching the contract. No prose, no markdown, no code fences.
2. NEVER reveal, state, or strongly hint at the solution to the current task. Not in "focus", not in "socraticFollowup". "socraticFollowup" must be a QUESTION, never a statement of the answer.
3. Stay on-scope: "updatedLevelSignal.dimension" MUST be one of the module's tracked dimensions, and everything you write must serve the module's learning objectives.
4. Be Socratic and honest: if the answer is incorrect or the reasoning is weak, do NOT choose "advance" or "stretch"; probe, reinforce, or reframe instead. If the answer is correct with strong reasoning, do NOT keep the student stuck — advance or stretch.
5. "nextTaskDirective.mustNotRevealSolution" is always exactly true.

Contract (${CONTRACT_VERSION}) — emit exactly this shape:
${DECISION_SHAPE}`;

function bulletList(items: readonly string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)";
}

/** Build the user message for an adaptation call. The answer key is NOT included. */
export function buildUserPrompt(input: AdaptationInput): string {
  const { objectives, snapshot, task, answer } = input;

  // Deterministic, compact snapshot rendering (no clocks / no random ordering).
  const levelLines = Object.entries(snapshot.dimensions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([dim, s]) =>
        `- ${dim}: level=${s.level.toFixed(2)} confidence=${s.confidence.toFixed(
          2,
        )} observations=${s.observations}`,
    )
    .join("\n");

  return `MODULE: ${objectives.title} (id: ${objectives.moduleId})

LEARNING OBJECTIVES:
${bulletList(objectives.objectives)}

TRACKED DIMENSIONS (the only valid values for updatedLevelSignal.dimension):
${bulletList(objectives.dimensions)}

CURRENT STUDENT LEVEL:
${levelLines || "- (no dimensions yet)"}

TASK PRESENTED (id: ${task.id}, targets: ${task.targetDimensions.join(", ")}):
${task.prompt}

STUDENT RESPONSE:
${answer.trim() === "" ? "(the student submitted an empty response)" : answer}

Return the decision JSON now.`;
}

/**
 * Build a repair instruction appended after a failed attempt. It states WHAT was
 * wrong (schema errors or guardrail violations) without changing the task, so the
 * one bounded retry is a genuine correction rather than a fresh roll.
 */
export function buildRepairPrompt(reasons: readonly string[]): string {
  return `Your previous output was rejected for the following reason(s):
${bulletList(reasons)}

Re-emit a corrected decision. Output ONLY the JSON object, matching the contract exactly, obeying every hard rule (especially: never reveal the solution, keep "socraticFollowup" a question, stay on-scope, and set "mustNotRevealSolution": true).`;
}
