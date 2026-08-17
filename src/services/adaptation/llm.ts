/**
 * services/adaptation/llm — the boundary between the deterministic wrapper and the
 * non-deterministic model. Everything the adaptation service needs from an LLM is
 * expressed by `LlmClient`, so unit tests inject a fake that returns
 * good / malformed / solution-leaking / off-scope strings, and the real Anthropic
 * client is only exercised by the separate eval suite.
 */

import Anthropic from "@anthropic-ai/sdk";

/** One turn to send to the model. `system` is sent once; `messages` is the thread. */
export interface LlmRequest {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * The minimal contract: given a request, return the model's raw text. The wrapper
 * is responsible for parsing/validating/guardrailing — the client just talks.
 */
export interface LlmClient {
  complete(request: LlmRequest): Promise<string>;
}

export interface AnthropicLlmClientOptions {
  /** Defaults to `claude-opus-5`. */
  model?: string;
  /** Defaults to 2048 — a decision object is small. */
  maxTokens?: number;
  /** Inject a preconstructed SDK client (tests / custom auth). */
  client?: Anthropic;
}

/**
 * Real implementation backed by the Anthropic Messages API. Adaptive thinking is
 * on (the model must reason about the answer), but we keep the output small and
 * ask for JSON only via the contract prompt.
 */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicLlmClientOptions = {}) {
    // Zero-arg client resolves credentials from the environment
    // (ANTHROPIC_API_KEY or an `ant auth login` profile).
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? "claude-opus-5";
    this.maxTokens = options.maxTokens ?? 2048;
  }

  async complete(request: LlmRequest): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      thinking: { type: "adaptive" },
      system: request.system,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category ?? "unknown";
      throw new LlmRefusalError(`Model refused (category: ${category}).`);
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!text) {
      throw new LlmEmptyResponseError("Model returned no text content.");
    }
    return text;
  }
}

export class LlmRefusalError extends Error {
  override readonly name = "LlmRefusalError";
}

export class LlmEmptyResponseError extends Error {
  override readonly name = "LlmEmptyResponseError";
}
