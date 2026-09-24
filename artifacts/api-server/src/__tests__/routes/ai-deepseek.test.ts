import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Both providers configured: Gemini primary (the default endpoint) plus DeepSeek
// as the second provider. The keys are read at import time, so they must be set
// before the module is imported (the dynamic imports below handle that).
process.env.AI_API_KEY = "gemini-test-key";
process.env.DEEPSEEK_API_KEY = "deepseek-test-key";

describe("DeepSeek provider (second provider, cross-provider fallback)", () => {
  const fetchMock = vi.fn();
  beforeEach(async () => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    const { resetModelState } = await import("../../modules/ai-assistant/llm");
    resetModelState();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is configured from DEEPSEEK_API_KEY with its own endpoint and model", async () => {
    const {
      DEEPSEEK_BASE_URL,
      DEEPSEEK_MODEL,
      isDeepSeekConfigured,
      isDeepSeekEndpoint,
      isAiConfigured,
    } = await import("../../modules/ai-assistant/config");
    expect(DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com/v1");
    expect(DEEPSEEK_MODEL).toBe("deepseek-chat");
    expect(isDeepSeekConfigured).toBe(true);
    expect(isAiConfigured).toBe(true);
    expect(isDeepSeekEndpoint(DEEPSEEK_BASE_URL)).toBe(true);
    expect(isDeepSeekEndpoint("https://generativelanguage.googleapis.com/v1beta/openai")).toBe(
      false,
    );
  });

  it("falls through to DeepSeek when EVERY Gemini model is out of quota", async () => {
    // The failure this whole change exists for: the Gemini free tier is per
    // model, so once the whole chain 429s the assistant used to go silent. With
    // a second provider configured the chain must continue onto it.
    fetchMock.mockImplementation(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (String(url).includes("api.deepseek.com")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({ choices: [{ message: { content: "إجابة من DeepSeek" } }] }),
        };
      }
      return { ok: false, status: 429, text: async () => "quota exceeded" };
    });

    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    const res = await chatCompletion({ model: "gemini-3.6-flash", messages: [] });

    expect(res.content).toBe("إجابة من DeepSeek");
    expect(res.providerUsed).toBe("deepseek");
    expect(res.modelUsed).toBe("deepseek-chat");
    // The Gemini key must never be sent to DeepSeek, and vice versa.
    const deepseekCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("api.deepseek.com"),
    );
    expect(deepseekCall).toBeTruthy();
    expect(deepseekCall![1].headers.Authorization).toBe("Bearer deepseek-test-key");
    const geminiCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("generativelanguage.googleapis.com"),
    );
    expect(geminiCall![1].headers.Authorization).toBe("Bearer gemini-test-key");
  }, 30000);

  it("does NOT add DeepSeek when no key is configured (opt-in)", async () => {
    // Re-import with the DeepSeek key cleared: a deployment that only set
    // AI_API_KEY must keep the single-provider chain it had before.
    vi.resetModules();
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const mod = await import("../../modules/ai-assistant/llm");
      const cfg = await import("../../modules/ai-assistant/config");
      expect(cfg.isDeepSeekConfigured).toBe(false);
      const chain = mod.modelChainForTest(
        "gemini-3.6-flash",
        "https://generativelanguage.googleapis.com/v1beta/openai",
      );
      expect(chain.every((c) => c.provider === "gemini")).toBe(true);
    } finally {
      process.env.DEEPSEEK_API_KEY = saved;
      vi.resetModules();
    }
  });

  it("uses the configured provider when the primary provider has no key", async () => {
    // A deployment that set only DEEPSEEK_API_KEY must still answer rather than
    // 401 on every request against the Gemini endpoint.
    vi.resetModules();
    const savedGemini = process.env.AI_API_KEY;
    const savedOpenai = process.env.OPENAI_API_KEY;
    const savedGeminiKey = process.env.GEMINI_API_KEY;
    delete process.env.AI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const mod = await import("../../modules/ai-assistant/llm");
      const cfg = await import("../../modules/ai-assistant/config");
      expect(cfg.isAiConfigured).toBe(true);
      const chain = mod.modelChainForTest(
        "gemini-3.6-flash",
        "https://generativelanguage.googleapis.com/v1beta/openai",
      );
      expect(chain.every((c) => c.provider === "deepseek")).toBe(true);
      expect(chain[0].apiKey).toBe("deepseek-test-key");
    } finally {
      process.env.AI_API_KEY = savedGemini;
      if (savedOpenai) process.env.OPENAI_API_KEY = savedOpenai;
      if (savedGeminiKey) process.env.GEMINI_API_KEY = savedGeminiKey;
      vi.resetModules();
    }
  });

  it("advances past a model that cannot read an image (400 capability gap)", async () => {
    // Measured live: deepseek-chat rejects an image part with 400 while
    // deepseek-v4-pro accepts it. A 400 is normally permanent, but a capability
    // gap must try the next model rather than fail the question.
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: {
              message:
                ".messages[0].image[0]: You have uploaded an unsupported image. Please make sure your image is valid and has one of the following formats: webp, png, jpeg, and gif.",
            },
          }),
      })
      .mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ choices: [{ message: { content: "صورة مقروءة" } }] }),
      });
    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    const res = await chatCompletion({
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      messages: [{ role: "user", content: "إيه في الصورة؟" }],
    });
    expect(res.content).toBe("صورة مقروءة");
    const models = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).model);
    expect(models[0]).toBe("deepseek-chat");
    expect(models[1]).not.toBe("deepseek-chat");
  });

  it("still fails fast on a genuine 400 (malformed request)", async () => {
    // The capability exception must not swallow a real bad request: that would
    // hide a bug behind N pointless retries.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: { message: "invalid request: messages is required" } }),
    });
    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    await expect(
      chatCompletion({ model: "deepseek-chat", messages: [{ role: "user", content: "q" }] }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("routes a DeepSeek model id to DeepSeek even when the base URL is Gemini", async () => {
    // An operator may pick a DeepSeek model in the settings while AI_BASE_URL
    // still points at Gemini. Sending that id to Gemini 404s on every request.
    const { modelChainForTest } = await import("../../modules/ai-assistant/llm");
    const chain = modelChainForTest(
      "deepseek-chat",
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
    expect(chain[0].model).toBe("deepseek-chat");
    expect(chain[0].provider).toBe("deepseek");
    expect(chain[0].base).toBe("https://api.deepseek.com/v1");
    expect(chain[0].apiKey).toBe("deepseek-test-key");
  });

  it("uses the primary model for the fast path on DeepSeek (the light id is Gemini-only)", async () => {
    const { modelForPath, FAST_MODEL } = await import("../../modules/ai-assistant/config");
    expect(modelForPath("gemini-3.6-flash", "fast")).toBe(FAST_MODEL);
    // On DeepSeek the Gemini fast id does not exist — use the primary.
    expect(modelForPath("deepseek-chat", "fast", "https://api.deepseek.com/v1")).toBe(
      "deepseek-chat",
    );
    expect(modelForPath("deepseek-v4-pro", "fast", null)).toBe("deepseek-v4-pro");
  });

  it("echoes reasoning_content on an assistant tool-call turn (DeepSeek rejects it otherwise)", async () => {
    const { withReasoningEcho } = await import("../../modules/ai-assistant/llm");
    const messages: any[] = [
      { role: "user", content: "كم عدد أوامر الشراء؟" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "count_database", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "{}" },
    ];
    const out = withReasoningEcho(messages);
    expect(out[1].reasoning_content).toBe("");
    // A plain assistant text turn is left untouched.
    expect(withReasoningEcho([{ role: "assistant", content: "hi" }])[0].reasoning_content).toBe(
      undefined,
    );
  });

  it("sends reasoning_content on the wire for a tool-call turn", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({ choices: [{ message: { content: "تم", reasoning_content: "تفكير" } }] }),
    });
    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    await chatCompletion({
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "{}" },
      ],
    });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    const assistantTurn = sent.messages.find((m: any) => m.role === "assistant");
    expect(assistantTurn.reasoning_content).toBe("");
  });

  it("captures reasoning_content from the provider response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: "ok", reasoning_content: "خطوات التفكير" } }],
        }),
    });
    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    const res = await chatCompletion({
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      messages: [{ role: "user", content: "q" }],
    });
    expect(res.reasoningContent).toBe("خطوات التفكير");
    expect(res.providerUsed).toBe("deepseek");
  });

  it("does not attempt transcription on DeepSeek (no audio endpoint)", async () => {
    // A 404 from a non-existent endpoint would be logged as a provider failure
    // for something the provider simply does not offer.
    const { transcribeAudio } = await import("../../modules/ai-assistant/llm");
    const text = await transcribeAudio(
      Buffer.from("ogg"),
      "audio/ogg",
      "https://api.deepseek.com/v1",
      "deepseek-chat",
    );
    expect(text).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not attempt document extraction on DeepSeek (no PDF input)", async () => {
    const { extractDocumentText } = await import("../../modules/ai-assistant/llm");
    const text = await extractDocumentText(
      Buffer.from("%PDF-1.4"),
      "application/pdf",
      "https://api.deepseek.com/v1",
      "deepseek-chat",
    );
    expect(text).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queries each provider with its own key when listing models", async () => {
    fetchMock.mockImplementation(async (url: string, init: any) => {
      const auth = init.headers.Authorization;
      if (String(url).includes("api.deepseek.com")) {
        expect(auth).toBe("Bearer deepseek-test-key");
        return { ok: true, json: async () => ({ data: [{ id: "deepseek-chat" }] }) };
      }
      expect(auth).toBe("Bearer gemini-test-key");
      return { ok: true, json: async () => ({ data: [{ id: "gemini-3.6-flash" }] }) };
    });
    const { listAllModels } = await import("../../modules/ai-assistant/llm");
    const models = await listAllModels(null);
    expect(models).toContain("gemini-3.6-flash");
    expect(models).toContain("deepseek-chat");
  });
});
