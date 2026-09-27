/**
 * The run-budget ladder, in one place.
 *
 * Every tool loop is bounded by the same clock, and the parts of that clock are
 * coupled: a tool may not spend the time the model needs to speak, and the model
 * may not be granted a completion longer than the run can fund. Keeping the
 * constants here — rather than inside `tools.ts` — means the engine can read them
 * without importing the tool registry (which dereferences ~25 table bindings), so
 * a test that mocks the registry does not silently lose a budget constant and
 * turn a timing guarantee into `undefined`.
 *
 * The ladder must descend in this order, or a lower bound is simply ignored:
 *
 *   ANSWER delivery (20s) + answer production (45s)   ← reserved from every tool
 *     < scan call budget (70s, env)
 *     < tool ceiling (95s, env)
 *     < run budget (150s)
 *     < completion allowance (100s, env)  ← itself clamped to the run's remainder
 */
export const ANSWER_RESERVE_MS = 20_000;

/**
 * Time kept for the COMPLETION that turns a tool result into a reply.
 *
 * `ANSWER_RESERVE_MS` covers DELIVERING the answer (WhatsApp upload, session
 * write); this covers PRODUCING it. They are separate costs and both must be
 * held back from a tool, because the operator experiences their sum — a tool that
 * spends everything past delivery leaves no time for the model to speak, which is
 * precisely the «نفدت محاولات المعالجة» the scan used to cause: it ran to its own
 * ceiling, the completion then had no fundable budget, and the work was done for
 * nothing.
 */
export const MIN_ANSWER_BUDGET_MS = 45_000;
