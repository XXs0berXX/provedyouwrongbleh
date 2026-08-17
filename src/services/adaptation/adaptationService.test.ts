import { describe, it, expect } from "vitest";
import {
  AdaptationService,
  extractJsonObject,
} from "./adaptationService.js";
import type { LlmClient, LlmRequest } from "./llm.js";
import type { AdaptationInput } from "./contract.js";
import {
  ADD_FRACTIONS_TASK,
  FENCED_DECISION_TEXT,
  FRACTIONS_MODULE,
  GOOD_DECISION_JSON,
  GOOD_WRONG_DECISION_JSON,
  MALFORMED_TEXT,
  NON_SOCRATIC_JSON,
  OFF_SCHEMA_JSON,
  OFF_SCOPE_JSON,
  SOLUTION_LEAK_JSON,
  freshFractionsSnapshot,
} from "./testFixtures.js";

/**
 * A scripted LLM: returns queued responses in order. Each element may be a string
 * (returned) or an Error (thrown). Records every request it received.
 */
class ScriptedLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private i = 0;
  constructor(private readonly script: Array<string | Error>) {}
  async complete(request: LlmRequest): Promise<string> {
    this.requests.push(structuredClone(request));
    const item = this.script[this.i++] ?? this.script[this.script.length - 1];
    if (item instanceof Error) throw item;
    return item as string;
  }
  get callCount(): number {
    return this.i;
  }
}

const input = (answer = "1/2 + 1/3 = 5/6"): AdaptationInput => ({
  objectives: FRACTIONS_MODULE,
  snapshot: freshFractionsSnapshot(),
  task: ADD_FRACTIONS_TASK,
  answer,
});

