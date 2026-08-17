/**
 * services/adaptation/guardrails — deterministic, post-generation validation of a
 * schema-valid decision. Schema validation proves the SHAPE is right; guardrails
 * prove the CONTENT is safe:
 *
 *   - no solution leak (the model must probe, never hand over the answer),
 *   - on-scope (dimension + focus must serve the module),
 *   - Socratic (don't advance a wrong answer; probe wrong answers with a question).
 *
 * Pure functions only — same inputs, same verdict — so every rule is unit-testable
 * against good / leaking / off-scope / non-Socratic decisions with a mocked model.
 */

import type { AdaptationDecision } from "./contract.js";
import type { ModuleObjectives, Task } from "./contract.js";

export type GuardrailCode =
  | "solution_leaked"
  | "must_not_reveal_flag_false"
  | "off_scope_dimension"
  | "off_scope_focus"
  | "non_socratic_advance"
  | "non_socratic_followup"
  | "followup_reveals_answer";

export interface GuardrailViolation {
  code: GuardrailCode;
  message: string;
}

export interface GuardrailResult {
  ok: boolean;
  violations: GuardrailViolation[];
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "is",
  "are", "be", "with", "as", "at", "by", "it", "this", "that", "you", "your",
  "how", "what", "why", "when", "which", "can", "do", "does", "so", "if",
]);

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/** True if `haystack` contains `needle` as a normalized whole-phrase substring. */
function containsPhrase(haystack: string, needle: string): boolean {
  const h = normalize(haystack);
  const n = normalize(needle);
  if (n.length < 3) return false;
  if (h.includes(n)) return true;
  // Also catch the phrase with padded word boundaries to avoid accidental
  // substring hits inside larger words.
  return ` ${h} `.includes(` ${n} `);
}

/** Fraction of `needle`'s significant tokens that appear in `haystack`. */
function tokenOverlap(haystack: string, needle: string): number {
  const need = tokenSet(needle);
  if (need.size === 0) return 0;
  const hay = tokenSet(haystack);
  let hits = 0;
  for (const t of need) if (hay.has(t)) hits += 1;
  return hits / need.size;
}

// ---------------------------------------------------------------------------
// Individual rules
// ---------------------------------------------------------------------------

/**
 * Solution leak: the concatenation of the two free-text, student-facing fields
 * (`focus`, `socraticFollowup`) must not reproduce the solution. We check three
 * ways: an explicit solution-keyword hit, a whole-solution-phrase hit, and a high
 * token-overlap with the full solution text.
 */
function checkSolutionLeak(
  decision: AdaptationDecision,
  task: Task,
): GuardrailViolation[] {
  const studentFacing = [decision.nextTaskDirective.focus, decision.socraticFollowup ?? ""]
    .join("\n");

  const violations: GuardrailViolation[] = [];

  for (const keyword of task.solutionKeywords) {
    if (containsPhrase(studentFacing, keyword)) {
      violations.push({
        code: "solution_leaked",
        message: `Student-facing text contains solution keyword "${keyword}".`,
      });
    }
  }

  if (task.solution.trim() && containsPhrase(studentFacing, task.solution)) {
    violations.push({
      code: "solution_leaked",
      message: "Student-facing text reproduces the task solution verbatim.",
    });
  }

  // High overlap with the whole solution is a paraphrased leak. Require a
  // non-trivial solution so a one-word answer key doesn't over-trigger.
  if (tokenSet(task.solution).size >= 4 && tokenOverlap(studentFacing, task.solution) >= 0.8) {
    violations.push({
      code: "solution_leaked",
      message: "Student-facing text closely paraphrases the task solution.",
    });
  }

  return dedupe(violations);
}

/**
 * The socraticFollowup, when present, must be a genuine probing QUESTION, not a
 * declarative statement of the answer. We require it to look like a question and
 * to not directly assert the answer.
 */
