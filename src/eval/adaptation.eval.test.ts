/**
 * LLM eval suite — a REGRESSION GUARD run against the real model, separate from
 * the unit tests. It is skipped unless ANTHROPIC_API_KEY is set, so `npm test`
 * (unit) stays fast and hermetic while `npm run eval` exercises the model.
 *
 * These tests assert PROPERTIES of the model's decisions, not exact text:
 *   - never leaks the solution (guaranteed by guardrails, asserted explicitly),
 *   - stays on-scope (dimension is tracked; focus is on-topic),
 *   - picks a sensible nextAction bucket for obvious answers,
 *   - probes wrong answers with a genuine question.
 *
 * A case that forces the deterministic fallback fails: for these obvious inputs
 * the model is expected to comply with the contract on its own.
 */

import { describe, it, expect } from "vitest";
import { AdaptationService } from "../services/adaptation/adaptationService.js";
import { AnthropicLlmClient } from "../services/adaptation/llm.js";
import { runGuardrails } from "../services/adaptation/guardrails.js";
import { createSnapshot } from "../domain/studentLevel.js";
import { EVAL_CASES } from "./fixtures.js";

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const MODEL = process.env.ADAPTATION_EVAL_MODEL ?? "claude-opus-5";
const EVAL_TIMEOUT_MS = 120_000;

describe.skipIf(!HAS_KEY)("adaptation LLM eval (real model)", () => {
  const service = new AdaptationService(new AnthropicLlmClient({ model: MODEL }), {
    // Give the model a genuine repair chance before we count a fallback.
    maxAttempts: 2,
  });

  for (const c of EVAL_CASES) {
    it(
      c.name,
      async () => {
        const snapshot = createSnapshot(c.objectives.moduleId, c.objectives.dimensions);
        const result = await service.adapt({
          objectives: c.objectives,
          snapshot,
          task: c.task,
          answer: c.answer,
        });

        // The model should satisfy the contract itself on obvious cases.
        expect(result.source, `unexpected fallback; attempts=${JSON.stringify(result.attempts)}`).toBe("llm");

        // Invariant 1: schema+guardrail clean (defense in depth).
        expect(runGuardrails(result.decision, c.objectives, c.task).ok).toBe(true);

        // Invariant 2: no solution leak in any student-facing field.
        const studentFacing = `${result.decision.nextTaskDirective.focus} ${result.decision.socraticFollowup ?? ""}`;
        for (const kw of c.task.solutionKeywords) {
          expect(studentFacing).not.toContain(kw);
        }

        // Invariant 3: on-scope dimension.
        expect(c.objectives.dimensions).toContain(result.decision.updatedLevelSignal.dimension);

        // Property: sensible nextAction bucket.
        expect(c.allowedNextActions).toContain(result.decision.nextAction);

        // Property: wrong answers are probed with a real question.
        if (c.requireFollowupQuestion) {
          expect(result.decision.socraticFollowup).not.toBeNull();
          expect(result.decision.socraticFollowup ?? "").toContain("?");
        }
      },
      EVAL_TIMEOUT_MS,
    );
  }
});

describe.skipIf(HAS_KEY)("adaptation LLM eval (skipped)", () => {
  it("is skipped without ANTHROPIC_API_KEY — run `npm run eval` with a key set", () => {
    expect(HAS_KEY).toBe(false);
  });
});
