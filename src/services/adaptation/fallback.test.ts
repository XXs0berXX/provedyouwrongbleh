import { describe, it, expect } from "vitest";
import { buildFallbackDecision } from "./fallback.js";
import { runGuardrails } from "./guardrails.js";
import { AdaptationDecisionSchema } from "./contract.js";
import { ADD_FRACTIONS_TASK, FRACTIONS_MODULE } from "./testFixtures.js";

describe("buildFallbackDecision", () => {
  it("is always schema-valid and guardrail-clean (answered)", () => {
    const d = buildFallbackDecision(FRACTIONS_MODULE, ADD_FRACTIONS_TASK, "1/2 + 1/3 = 2/5");
    expect(AdaptationDecisionSchema.safeParse(d).success).toBe(true);
    expect(runGuardrails(d, FRACTIONS_MODULE, ADD_FRACTIONS_TASK).ok).toBe(true);
  });

  it("is always schema-valid and guardrail-clean (empty answer)", () => {
    const d = buildFallbackDecision(FRACTIONS_MODULE, ADD_FRACTIONS_TASK, "   ");
    expect(AdaptationDecisionSchema.safeParse(d).success).toBe(true);
    expect(runGuardrails(d, FRACTIONS_MODULE, ADD_FRACTIONS_TASK).ok).toBe(true);
    expect(d.assessment.reasoningQuality).toBe("absent");
  });

  it("holds the level (never moves it) and probes rather than advances", () => {
    const d = buildFallbackDecision(FRACTIONS_MODULE, ADD_FRACTIONS_TASK, "something");
    expect(d.updatedLevelSignal.direction).toBe("hold");
    expect(d.nextAction).toBe("probe");
    expect(FRACTIONS_MODULE.dimensions).toContain(d.updatedLevelSignal.dimension);
  });

  it("does not leak the solution in any student-facing field", () => {
    const d = buildFallbackDecision(FRACTIONS_MODULE, ADD_FRACTIONS_TASK, "x");
    const text = `${d.nextTaskDirective.focus} ${d.socraticFollowup ?? ""}`;
    expect(text).not.toContain("5/6");
  });
});