function checkFollowupIsQuestion(
  decision: AdaptationDecision,
): GuardrailViolation[] {
  const followup = decision.socraticFollowup;
  if (followup === null) return [];
  const trimmed = followup.trim();

  // Must contain a question mark somewhere — a Socratic probe is a question.
  if (!trimmed.includes("?")) {
    return [
      {
        code: "non_socratic_followup",
        message: "socraticFollowup is present but is not phrased as a question.",
      },
    ];
  }

  // Declarative answer-giving openers masquerading as a followup.
  const declarativeLeadIns = [
    "the answer is",
    "the solution is",
    "the correct answer is",
    "it is because",
    "here is the answer",
    "the result is",
  ];
  const lower = normalize(trimmed);
  for (const lead of declarativeLeadIns) {
    if (lower.startsWith(lead) || lower.includes(lead)) {
      return [
        {
          code: "followup_reveals_answer",
          message: `socraticFollowup states the answer directly ("${lead}...").`,
        },
      ];
    }
  }
  return [];
}

/**
 * On-scope: the moved dimension must be one the module tracks, and the next-task
 * focus must relate to the module's objectives/dimensions (some token overlap).
 */
function checkOnScope(
  decision: AdaptationDecision,
  objectives: ModuleObjectives,
): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];

  if (!objectives.dimensions.includes(decision.updatedLevelSignal.dimension)) {
    violations.push({
      code: "off_scope_dimension",
      message: `updatedLevelSignal.dimension "${decision.updatedLevelSignal.dimension}" is not a tracked dimension of module ${objectives.moduleId}.`,
    });
  }

  // Focus must share vocabulary with the objectives or the tracked dimensions.
  const scopeText = [...objectives.objectives, ...objectives.dimensions, objectives.title].join(" ");
  const overlap = tokenOverlap(scopeText, decision.nextTaskDirective.focus);
  if (overlap === 0) {
    violations.push({
      code: "off_scope_focus",
      message: "nextTaskDirective.focus shares no vocabulary with the module objectives.",
    });
  }

  return violations;
}

/**
 * Socratic behaviour on the action itself:
 *   - a wrong / weak answer must not be met with "advance" or "stretch",
 *   - a wrong answer with an absent/weak reasoning should get a probing question
 *     (a followup), not silence — otherwise it isn't Socratic.
 */
function checkSocraticAction(
  decision: AdaptationDecision,
): GuardrailViolation[] {
  const { correctness, reasoningQuality } = decision.assessment;
  const violations: GuardrailViolation[] = [];

  const isWrong = correctness === "incorrect" || correctness === "partially_correct";
  const weakReasoning = reasoningQuality === "weak" || reasoningQuality === "absent";

  if ((correctness === "incorrect" || weakReasoning) &&
      (decision.nextAction === "advance" || decision.nextAction === "stretch")) {
    violations.push({
      code: "non_socratic_advance",
      message: `nextAction "${decision.nextAction}" advances the student despite correctness="${correctness}", reasoningQuality="${reasoningQuality}".`,
    });
  }

  // A wrong answer that is being probed/reframed must actually ask something.
  if (isWrong &&
      (decision.nextAction === "probe" || decision.nextAction === "reframe") &&
      decision.socraticFollowup === null) {
    violations.push({
      code: "non_socratic_followup",
      message: `nextAction "${decision.nextAction}" on a non-correct answer must include a socraticFollowup question.`,
    });
  }

  return violations;
}

function dedupe(violations: GuardrailViolation[]): GuardrailViolation[] {
  const seen = new Set<string>();
  const out: GuardrailViolation[] = [];
  for (const v of violations) {
    const key = `${v.code}::${v.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the full guardrail pass on a schema-valid decision. Returns every violation
 * found (not just the first) so a repair prompt can address them all at once.
 */
export function runGuardrails(
  decision: AdaptationDecision,
  objectives: ModuleObjectives,
  task: Task,
): GuardrailResult {
  const violations: GuardrailViolation[] = [];

  // Belt-and-suspenders: the schema already forces this literal, but a decision
  // may reach here from a non-schema path (e.g. a hand-built fallback under test).
  if (decision.nextTaskDirective.mustNotRevealSolution !== true) {
    violations.push({
      code: "must_not_reveal_flag_false",
      message: "nextTaskDirective.mustNotRevealSolution must be true.",
    });
  }

  violations.push(...checkSolutionLeak(decision, task));
  violations.push(...checkFollowupIsQuestion(decision));
  violations.push(...checkOnScope(decision, objectives));
  violations.push(...checkSocraticAction(decision));

  const deduped = dedupe(violations);
  return { ok: deduped.length === 0, violations: deduped };
}
