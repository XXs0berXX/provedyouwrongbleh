import { describe, it, expect } from "vitest";
import { runGuardrails } from "./guardrails.js";
import type { AdaptationDecision } from "./contract.js";
import {
  ADD_FRACTIONS_TASK,
  FRACTIONS_MODULE,
  GOOD_DECISION,
  GOOD_WRONG_DECISION,
  NON_SOCRATIC_DECISION,
  OFF_SCOPE_DECISION,
  SOLUTION_LEAK_DECISION,
} from "./testFixtures.js";

const run = (d: AdaptationDecision) =>
  runGuardrails(d, FRACTIONS_MODULE, ADD_FRACTIONS_TASK);

describe("runGuardrails — clean decisions pass", () => {
  it("accepts a strong correct-answer advance", () => {
    expect(run(GOOD_DECISION)).toEqual({ ok: true, violations: [] });
  });

  it("accepts a Socratic probe of a wrong answer", () => {
    expect(run(GOOD_WRONG_DECISION)).toEqual({ ok: true, violations: [] });
  });
});

describe("runGuardrails — solution leaks", () => {
  it("rejects a followup that states the answer keyword (5/6)", () => {
    const res = run(SOLUTION_LEAK_DECISION);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.code === "solution_leaked")).toBe(true);
  });

  it("rejects the whole solution verbatim in focus", () => {
    const d: AdaptationDecision = {
      ...GOOD_WRONG_DECISION,
      nextTaskDirective: {
        ...GOOD_WRONG_DECISION.nextTaskDirective,
        focus: ADD_FRACTIONS_TASK.solution,
      },
    };
    const res = run(d);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.code === "solution_leaked")).toBe(true);
  });

  it("rejects a close paraphrase of the solution", () => {
    const d: AdaptationDecision = {
      ...GOOD_WRONG_DECISION,
      socraticFollowup:
        "common denominator 6 so one half becomes 3/6 and one third becomes 2/6 giving 5/6, right?",
    };
    const res = run(d);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.code === "solution_leaked")).toBe(true);
  });

  it("does not false-positive on legitimate on-topic vocabulary", () => {
    const d: AdaptationDecision = {
      ...GOOD_WRONG_DECISION,
      socraticFollowup:
        "What do the two denominators have in common, and what would you need to change first?",
    };
    expect(run(d).ok).toBe(true);
  });
});

describe("runGuardrails — Socratic behaviour", () => {
  it("rejects a followup that is not a question", () => {
    const d: AdaptationDecision = {
      ...GOOD_WRONG_DECISION,
      socraticFollowup: "You should think about the denominators.",
    };
    const res = run(d);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.code === "non_socratic_followup")).toBe(true);
  });

  it("rejects a declarative 'the answer is' followup", () => {
    const d: AdaptationDecision = {
      ...GOOD_WRONG_DECISION,
      socraticFollowup: "The answer is what you get after finding the denominator?",
    };
    const res = run(d);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.code === "followup_reveals_answer")).toBe(true);
  });

  it("rejects advancing an incorrect answer", () => {
    const res = run(NON_SOCRATIC_DECISION);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.code === "non_socratic_advance")).toBe(true);
  });

  it("rejects a probe with no followup question on a wrong answer", () => {
    const d: AdaptationDecision = {
      ...GOOD_WRONG_DECISION,
      nextAction: "probe",
      socraticFollowup: null,
    };
    const res = run(d);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.code === "non_socratic_followup")).toBe(true);
  });
});

describe("runGuardrails — scope", () => {
  it("rejects moving an untracked dimension", () => {
    const res = run(OFF_SCOPE_DECISION);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.code === "off_scope_dimension")).toBe(true);
  });

  it("rejects a focus unrelated to the module", () => {
    const d: AdaptationDecision = {
      ...GOOD_WRONG_DECISION,
      nextTaskDirective: {
        ...GOOD_WRONG_DECISION.nextTaskDirective,
        focus: "Photosynthesis in tropical plants",
      },
    };
    const res = run(d);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.code === "off_scope_focus")).toBe(true);
  });
});

describe("runGuardrails — mustNotRevealSolution flag", () => {
  it("rejects a decision whose flag is not true", () => {
    // Construct a decision that bypasses the schema literal (simulating a
    // non-schema code path such as a hand-built fallback).
    const d = {
      ...GOOD_WRONG_DECISION,
      nextTaskDirective: {
        ...GOOD_WRONG_DECISION.nextTaskDirective,
        mustNotRevealSolution: false,
      },
    } as unknown as AdaptationDecision;
    const res = run(d);
    expect(res.ok).toBe(false);
    expect(res.violations.some((v) => v.code === "must_not_reveal_flag_false")).toBe(true);
  });
});

describe("runGuardrails — reports all violations at once", () => {
  it("collects multiple independent violations", () => {
    const d: AdaptationDecision = {
      ...GOOD_WRONG_DECISION,
      nextAction: "stretch", // non-socratic advance
      updatedLevelSignal: { dimension: "handwriting", direction: "up", magnitude: "small" }, // off-scope
      socraticFollowup: "The answer is 5/6.", // leak + declarative + not really probing
    };
    const res = run(d);
    expect(res.ok).toBe(false);
    const codes = new Set(res.violations.map((v) => v.code));
    expect(codes.has("off_scope_dimension")).toBe(true);
    expect(codes.has("non_socratic_advance")).toBe(true);
    expect(codes.has("solution_leaked")).toBe(true);
  });
});
