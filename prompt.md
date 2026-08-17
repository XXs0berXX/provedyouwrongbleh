### 3. Adaptive AI layer (LLM-driven adaptation)

The adaptation engine is an LLM on the backend that monitors each student
response and decides how to push the course forward. The LLM does the
*judging*; the system forces its *decisions* into a typed, validated,
testable contract. It is never a free-floating "figure it out" prompt.

**Contract-based adaptation (core design):**
- After each student response, the LLM is called with: the module's learning
  objectives, the current student-level snapshot, the task, and the answer.
- The LLM must return a STRUCTURED decision object validated against a Zod
  schema, e.g.:
    {
      assessment: { correctness, reasoningQuality, misconceptions[] },
      updatedLevelSignal: { dimension, direction, magnitude },
      nextAction: "probe" | "advance" | "reinforce" | "reframe" | "stretch",
      nextTaskDirective: { difficulty, focus, mustNotRevealSolution: true },
      socraticFollowup: string | null
    }
- Malformed/off-schema output → reject, one bounded retry with a repair
  prompt, then deterministic fallback. Raw model output NEVER reaches the DB
  or UI unvalidated.

**Guardrails (validated, not hoped-for):**
- A post-generation validation pass rejects any output that leaks a solution,
  goes off-scope from the module objectives, or gives the answer instead of
  probing. On failure → regenerate or fallback.
- The LLM must be Socratic: probe reasoning when wrong, raise difficulty when
  strong. This behavior is enforced by the prompt AND checked by the
  validator, not left to chance.

**How this is testable despite non-determinism:**
- The deterministic wrapper around the LLM (schema validation, guardrail
  checks, fallback logic, level-state application) is fully unit-tested with
  MOCKED LLM responses — feed it good/malformed/solution-leaking/off-scope
  outputs and assert correct handling.
- The level-state model (how updatedLevelSignal mutates the student snapshot)
  is pure domain logic → deterministic unit tests on answer sequences.
- Add a small EVAL SUITE for the LLM itself: a set of fixture
  (student-answer → expected-decision-shape) cases run against the real model,
  asserting properties (never leaks solution, stays on-scope, correct
  nextAction category for obvious cases). This is a regression guard, run
  separately from unit tests.

Split responsibilities cleanly:
- domain/: student-level model + state transitions (pure, deterministic).
- services/adaptation: LLM call + schema validation + guardrails + fallback.
- The prompt/decision-contract lives in one place, versioned.