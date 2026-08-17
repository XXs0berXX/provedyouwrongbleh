/**
 * Shared, deterministic fixtures for adaptation tests (unit + eval). Kept in src
 * (not a test file) so both the mocked unit tests and the real-model eval suite
 * import the exact same module/task definitions.
 */

import type { AdaptationDecision, ModuleObjectives, Task } from "./contract.js";
import { createSnapshot, type StudentLevelSnapshot } from "../../domain/studentLevel.js";

export const FRACTIONS_MODULE: ModuleObjectives = {
  moduleId: "math.fractions.addition",
  title: "Adding fractions with unlike denominators",
  objectives: [
    "Find a common denominator for two fractions",
    "Rewrite each fraction over the common denominator",
    "Add the numerators and simplify the result",
  ],
  dimensions: [
    "conceptualUnderstanding",
    "proceduralFluency",
    "problemSolving",
  ],
};

export const ADD_FRACTIONS_TASK: Task = {
  id: "task.add.1-2-plus-1-3",
  prompt: "Compute 1/2 + 1/3. Show your working.",
  targetDimensions: ["proceduralFluency", "conceptualUnderstanding"],
  solution:
    "The common denominator is 6, so 1/2 = 3/6 and 1/3 = 2/6, and 3/6 + 2/6 = 5/6.",
  solutionKeywords: ["5/6", "3/6", "2/6", "common denominator is 6"],
};

export function freshFractionsSnapshot(): StudentLevelSnapshot {
  return createSnapshot(FRACTIONS_MODULE.moduleId, FRACTIONS_MODULE.dimensions);
}

// ---------------------------------------------------------------------------
// Canned decision objects for unit tests
// ---------------------------------------------------------------------------

/** A well-formed, guardrail-clean decision (strong correct answer -> advance). */
export const GOOD_DECISION: AdaptationDecision = {
  assessment: {
    correctness: "correct",
    reasoningQuality: "strong",
    misconceptions: [],
  },
  updatedLevelSignal: {
    dimension: "proceduralFluency",
    direction: "up",
    magnitude: "medium",
  },
  nextAction: "advance",
  nextTaskDirective: {
    difficulty: "harder",
    focus: "Adding three fractions with unlike denominators",
    mustNotRevealSolution: true,
  },
  socraticFollowup: null,
};

/** A well-formed, guardrail-clean decision for a wrong answer (probe). */
export const GOOD_WRONG_DECISION: AdaptationDecision = {
  assessment: {
    correctness: "incorrect",
    reasoningQuality: "weak",
    misconceptions: ["Added numerators and denominators directly"],
  },
  updatedLevelSignal: {
    dimension: "conceptualUnderstanding",
    direction: "down",
    magnitude: "small",
  },
  nextAction: "probe",
  nextTaskDirective: {
    difficulty: "same",
    focus: "Why fractions need a common denominator before adding",
    mustNotRevealSolution: true,
  },
  socraticFollowup:
    "Before adding, what has to be true about the two denominators, and is that true here?",
};

export const GOOD_DECISION_JSON = JSON.stringify(GOOD_DECISION);
export const GOOD_WRONG_DECISION_JSON = JSON.stringify(GOOD_WRONG_DECISION);

/** Same as GOOD_DECISION but wrapped in prose + a code fence, to test extraction. */
export const FENCED_DECISION_TEXT = `Sure — here is my decision:

\`\`\`json
${GOOD_WRONG_DECISION_JSON}
\`\`\`

Let me know if you need anything else.`;

/** Not JSON at all. */
export const MALFORMED_TEXT = "I think the student did okay. Let's move on.";

/** Valid JSON, wrong shape (missing required fields, extra key). */
export const OFF_SCHEMA_JSON = JSON.stringify({
  assessment: { correctness: "great", misconceptions: "none" },
  nextAction: "teleport",
  extra: true,
});

/** Schema-valid but leaks the solution in socraticFollowup. */
export const SOLUTION_LEAK_DECISION: AdaptationDecision = {
  ...GOOD_WRONG_DECISION,
  socraticFollowup:
    "Remember the common denominator is 6, so the answer is 5/6 — can you see why?",
};
export const SOLUTION_LEAK_JSON = JSON.stringify(SOLUTION_LEAK_DECISION);

/** Schema-valid but moves an untracked dimension (off-scope). */
export const OFF_SCOPE_DECISION: AdaptationDecision = {
  ...GOOD_WRONG_DECISION,
  updatedLevelSignal: {
    dimension: "handwriting",
    direction: "down",
    magnitude: "small",
  },
};
export const OFF_SCOPE_JSON = JSON.stringify(OFF_SCOPE_DECISION);

/** Schema-valid but advances a wrong answer (non-Socratic). */
export const NON_SOCRATIC_DECISION: AdaptationDecision = {
  ...GOOD_WRONG_DECISION,
  nextAction: "advance",
  socraticFollowup: null,
};
export const NON_SOCRATIC_JSON = JSON.stringify(NON_SOCRATIC_DECISION);
