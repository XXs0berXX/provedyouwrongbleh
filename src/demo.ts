/**
 * Demo: run a short adaptive session end-to-end.
 *
 *   npm run demo          -> uses a scripted mock LLM (no API key needed)
 *   ANTHROPIC_API_KEY=... npm run demo   -> uses the real Claude model
 *
 * It feeds a sequence of student answers through the AdaptationService and prints,
 * for each, the validated decision and how the student's level moved.
 */

import { AdaptationService } from "./services/adaptation/adaptationService.js";
import { AnthropicLlmClient, type LlmClient, type LlmRequest } from "./services/adaptation/llm.js";
import {
  ADD_FRACTIONS_TASK,
  FRACTIONS_MODULE,
  GOOD_DECISION_JSON,
  GOOD_WRONG_DECISION_JSON,
} from "./services/adaptation/testFixtures.js";
import { createSnapshot, summarizeSnapshot } from "./domain/studentLevel.js";
import type { StudentLevelSnapshot } from "./domain/studentLevel.js";

/** A tiny mock so the demo runs offline. Returns wrong-answer then correct-answer decisions. */
class DemoMockLlm implements LlmClient {
  private i = 0;
  private readonly script = [GOOD_WRONG_DECISION_JSON, GOOD_WRONG_DECISION_JSON, GOOD_DECISION_JSON];
  async complete(_request: LlmRequest): Promise<string> {
    const item = this.script[Math.min(this.i, this.script.length - 1)]!;
    this.i += 1;
    return item;
  }
}

const answers = [
  "1/2 + 1/3 = 2/5",
  "still not sure, maybe 2/5?",
  "The LCD is 6, so 3/6 + 2/6 = 5/6.",
];

async function main(): Promise<void> {
  const useReal = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const llm: LlmClient = useReal ? new AnthropicLlmClient() : new DemoMockLlm();
  const service = new AdaptationService(llm);

  console.log(`Adaptive session — ${useReal ? "REAL model" : "mock LLM"}`);
  console.log(`Module: ${FRACTIONS_MODULE.title}\n`);

  let snapshot: StudentLevelSnapshot = createSnapshot(
    FRACTIONS_MODULE.moduleId,
    FRACTIONS_MODULE.dimensions,
  );

  for (const [idx, answer] of answers.entries()) {
    const result = await service.adapt({
      objectives: FRACTIONS_MODULE,
      snapshot,
      task: ADD_FRACTIONS_TASK,
      answer,
    });
    snapshot = result.snapshot;

    const d = result.decision;
    console.log(`--- Response ${idx + 1} (${result.source}) ---`);
    console.log(`  student: ${answer || "(empty)"}`);
    console.log(`  assessment: ${d.assessment.correctness} / ${d.assessment.reasoningQuality}`);
    console.log(`  signal: ${d.updatedLevelSignal.dimension} ${d.updatedLevelSignal.direction} (${d.updatedLevelSignal.magnitude})`);
    console.log(`  nextAction: ${d.nextAction} | difficulty: ${d.nextTaskDirective.difficulty}`);
    if (d.socraticFollowup) console.log(`  probe: ${d.socraticFollowup}`);
    console.log(`  attempts: ${result.attempts.map((a) => a.outcome).join(" -> ")}`);
    console.log();
  }

  console.log("Final student level:");
  for (const dim of summarizeSnapshot(snapshot).dimensions) {
    console.log(`  ${dim.dimension}: ${dim.level} (${dim.band}), confidence ${dim.confidence}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
