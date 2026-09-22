import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The LLM module reads AI_API_KEY at import time.
process.env.AI_API_KEY = "test-key";

describe("Gemini integration (llm.ts)", () => {
  const fetchMock = vi.fn();
  beforeEach(async () => {
    // mockReset (not clearAllMocks) so a queued `mockResolvedValueOnce` from a
    // previous test cannot leak into this one.
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    // Model-selection memory persists across requests by design; clear it so
    // one test's exhausted model does not leak into the next.
    const { resetModelState } = await import("../../modules/ai-assistant/llm");
    resetModelState();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults the base URL to Gemini's OpenAI-compatible endpoint", async () => {
    const { DEFAULT_BASE_URL, DEFAULT_MODEL, isGeminiEndpoint } =
      await import("../../modules/ai-assistant/config");
    expect(DEFAULT_BASE_URL).toContain("generativelanguage.googleapis.com");
    expect(DEFAULT_BASE_URL).toContain("/openai");
    expect(DEFAULT_MODEL).toBe("gemini-3.8-flash");
    expect(isGeminiEndpoint(null)).toBe(true);
    expect(isGeminiEndpoint("https://api.openai.com/v1")).toBe(false);
  });

  it("transcribes OGG voice notes via Gemini's NATIVE generateContent endpoint", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "  سلام عليكم  " }] } }],
      }),
    });
    const { transcribeAudio } = await import("../../modules/ai-assistant/llm");
    const text = await transcribeAudio(
      Buffer.from("oggbytes"),
      "audio/ogg",
      null,
      "gemini-3.8-flash",
    );

    expect(text).toBe("سلام عليكم");
    const [url, init] = fetchMock.mock.calls[0];
    // Must hit the native model endpoint (NOT /openai/... and NOT /audio/transcriptions)
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    );
    expect(url).not.toContain("/openai");
    expect(init.headers["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body);
    expect(body.contents[0].parts[1].inline_data.mime_type).toBe("audio/ogg");
    expect(body.contents[0].parts[1].inline_data.data).toBe(
      Buffer.from("oggbytes").toString("base64"),
    );
  });

  it("returns null when Gemini transcription fails (graceful degradation)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => "bad" });
    const { transcribeAudio } = await import("../../modules/ai-assistant/llm");
    const text = await transcribeAudio(Buffer.from("x"), "audio/ogg", null, "gemini-3.8-flash");
    expect(text).toBeNull();
  });

  it("uses the whisper endpoint for non-Gemini OpenAI-compatible providers", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ text: "hello" }) });
    const { transcribeAudio } = await import("../../modules/ai-assistant/llm");
    const text = await transcribeAudio(Buffer.from("x"), "audio/ogg", "https://api.openai.com/v1");
    expect(text).toBe("hello");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/audio/transcriptions");
  });

  it("lists models and strips the models/ prefix", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "models/gemini-3.8-flash" }, { id: "models/gemini-2.5-pro" }],
      }),
    });
    const { listModels } = await import("../../modules/ai-assistant/llm");
    const models = await listModels(null);
    expect(models).toContain("gemini-3.8-flash");
    expect(models).toContain("gemini-2.5-pro");
    expect(models.some((m) => m.startsWith("models/"))).toBe(false);
  });

  it("retries transient 503s before succeeding", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "high demand" })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: "تمام" }, finish_reason: "stop" }],
          }),
      });
    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    const res = await chatCompletion({ model: "gemini-3.8-flash", messages: [] });
    expect(res.content).toBe("تمام");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient 400", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => "bad request" });
    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    await expect(chatCompletion({ model: "m", messages: [] })).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the next model when the primary is out of quota (429)", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "quota exceeded for gemini-3.8-flash; retry in 11s",
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({ choices: [{ message: { content: "من الموديل البديل" } }] }),
      });
    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    const res = await chatCompletion({ model: "gemini-3.8-flash", messages: [] });
    expect(res.content).toBe("من الموديل البديل");
    // Did NOT hammer the exhausted model: one 429 then straight to the fallback.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("gemini-3.8-flash");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).not.toBe("gemini-3.8-flash");
  });

  it("surfaces a quota error only after every fallback model is exhausted", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => "quota exceeded" });
    const { chatCompletion, isQuotaError } = await import("../../modules/ai-assistant/llm");
    const { FALLBACK_MODELS } = await import("../../modules/ai-assistant/config");
    let caught: unknown;
    try {
      await chatCompletion({ model: "gemini-3.8-flash", messages: [] });
    } catch (e) {
      caught = e;
    }
    expect(isQuotaError(caught)).toBe(true);
    // Primary + every configured fallback, each tried once. Derived from the
    // chain so extending it (to multiply the free-tier quota) does not break
    // this test.
    expect(fetchMock).toHaveBeenCalledTimes(1 + FALLBACK_MODELS.length);
    // Every candidate was actually attempted, and no model twice.
    const tried = fetchMock.mock.calls.map((c: any[]) => JSON.parse(c[1].body).model);
    expect(tried[0]).toBe("gemini-3.8-flash");
    expect(new Set(tried).size).toBe(tried.length);
  });

  it("moves to the next model when one is overloaded (503), not just on quota", async () => {
    // Observed live: gemini-3.7-flash answers 503 "high demand" while
    // gemini-3.6-flash serves the same request fine. Only one retry on the
    // overloaded model — a long retry chain just delays the fallback.
    const unavailable = { ok: false, status: 503, text: async () => "high demand" };
    fetchMock
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ choices: [{ message: { content: "رد بديل" } }] }),
      });
    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    const res = await chatCompletion({ model: "gemini-3.8-flash", messages: [] });
    expect(res.content).toBe("رد بديل");
    // 2 attempts on the overloaded primary, then the fallback model answers.
    const models = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).model);
    expect(models.filter((m) => m === "gemini-3.8-flash")).toHaveLength(2);
    expect(models[2]).not.toBe("gemini-3.8-flash");
  }, 20000);

  it("sticks to the model that worked instead of re-probing the dead primary", async () => {
    // The costly pattern: the primary is out for the day (429, no retry hint),
    // a fallback answers. On the NEXT request the chain must start at the model
    // that worked — a tool-calling turn makes several requests, and re-walking
    // the chain from the top each time is pure added latency.
    const { chatCompletion, resetModelState } = await import("../../modules/ai-assistant/llm");
    resetModelState();
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { message: "quota exceeded, limit: 20" } }),
      })
      .mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      });

    await chatCompletion({ model: "gemini-3.8-flash", messages: [] });
    const first = fetchMock.mock.calls.map((c: any[]) => JSON.parse(c[1].body).model);
    expect(first[0]).toBe("gemini-3.8-flash");
    const winner = first[1];
    expect(winner).not.toBe("gemini-3.8-flash");

    fetchMock.mockClear();
    await chatCompletion({ model: "gemini-3.8-flash", messages: [] });
    const second = fetchMock.mock.calls.map((c: any[]) => JSON.parse(c[1].body).model);
    // One call: straight to the model that worked, primary not re-probed.
    expect(second).toEqual([winner]);
  });

  it("waits out a short per-minute limit instead of downgrading the model", async () => {
    // A 429 that states a short retryDelay is a per-minute limit: the model
    // recovers in seconds and is better than the fallback, so wait it out.
    const { chatCompletion, resetModelState } = await import("../../modules/ai-assistant/llm");
    resetModelState();
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () =>
          JSON.stringify({ error: { message: "rate limited", details: [{ retryDelay: "1s" }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ choices: [{ message: { content: "بعد الانتظار" } }] }),
      });
    const res = await chatCompletion({ model: "gemini-3.8-flash", messages: [] });
    expect(res.content).toBe("بعد الانتظار");
    // Retried the SAME model rather than falling through the whole chain.
    const models = fetchMock.mock.calls.map((c: any[]) => JSON.parse(c[1].body).model);
    expect(models).toEqual(["gemini-3.8-flash", "gemini-3.8-flash"]);
    resetModelState();
  }, 20000);

  it("does not waste fallbacks on a permanent 400", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => "bad request" });
    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    await expect(chatCompletion({ model: "gemini-3.8-flash", messages: [] })).rejects.toThrow(
      /400/,
    );
    // A malformed request fails identically on every model — tried once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies a 503 as a quota/capacity error", async () => {
    const { isQuotaError, AiError } = await import("../../modules/ai-assistant/llm");
    expect(isQuotaError(new AiError("x", 503))).toBe(true);
    expect(isQuotaError(new AiError("x", 429))).toBe(true);
    expect(isQuotaError(new AiError("x", 400))).toBe(false);
    expect(isQuotaError(new Error("plain"))).toBe(false);
  });

  it("gives up once the overall budget is spent instead of retrying for minutes", async () => {
    // Every model fails transiently. Without a budget this walks the whole chain
    // (7 models × 2 attempts × 45s), so the operator waits minutes and gets the
    // answer after they have already left the chat — the reported "مردتش".
    process.env.AI_COMPLETION_BUDGET_MS = "300";
    try {
      fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => "high demand" });
      const { chatCompletion, resetModelState } = await import("../../modules/ai-assistant/llm");
      resetModelState();
      const startedAt = Date.now();
      await expect(chatCompletion({ model: "gemini-3.8-flash", messages: [] })).rejects.toThrow(
        /budget/i,
      );
      // It stopped because time ran out, not because it walked the chain: the
      // chain alone would take longer than the budget we granted.
      expect(Date.now() - startedAt).toBeLessThan(3000);
      expect(fetchMock.mock.calls.length).toBeLessThan(7);
    } finally {
      delete process.env.AI_COMPLETION_BUDGET_MS;
    }
  });

  it("recognises a timeout so the operator is told to retry, not left in silence", async () => {
    const { isTimeoutError } = await import("../../modules/ai-assistant/llm");
    expect(isTimeoutError(new Error("LLM request budget of 100000ms exhausted"))).toBe(true);
    expect(isTimeoutError(new Error("This operation was aborted"))).toBe(true);
    expect(isTimeoutError(new Error("LLM request failed (400): bad request"))).toBe(false);
  });
});
