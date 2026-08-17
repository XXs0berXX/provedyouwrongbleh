# Adaptive AI Layer (LLM-driven adaptation)

Implementation of **Section 3 — Adaptive AI layer** of the adaptive-course spec
(`prompt.md`).

The adaptation engine is an LLM that, after each student response, decides how to
push the course forward. The LLM does the **judging**; this system forces its
**decisions** into a typed, validated, testable contract. It is never a
free‑floating "figure it out" prompt, and **raw model output never reaches the DB
or UI unvalidated**.

## Contract-based adaptation

After each student response the LLM is called with the module's learning
objectives, the current student‑level snapshot, the task, and the answer. It must
return a structured decision validated against a Zod schema
([`contract.ts`](src/services/adaptation/contract.ts)):

```jsonc
{
  "assessment":        { "correctness", "reasoningQuality", "misconceptions": [] },
  "updatedLevelSignal": { "dimension", "direction", "magnitude" },
  "nextAction":        "probe" | "advance" | "reinforce" | "reframe" | "stretch",
  "nextTaskDirective": { "difficulty", "focus", "mustNotRevealSolution": true },
  "socraticFollowup":  "string | null"
}
```

Malformed / off-schema output is **rejected**, followed by **one bounded retry**
with a repair prompt, then a **deterministic fallback**. The whole pipeline lives
in [`adaptationService.ts`](src/services/adaptation/adaptationService.ts):

```
build prompt (answer key withheld)
  → call LLM
  → parse JSON        ─ fail → repair retry → fallback
  → Zod validate      ─ fail → repair retry → fallback
  → run guardrails    ─ fail → regenerate   → fallback
  → apply updatedLevelSignal to the snapshot (pure domain logic)
  → { decision, snapshot, source, attempts }
```

## Guardrails (validated, not hoped-for)

A post-generation validation pass ([`guardrails.ts`](src/services/adaptation/guardrails.ts))
rejects any output that:

- **leaks a solution** — checked against the task's withheld answer key
  (keyword, verbatim, and paraphrase/token-overlap detection),
- **goes off-scope** — the moved dimension must be one the module tracks and the
  next-task focus must share vocabulary with the objectives,
- **isn't Socratic** — a wrong/weak answer must not be met with `advance`/`stretch`;
  a probe of a wrong answer must include a genuine question; `socraticFollowup`
  must be a question, never a statement of the answer.

Socratic behaviour is enforced by the prompt **and** checked by the validator — not
left to chance. On failure the engine regenerates or falls back.

## Split of responsibilities

| Path | Responsibility | Determinism |
|---|---|---|
| [`domain/studentLevel.ts`](src/domain/studentLevel.ts) | Student-level model + state transitions | **Pure & deterministic** — no LLM, no I/O, no clocks, no randomness |
| [`services/adaptation/`](src/services/adaptation) | LLM call + schema validation + guardrails + fallback | Deterministic wrapper around a non-deterministic model |
| `contract.ts` | The prompt + decision contract, **versioned** in one place (`CONTRACT_VERSION`) | — |

The `updatedLevelSignal` (dimension, direction, magnitude) is the **only** way the
LLM moves the student model; how it mutates the snapshot is decided solely by the
pure domain layer, so answer sequences are exhaustively unit-testable.

## Testing despite non-determinism

- **Deterministic wrapper** — schema validation, guardrail checks, fallback logic
  and level-state application are unit-tested with **mocked LLM responses**: good,
  malformed, off-schema, solution-leaking, off-scope and non-Socratic outputs are
  fed in and correct handling is asserted
  ([`adaptationService.test.ts`](src/services/adaptation/adaptationService.test.ts),
  [`guardrails.test.ts`](src/services/adaptation/guardrails.test.ts)).
- **Level-state model** — pure domain logic, deterministic tests over answer
  sequences ([`studentLevel.test.ts`](src/domain/studentLevel.test.ts)).
- **Eval suite** — a small set of `(student answer → expected decision-shape)`
  fixtures run against the **real model**, asserting properties (never leaks,
  stays on-scope, correct `nextAction` bucket for obvious cases). It is a
  regression guard, run **separately** from the unit tests and skipped without an
  API key ([`src/eval`](src/eval)).

## Commands

```bash
npm install
npm test        # unit tests only (mocked LLM) — fast & hermetic
npm run typecheck
npm run demo    # end-to-end session; mock LLM offline, real model if a key is set
npm run eval    # LLM eval suite against the real model (needs ANTHROPIC_API_KEY)
```

The real model is Claude via the Anthropic SDK
([`llm.ts`](src/services/adaptation/llm.ts), default `claude-opus-5`, adaptive
thinking). The `LlmClient` interface is the single boundary to the model, so all
non-eval tests inject a fake and run without network access.
