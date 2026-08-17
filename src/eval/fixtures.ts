/**
 * Eval fixtures: (student answer -> expected decision-shape properties).
 *
 * Each case pins the PROPERTIES we expect the real model to satisfy for an obvious
 * answer, not an exact string — the model is non-deterministic, so we assert
 * categories and invariants (never leaks, stays on-scope, right nextAction bucket).
 */

import type { ModuleObjectives, NextAction, Task } from "../services/adaptation/contract.js";
import { FRACTIONS_MODULE, ADD_FRACTIONS_TASK } from "../services/adaptation/testFixtures.js";

export interface EvalCase {
  name: string;
  objectives: ModuleObjectives;
  task: Task;
  answer: string;
  /** Expected correctness bucket (for logging / soft assertions). */
  expectedCorrectness: "correct" | "partially_correct" | "incorrect";
  /** The model must pick a nextAction from this set for the case to pass. */
  allowedNextActions: NextAction[];
  /** If true, a non-null socraticFollowup question is required (Socratic probing). */
  requireFollowupQuestion: boolean;
}

export const EVAL_CASES: EvalCase[] = [
  {
    name: "clearly correct, well-reasoned answer -> advance/stretch",
    objectives: FRACTIONS_MODULE,
    task: ADD_FRACTIONS_TASK,
    answer:
      "The denominators are 2 and 3, so the least common denominator is 6. 1/2 = 3/6 and 1/3 = 2/6. Adding: 3/6 + 2/6 = 5/6, which is already in lowest terms.",
    expectedCorrectness: "correct",
    allowedNextActions: ["advance", "stretch", "reinforce"],
    requireFollowupQuestion: false,
  },
  {
    name: "classic misconception (add num & denom) -> probe/reframe/reinforce, must probe",
    objectives: FRACTIONS_MODULE,
    task: ADD_FRACTIONS_TASK,
    answer: "1/2 + 1/3 = 2/5, because you add the tops and add the bottoms.",
    expectedCorrectness: "incorrect",
    allowedNextActions: ["probe", "reframe", "reinforce"],
    requireFollowupQuestion: true,
  },
  {
    name: "empty answer -> probe/reframe, must probe",
    objectives: FRACTIONS_MODULE,
    task: ADD_FRACTIONS_TASK,
    answer: "",
    expectedCorrectness: "incorrect",
    allowedNextActions: ["probe", "reframe", "reinforce"],
    requireFollowupQuestion: true,
  },
  {
    name: "partially right (correct method, arithmetic slip) -> not advance",
    objectives: FRACTIONS_MODULE,
    task: ADD_FRACTIONS_TASK,
    answer:
      "Common denominator is 6, so 1/2 = 3/6 and 1/3 = 2/6, and 3/6 + 2/6 = 4/6.",
    expectedCorrectness: "partially_correct",
    allowedNextActions: ["probe", "reframe", "reinforce"],
    requireFollowupQuestion: true,
  },
];
