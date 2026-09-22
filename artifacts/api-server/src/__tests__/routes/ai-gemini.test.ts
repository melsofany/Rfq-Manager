import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The LLM module reads AI_API_KEY at import time.
process.env.AI_API_KEY = "test-key";

describe("Gemini integration (llm.ts)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
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
    let caught: unknown;
    try {
      await chatCompletion({ model: "gemini-3.8-flash", messages: [] });
    } catch (e) {
      caught = e;
    }
    expect(isQuotaError(caught)).toBe(true);
    // Primary + both configured fallbacks, each tried once.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("moves to the next model when one is overloaded (503), not just on quota", async () => {
    // Observed live: gemini-3.7-flash answers 503 "high demand" while
    // gemini-3.6-flash serves the same request fine.
    const unavailable = { ok: false, status: 503, text: async () => "high demand" };
    fetchMock
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ choices: [{ message: { content: "رد بديل" } }] }),
      });
    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    const res = await chatCompletion({ model: "gemini-3.8-flash", messages: [] });
    expect(res.content).toBe("رد بديل");
    // 3 attempts on the overloaded primary, then the fallback model answers.
    const models = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).model);
    expect(models.filter((m) => m === "gemini-3.8-flash")).toHaveLength(3);
    expect(models[3]).not.toBe("gemini-3.8-flash");
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
});
