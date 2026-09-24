/**
 * The behaviour the reserve exists for: when the ENTIRE primary provider is
 * unavailable, the alternative provider must still be reached and answer.
 *
 * Live incident shape: `AI_MODEL = gemini-3.8-flash` (measured 1/5 success under
 * load) with a 7-model Gemini chain. Every Gemini model answering 503 spends
 * 7 × perModelMs before DeepSeek is tried, and a slow 503 (~40s observed)
 * exhausts the completion budget first — so the operator got «وصل لحد الاستخدام
 * المسموح» while a configured, healthy DeepSeek key sat unused. The reserve
 * makes the primary's models unable to run the clock past
 * `deadline - secondaryReserveMs`.
 *
 * Both keys are set here because that is the deployed shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.AI_API_KEY = "gemini-primary-test-key";
process.env.DEEPSEEK_API_KEY = "sk-deepseek-secondary-test-key";

describe("failover reaches the secondary provider during a full primary outage", () => {
  const fetchMock = vi.fn();
  const okBody = JSON.stringify({
    choices: [{ message: { content: "تم" } }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  });
  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    const { resetModelState } = await import("../../modules/ai-assistant/llm");
    resetModelState();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers from DeepSeek when every Gemini model returns a SLOW 503", async () => {
    // The live shape that produced the incident: a 503 that takes seconds to
    // arrive. A fast 503 is harmless (the chain walks the models in milliseconds
    // and reaches DeepSeek anyway); it is the SLOW one — measured ~40s live —
    // that consumes the budget before the secondary is tried. Without the
    // reserve this test times out instead of answering.
    process.env.AI_COMPLETION_BUDGET_MS = "12000";
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("generativelanguage.googleapis.com")) {
        // 3s per attempt, 7 models × 2 attempts ≫ the 12s budget.
        await new Promise((r) => setTimeout(r, 3000));
        return { ok: false, status: 503, text: async () => "high demand" };
      }
      return { ok: true, status: 200, text: async () => okBody };
    });

    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    const res = await chatCompletion({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "رد بكلمة تم" }] as never,
    });

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    // The decisive assertion: a request actually reached the OTHER provider,
    // because the reserve stopped the primary chain before the clock ran out.
    expect(urls.some((u) => u.includes("api.deepseek.com"))).toBe(true);
    expect((res as { providerUsed?: string }).providerUsed).toBe("deepseek");
    delete process.env.AI_COMPLETION_BUDGET_MS;
  }, 300000);

  it("does not reach the secondary while the primary can still answer", async () => {
    // The reserve must not degrade the common case into a DeepSeek-first system:
    // when the primary works, it answers and the secondary is never called.
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("generativelanguage.googleapis.com")) {
        return { ok: true, status: 200, text: async () => okBody };
      }
      throw new Error("the secondary provider must not be called");
    });

    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    const res = await chatCompletion({
      model: "gemini-3.8-flash",
      messages: [{ role: "user", content: "رد بكلمة تم" }] as never,
    });
    expect((res as { providerUsed?: string }).providerUsed).toBe("gemini");
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes("deepseek"))).toBe(true);
  }, 300000);
});
