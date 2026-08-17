/**
 * services/adaptation/fallback — the deterministic decision used when the LLM
 * cannot produce a schema-valid, guardrail-clean output within the retry budget.
 *
 * It is intentionally conservative and Socratic-by-construction: it never moves
 * the student's level with confidence, never advances a possibly-wrong answer,
 * never reveals anything, and asks a generic reasoning-probe question. Because it
 * is built from the module/task inputs alone (no model), it is always valid and
 * always passes the guardrails.
 */

import type { AdaptationDecision, ModuleObjectives, Task } from "./contract.js";
import { AdaptationDecisionSchema } from "./contract.js";

/** Pick a safe, on-scope dimension to hold: prefer a task target, else the first tracked dimension. */
function chooseDimension(objectives: ModuleObjectives, task: Task): string {
  const target = task.targetDimensions.find((d) => objectives.dimensions.includes(d));
  if (target) return target;
  const first = objectives.dimensions[0];
  return first ?? "understanding";
}

/**
 * Build the deterministic fallback decision. The optional `answer` lets us tailor
 * the probe slightly (empty answer → invite an attempt) without ever assessing
 * correctness we can't verify offline.
 */
export function buildFallbackDecision(
  objectives: ModuleObjectives,
  task: Task,
  answer: string,
): AdaptationDecision {
  const dimension = chooseDimension(objectives, task);
  const answered = answer.trim().length > 0;

  const decision: AdaptationDecision = {
    assessment: {
      // We could not verify the answer, so we neither reward nor punish.
      correctness: "partially_correct",
      reasoningQuality: answered ? "adequate" : "absent",
      misconceptions: [],
    },
    updatedLevelSignal: {
      dimension,
      direction: "hold",
      magnitude: "small",
    },
    // Probe rather than advance — safe for a possibly-wrong answer.
    nextAction: "probe",
    nextTaskDirective: {
      difficulty: "same",
      focus: objectives.objectives[0] ?? `Reinforce ${dimension}.`,
      mustNotRevealSolution: true,
    },
    socraticFollowup: answered
      ? "Can you walk me through the reasoning behind each step of your answer?"
      : "What is the first thing you notice about this problem, and where would you start?",
  };

  // Parse to guarantee we only ever return a contract-valid object, even if the
  // module/task inputs are malformed in some way we didn't anticipate.
  return AdaptationDecisionSchema.parse(decision);
}
