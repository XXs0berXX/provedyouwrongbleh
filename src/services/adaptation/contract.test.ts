import { describe, it, expect } from "vitest";
import {
  AdaptationDecisionSchema,
  CONTRACT_VERSION,
  SYSTEM_PROMPT,
  buildRepairPrompt,
  buildUserPrompt,
  type AdaptationInput,
} from "./contract.js";
import {
  ADD_FRACTIONS_TASK,
  FRACTIONS_MODULE,
  GOOD_DECISION,
  OFF_SCHEMA_JSON,
  freshFractionsSnapshot,
} from "./testFixtures.js";

describe("AdaptationDecisionSchema", () => {
  it("accepts a well-formed decision", () => {
    expect(AdaptationDecisionSchema.safeParse(GOOD_DECISION).success).toBe(true);
  });

  it("rejects off-schema output", () => {
    expect(AdaptationDecisionSchema.safeParse(JSON.parse(OFF_SCHEMA_JSON)).success).toBe(false);
  });

  it("rejects unknown extra keys (strict)", () => {
    const withExtra = { ...GOOD_DECISION, hallucinated: 1 };
    expect(AdaptationDecisionSchema.safeParse(withExtra).success).toBe(false);
  });

  it("requires mustNotRevealSolution to be exactly true", () => {
    const bad = {
      ...GOOD_DECISION,
      nextTaskDirective: { ...GOOD_DECISION.nextTaskDirective, mustNotRevealSolution: false },
    };
    expect(AdaptationDecisionSchema.safeParse(bad).success).toBe(false);
  });

  it("allows socraticFollowup to be null", () => {
    expect(
      AdaptationDecisionSchema.safeParse({ ...GOOD_DECISION, socraticFollowup: null }).success,
    ).toBe(true);
  });
});

describe("prompt construction", () => {
  const input: AdaptationInput = {
    objectives: FRACTIONS_MODULE,
    snapshot: freshFractionsSnapshot(),
    task: ADD_FRACTIONS_TASK,
    answer: "1/2 + 1/3 = 2/5",
  };

  it("system prompt references the contract version", () => {
    expect(SYSTEM_PROMPT).toContain(CONTRACT_VERSION);
  });

  it("user prompt includes objectives, dimensions, task and answer", () => {
    const p = buildUserPrompt(input);
    expect(p).toContain(FRACTIONS_MODULE.objectives[0]!);
    expect(p).toContain("conceptualUnderstanding");
    expect(p).toContain(ADD_FRACTIONS_TASK.prompt);
    expect(p).toContain("1/2 + 1/3 = 2/5");
  });

  it("NEVER includes the answer key (solution) in the prompt", () => {
    const p = buildUserPrompt(input);
    expect(p).not.toContain(ADD_FRACTIONS_TASK.solution);
    for (const kw of ADD_FRACTIONS_TASK.solutionKeywords) {
      expect(p).not.toContain(kw);
    }
  });

  it("handles an empty answer explicitly", () => {
    const p = buildUserPrompt({ ...input, answer: "  " });
    expect(p).toContain("empty response");
  });

  it("repair prompt lists the reasons", () => {
    const p = buildRepairPrompt(["bad thing A", "bad thing B"]);
    expect(p).toContain("bad thing A");
    expect(p).toContain("bad thing B");
  });
});
