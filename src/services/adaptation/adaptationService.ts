/**
 * services/adaptation/adaptationService — the deterministic wrapper around the LLM.
 *
 * Flow for one student response:
 *   1. build the contract prompt (answer key withheld),
 *   2. call the LLM,
 *   3. parse JSON  -> on failure: one bounded repair retry, then fallback,
 *   4. Zod-validate -> on failure: one bounded repair retry, then fallback,
 *   5. run guardrails -> on failure: regenerate (repair), then fallback,
 *   6. apply updatedLevelSignal to the snapshot (pure domain logic),
 *   7. return { decision, snapshot, source, attempts, diagnostics }.
 *
 * Raw model output NEVER reaches the DB or UI: only a validated, guardrail-clean
 * `AdaptationDecision` (or the deterministic fallback) is ever returned.
 */

import {
  AdaptationDecisionSchema,
  SYSTEM_PROMPT,
  buildRepairPrompt,
  buildUserPrompt,
  type AdaptationDecision,
  type AdaptationInput,
} from "./contract.js";
import { buildFallbackDecision } from "./fallback.js";
import { runGuardrails, type GuardrailViolation } from "./guardrails.js";
import type { LlmClient, LlmRequest } from "./llm.js";
import {
  applyLevelSignal,
  type StudentLevelSnapshot,
} from "../../domain/studentLevel.js";

export type DecisionSource = "llm" | "fallback";

/** Why a given attempt failed — recorded for observability and tests. */
export type AttemptFailureKind =
  | "llm_error"
  | "not_json"
  | "schema_invalid"
  | "guardrail_violation";

export interface AttemptRecord {
  attempt: number;
  outcome: "accepted" | AttemptFailureKind;
  /** Human-readable reasons fed into the repair prompt (empty on success). */
  reasons: string[];
  /** Raw model text for this attempt, truncated for logging (undefined on llm_error). */
  rawPreview?: string;
}

export interface AdaptationResult {
  /** The validated, guardrail-clean decision (from the LLM or the fallback). */
  decision: AdaptationDecision;
  /** The new snapshot after applying updatedLevelSignal. */
  snapshot: StudentLevelSnapshot;
  /** Where the decision came from. */
  source: DecisionSource;
  /** One record per model attempt (0 if it went straight to fallback on... never). */
  attempts: AttemptRecord[];
  /** Guardrail violations on the finally-accepted LLM decision (always empty when accepted). */
  guardrailViolations: GuardrailViolation[];
}

export interface AdaptationServiceOptions {
  /**
   * Total number of LLM attempts (initial + repairs). Default 2 = one bounded
   * retry, matching the contract's "reject, one bounded retry, then fallback".
   * Guardrail failures reuse the same budget (regenerate == a repair attempt).
   */
  maxAttempts?: number;
  /** Length to truncate raw previews to in AttemptRecord. Default 500. */
  rawPreviewLength?: number;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_PREVIEW_LEN = 500;

/**
 * Extract a single JSON object from raw model text. Tolerates accidental code
 * fences or leading/trailing prose by locating the outermost balanced {...}.
 * Returns null if nothing parseable is found.
 */
export function extractJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim();

  // Fast path: the whole thing is JSON.
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to fence / brace scanning
  }

  // Strip a ```json ... ``` (or ``` ... ```) fence if present.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Scan for the first balanced top-level object, respecting strings/escapes.
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export class AdaptationService {
  private readonly llm: LlmClient;
  private readonly maxAttempts: number;
  private readonly previewLen: number;

  constructor(llm: LlmClient, options: AdaptationServiceOptions = {}) {
    this.llm = llm;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.previewLen = options.rawPreviewLength ?? DEFAULT_PREVIEW_LEN;
  }

  /**
   * Adapt after a single student response. Never throws for model/validation
   * problems — it degrades to the deterministic fallback and reports why.
   */
  async adapt(input: AdaptationInput): Promise<AdaptationResult> {
    const { objectives, snapshot, task, answer } = input;
    const attempts: AttemptRecord[] = [];

    // The running message thread; repair prompts are appended as extra user turns.
    const request: LlmRequest = {
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let raw: string;
      try {
        raw = await this.llm.complete(request);
      } catch (err) {
        attempts.push({
          attempt,
          outcome: "llm_error",
          reasons: [errorMessage(err)],
        });
        // A transport/refusal error can't be repaired by re-prompting the same
        // content usefully more than once; keep it in the retry budget then fall back.
        this.appendRepair(request, [
          "The previous call failed to produce any output. Return only the decision JSON.",
        ]);
        continue;
      }

      const preview = raw.slice(0, this.previewLen);

      // Step 3: parse JSON.
      const parsed = extractJsonObject(raw);
      if (parsed === null) {
        const reasons = ["Output was not valid JSON. Return ONLY a single JSON object, no prose or code fences."];
        attempts.push({ attempt, outcome: "not_json", reasons, rawPreview: preview });
        this.appendRepair(request, reasons);
        continue;
      }

      // Step 4: schema validation.
      const validation = AdaptationDecisionSchema.safeParse(parsed);
      if (!validation.success) {
        const reasons = validation.error.issues.map(
          (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
        );
        attempts.push({ attempt, outcome: "schema_invalid", reasons, rawPreview: preview });
        this.appendRepair(request, reasons);
        continue;
      }

      const decision = validation.data;

      // Step 5: guardrails.
      const guardrails = runGuardrails(decision, objectives, task);
      if (!guardrails.ok) {
        const reasons = guardrails.violations.map((v) => v.message);
        attempts.push({ attempt, outcome: "guardrail_violation", reasons, rawPreview: preview });
        this.appendRepair(request, reasons);
        continue;
      }

      // Accepted.
      attempts.push({ attempt, outcome: "accepted", reasons: [], rawPreview: preview });
      return {
        decision,
        snapshot: applyLevelSignal(snapshot, decision.updatedLevelSignal),
        source: "llm",
        attempts,
        guardrailViolations: [],
      };
    }

    // Step 3-5 exhausted -> deterministic fallback.
    const fallback = buildFallbackDecision(objectives, task, answer);
    return {
      decision: fallback,
      snapshot: applyLevelSignal(snapshot, fallback.updatedLevelSignal),
      source: "fallback",
      attempts,
      guardrailViolations: [],
    };
  }

  private appendRepair(request: LlmRequest, reasons: readonly string[]): void {
    // Record the (rejected) turn as assistant context is intentionally omitted:
    // we only carry forward the corrective instruction, keeping the thread short
    // and the repair unambiguous.
    request.messages.push({ role: "user", content: buildRepairPrompt(reasons) });
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