describe("extractJsonObject", () => {
  it("parses bare JSON", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it("extracts JSON from a code fence with surrounding prose", () => {
    expect(extractJsonObject(FENCED_DECISION_TEXT)).toMatchObject({ nextAction: "probe" });
  });
  it("extracts the first balanced object ignoring braces inside strings", () => {
    expect(extractJsonObject('noise {"s":"a}b","n":2} tail')).toEqual({ s: "a}b", n: 2 });
  });
  it("returns null when there is no JSON", () => {
    expect(extractJsonObject(MALFORMED_TEXT)).toBeNull();
  });
});

describe("AdaptationService — happy path", () => {
  it("accepts a good decision on the first attempt and applies the level signal", async () => {
    const llm = new ScriptedLlm([GOOD_DECISION_JSON]);
    const svc = new AdaptationService(llm);
    const result = await svc.adapt(input());

    expect(result.source).toBe("llm");
    expect(llm.callCount).toBe(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.outcome).toBe("accepted");
    // GOOD_DECISION moves proceduralFluency up/medium from 0.5 -> 0.6
    expect(result.snapshot.dimensions.proceduralFluency!.level).toBe(0.6);
    expect(result.snapshot.revision).toBe(1);
  });

  it("extracts a decision wrapped in prose + code fence", async () => {
    const llm = new ScriptedLlm([FENCED_DECISION_TEXT]);
    const result = await new AdaptationService(llm).adapt(input());
    expect(result.source).toBe("llm");
    expect(result.decision.nextAction).toBe("probe");
  });
});

describe("AdaptationService — retry then success", () => {
  it("repairs malformed JSON on the one bounded retry", async () => {
    const llm = new ScriptedLlm([MALFORMED_TEXT, GOOD_DECISION_JSON]);
    const result = await new AdaptationService(llm).adapt(input());

    expect(result.source).toBe("llm");
    expect(llm.callCount).toBe(2);
    expect(result.attempts.map((a) => a.outcome)).toEqual(["not_json", "accepted"]);
    // The 2nd request must carry a repair instruction as an extra user turn.
    expect(llm.requests[1]!.messages.length).toBe(2);
    expect(llm.requests[1]!.messages[1]!.content).toContain("rejected");
  });

  it("repairs off-schema JSON on retry", async () => {
    const llm = new ScriptedLlm([OFF_SCHEMA_JSON, GOOD_WRONG_DECISION_JSON]);
    const result = await new AdaptationService(llm).adapt(input("wrong"));
    expect(result.source).toBe("llm");
    expect(result.attempts.map((a) => a.outcome)).toEqual(["schema_invalid", "accepted"]);
  });

  it("repairs a solution leak on retry", async () => {
    const llm = new ScriptedLlm([SOLUTION_LEAK_JSON, GOOD_WRONG_DECISION_JSON]);
    const result = await new AdaptationService(llm).adapt(input("wrong"));
    expect(result.source).toBe("llm");
    expect(result.attempts[0]!.outcome).toBe("guardrail_violation");
    expect(result.attempts[0]!.reasons.join(" ")).toMatch(/solution/i);
    expect(result.attempts[1]!.outcome).toBe("accepted");
  });
});

describe("AdaptationService — falls back to the deterministic decision", () => {
  it("falls back when malformed output persists beyond the retry budget", async () => {
    const llm = new ScriptedLlm([MALFORMED_TEXT, MALFORMED_TEXT]);
    const result = await new AdaptationService(llm).adapt(input());

    expect(result.source).toBe("fallback");
    expect(llm.callCount).toBe(2);
    expect(result.decision.nextAction).toBe("probe");
    expect(result.decision.updatedLevelSignal.direction).toBe("hold");
    // Fallback still applied to the snapshot (hold -> level unchanged).
    expect(result.snapshot.dimensions.proceduralFluency!.level).toBe(0.5);
    expect(result.snapshot.revision).toBe(1);
  });

  it("falls back when the guardrail keeps failing (off-scope both times)", async () => {
    const llm = new ScriptedLlm([OFF_SCOPE_JSON, OFF_SCOPE_JSON]);
    const result = await new AdaptationService(llm).adapt(input("wrong"));
    expect(result.source).toBe("fallback");
    expect(result.attempts.every((a) => a.outcome === "guardrail_violation")).toBe(true);
  });

  it("falls back when a non-Socratic advance persists", async () => {
    const llm = new ScriptedLlm([NON_SOCRATIC_JSON, NON_SOCRATIC_JSON]);
    const result = await new AdaptationService(llm).adapt(input("wrong"));
    expect(result.source).toBe("fallback");
  });

  it("falls back (not throws) when the LLM keeps erroring", async () => {
    const llm = new ScriptedLlm([new Error("network down"), new Error("network down")]);
    const result = await new AdaptationService(llm).adapt(input());
    expect(result.source).toBe("fallback");
    expect(result.attempts[0]!.outcome).toBe("llm_error");
  });

  it("recovers when the LLM errors once then succeeds", async () => {
    const llm = new ScriptedLlm([new Error("transient"), GOOD_DECISION_JSON]);
    const result = await new AdaptationService(llm).adapt(input());
    expect(result.source).toBe("llm");
  });
});

describe("AdaptationService — configurable attempts", () => {
  it("honors a larger maxAttempts budget", async () => {
    const llm = new ScriptedLlm([MALFORMED_TEXT, OFF_SCHEMA_JSON, GOOD_DECISION_JSON]);
    const result = await new AdaptationService(llm, { maxAttempts: 3 }).adapt(input());
    expect(result.source).toBe("llm");
    expect(llm.callCount).toBe(3);
  });

  it("never returns raw model output — always a validated decision object", async () => {
    const llm = new ScriptedLlm([SOLUTION_LEAK_JSON, SOLUTION_LEAK_JSON]);
    const result = await new AdaptationService(llm).adapt(input("wrong"));
    // Whatever happened, the returned decision is schema+guardrail clean.
    expect(result.source).toBe("fallback");
    const text = `${result.decision.nextTaskDirective.focus} ${result.decision.socraticFollowup ?? ""}`;
    expect(text).not.toContain("5/6");
  });
});
