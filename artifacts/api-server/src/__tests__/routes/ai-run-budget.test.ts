import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  effectiveToolTimeoutMs,
  toolTimeoutMs,
  ANSWER_RESERVE_MS,
} from "../../modules/ai-assistant/tools";
import { MIN_ANSWER_BUDGET_MS } from "../../modules/ai-assistant/budgets";
import { completionBudgetFor, completionBudgetMs } from "../../modules/ai-assistant/llm";
import { exhaustedAnswer } from "../../modules/ai-assistant/agent";

/**
 * The live failure these guard: a mail census over EDC orders returned
 * «نفدت محاولات المعالجة قبل الوصول لرد نهائي، لكن تم تنفيذ خطوات فعلية:
 * run_readonly_query, search_database» — two claims in one sentence, both false.
 * The database tools were not even in the routed catalogue (scope was email), so
 * the run reported tools it never had, and the reason it had no answer was a
 * tool ceiling that outlived the whole run.
 */
describe("tool ceiling vs the run budget", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.AI_TOOL_TIMEOUT_MS;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("clamps a long tool to what is left of the run", () => {
    const now = 1_000_000;
    // 150s run, 160s tool ceiling, tool starts immediately: the ceiling must come
    // down to the run's remainder minus BOTH the answer's delivery and its
    // production, or the tool eats the time the model needs to speak.
    const ms = effectiveToolTimeoutMs({ deadline: now + 150_000 }, now);
    expect(ms).toBe(150_000 - ANSWER_RESERVE_MS - MIN_ANSWER_BUDGET_MS);
    expect(ms).toBeLessThan(toolTimeoutMs());
  });

  it("holds back the time the ANSWER needs, not just its delivery", () => {
    // The recorded live defect: the scan took ~85s of a 150s run. The old reserve
    // held back only 20s, so the tool was allowed 130s and took ~85s — after which
    // the completion could not be funded at all and the run ended with «نفدت
    // محاولات المعالجة» despite having read the mail.
    const now = 1_000_000;
    const ms = effectiveToolTimeoutMs({ deadline: now + 150_000 }, now);
    // What the tool may spend must leave a fundable completion behind it.
    expect(ms).toBeLessThanOrEqual(150_000 - ANSWER_RESERVE_MS - MIN_ANSWER_BUDGET_MS);
    expect(150_000 - ms).toBeGreaterThanOrEqual(MIN_ANSWER_BUDGET_MS + ANSWER_RESERVE_MS);
  });

  it("never lets the tool outlive the deadline (the live defect)", () => {
    const now = 1_000_000;
    // Deployed settings: 160s tool ceiling inside a 150s run. Before the fix the
    // tool ran 160s, the run aborted at 150s, and its result was discarded.
    const ms = effectiveToolTimeoutMs({ deadline: now + 150_000 }, now);
    expect(now + ms).toBeLessThanOrEqual(now + 150_000);
  });

  it("keeps the configured ceiling when there is plenty of budget", () => {
    const now = 1_000_000;
    expect(effectiveToolTimeoutMs({ deadline: now + 10 * 60_000 }, now)).toBe(toolTimeoutMs());
  });

  it("floors the ceiling so a nearly-spent run still reports a timeout", () => {
    const now = 1_000_000;
    const ms = effectiveToolTimeoutMs({ deadline: now + 2_000 }, now);
    expect(ms).toBe(1_000);
  });

  it("behaves exactly as before when no deadline is provided", () => {
    expect(effectiveToolTimeoutMs({}, Date.now())).toBe(toolTimeoutMs());
  });
});

describe("a completion may only ask for what the run can fund", () => {
  it("caps the per-completion allowance by the run's remainder", () => {
    // The live error was «LLM request budget of 100000ms exhausted before an
    // answer» thrown by a run that had only ~65s left: the completion asked for
    // its full allowance, could not be honoured, and threw — on every attempt —
    // so the work already done produced no reply.
    const now = 1_000_000;
    expect(completionBudgetFor(now + 65_000, now)).toBe(65_000);
    expect(completionBudgetFor(now + 65_000, now)).toBeLessThan(completionBudgetMs());
  });

  it("keeps the full allowance when the run has room for it", () => {
    const now = 1_000_000;
    expect(completionBudgetFor(now + 10 * 60_000, now)).toBe(completionBudgetMs());
  });

  it("never returns zero, so a nearly-spent run still makes one attempt", () => {
    const now = 1_000_000;
    expect(completionBudgetFor(now, now)).toBe(1_000);
    expect(completionBudgetFor(now - 5_000, now)).toBe(1_000);
  });

  it("uses the full allowance when the caller passes no deadline", () => {
    expect(completionBudgetFor(undefined, Date.now())).toBe(completionBudgetMs());
  });
});

describe("exhaustedAnswer must not claim work that did not happen", () => {
  it("names only the calls that succeeded", () => {
    const msg = exhaustedAnswer([
      { name: "scan_email_items", args: {}, ok: false },
      { name: "search_emails", args: {}, ok: true },
    ]);
    // The success list is everything before the failure parenthesis — a failed
    // call may still be NAMED there (the operator should know what failed), but
    // it must never be presented as work performed.
    const succeeded = msg.split("(وفشل")[0];
    expect(succeeded).toContain("search_emails");
    expect(succeeded).not.toContain("scan_email_items");
    expect(msg).toContain("scan_email_items"); // named as the failure, not as work
  });

  it("does not report fully-failed runs as «خطوات فعلية»", () => {
    const msg = exhaustedAnswer([
      { name: "search_database", args: {}, ok: false },
      { name: "run_readonly_query", args: {}, ok: false },
    ]);
    expect(msg).not.toContain("تم تنفيذ خطوات فعلية");
    expect(msg).toContain("لم تنجح");
    // The operator must still learn WHICH tools failed, so a retry can differ.
    expect(msg).toContain("search_database");
  });

  it("keeps the rephrase hint when nothing was attempted", () => {
    expect(exhaustedAnswer([])).toContain("إعادة صياغة");
  });
});
