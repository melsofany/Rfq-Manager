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
      DEEPSEEK_FALLBACK_MODELS,
      isDeepSeekConfigured,
      isDeepSeekEndpoint,
      isAiConfigured,
    } = await import("../../modules/ai-assistant/config");
    expect(DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com/v1");
    // The flagship reasoning model is the default primary now; `deepseek-chat`
    // (the `deepseek-flash` alias) is its first fallback.
    expect(DEEPSEEK_MODEL).toBe("deepseek-v4-pro");
    expect(DEEPSEEK_FALLBACK_MODELS).toContain("deepseek-chat");
    expect(isDeepSeekConfigured).toBe(true);
    expect(isAiConfigured).toBe(true);
    expect(isDeepSeekEndpoint(DEEPSEEK_BASE_URL)).toBe(true);
    expect(isDeepSeekEndpoint("https://generativelanguage.googleapis.com/v1beta/openai")).toBe(
      false,
    );
  });

  it("falls through to Gemini when EVERY DeepSeek model is out of quota", async () => {
    // The provider chain must survive either provider running dry. DeepSeek is the
    // primary now, so this exercises the reverse direction: every DeepSeek model
    // 429s and the chain continues onto Gemini, the second configured provider.
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (String(url).includes("api.deepseek.com")) {
        return { ok: false, status: 429, text: async () => "quota exceeded" };
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({ choices: [{ message: { content: "إجابة من Gemini" } }] }),
      };
    });

    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    const res = await chatCompletion({
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com/v1",
      messages: [],
    });

    expect(res.content).toBe("إجابة من Gemini");
    expect(res.providerUsed).toBe("gemini");
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

  it("routes the DeepSeek fast path to the light DeepSeek model, not a Gemini id", async () => {
    const { modelForPath, FAST_MODEL, DEEPSEEK_FALLBACK_MODELS } =
      await import("../../modules/ai-assistant/config");
    // Gemini primary: its own light model.
    expect(modelForPath("gemini-3.6-flash", "fast")).toBe(FAST_MODEL);
    // DeepSeek primary: the light DeepSeek model, because a Gemini fast id does
    // not exist on DeepSeek and would 404 on every fast-path question.
    expect(modelForPath("deepseek-v4-pro", "fast", "https://api.deepseek.com/v1")).toBe(
      DEEPSEEK_FALLBACK_MODELS[0],
    );
    expect(modelForPath("deepseek-v4-pro", "fast", "https://api.deepseek.com/v1")).not.toBe(
      "deepseek-v4-pro",
    );
    // An operator who picked the light DeepSeek model explicitly (and left
    // `baseUrl` null) must still route to a DeepSeek id, never to Gemini's
    // fast id, which DeepSeek does not serve.
    expect(modelForPath("deepseek-chat", "fast", null)).toBe(DEEPSEEK_FALLBACK_MODELS[0]);
    expect(modelForPath("deepseek-chat", "fast", null)).not.toBe(FAST_MODEL);
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

  it("converts DeepSeek DSML content into structured tool calls", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content:
                  `<DSML｜｜ calls>\n` +
                  `<DSML｜｜ invoke name="start_census_job">` +
                  `<DSML｜｜ parameter name="docKind" string="true">rfq</DSML｜｜ parameter>` +
                  `<DSML｜｜ parameter name="contains" string="true">EZQ 20/4</DSML｜｜ parameter>` +
                  `</DSML｜｜ invoke>\n</DSML｜｜tool_calls>`,
              },
            },
          ],
        }),
    });
    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    const res = await chatCompletion({
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com/v1",
      messages: [{ role: "user", content: "ابحث في RFQ" }],
    });
    expect(res.content).toBeNull();
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].function.name).toBe("start_census_job");
    expect(JSON.parse(res.toolCalls[0].function.arguments)).toEqual({
      docKind: "rfq",
      contains: "EZQ 20/4",
    });
  });

  it("still transcribes a voice note via Gemini when the CHAT provider is DeepSeek", async () => {
    // The chat provider must not decide the media provider: DeepSeek has no
    // transcription endpoint, so a voice note is read by Gemini regardless. This
    // is the regression guard for the switch — deriving the media endpoint from
    // the chat base URL silently disabled every voice note.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "نص" }] } }] }),
    });
    const { transcribeAudio } = await import("../../modules/ai-assistant/llm");
    const text = await transcribeAudio(
      Buffer.from("ogg"),
      "audio/ogg",
      "https://api.deepseek.com/v1", // the CHAT provider
      "deepseek-v4-pro", // the CHAT model
    );
    expect(text).toBe("نص");
    // It went to GEMINI's native endpoint, with a Gemini model id — never to
    // DeepSeek's (non-existent) audio endpoint, and never with `deepseek-v4-pro`.
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain(":generateContent");
    expect(url).not.toContain("deepseek");
    expect(url).not.toContain("deepseek-v4-pro");
  });

  it("still reads a document via Gemini when the CHAT provider is DeepSeek", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "محتوى" }] } }] }),
    });
    const { extractDocumentText } = await import("../../modules/ai-assistant/llm");
    const text = await extractDocumentText(
      Buffer.from("%PDF-1.4"),
      "application/pdf",
      "https://api.deepseek.com/v1",
      "deepseek-v4-pro",
    );
    expect(text).toBe("محتوى");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).not.toContain("deepseek");
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

describe("startup provider-capacity log", () => {
  it("reports the failover capacity, and names a single provider as a warning", async () => {
    // Diagnosing a whole-assistant outage from outside is near-impossible: a list
    // of model names looks the same whether one provider or two are configured.
    // The live service had ONE key and no DEEPSEEK_API_KEY, which is the fact that
    // explains "the daily quota is exhausted" — so it is stated at startup.
    const { logProviderCapacity, configuredProviderCount } =
      await import("../../modules/ai-assistant/config");
    const { logger } = await import("../../shared/logger");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    expect(configuredProviderCount()).toBe(2);
    logProviderCapacity();
    // Both keys are set in this file, so the healthy path is taken.
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        ready: expect.arrayContaining([expect.stringContaining("deepseek")]),
      }),
      expect.stringContaining("failover configured"),
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ single: true }),
      expect.anything(),
    );
    warn.mockRestore();
    info.mockRestore();
  });

  it("names a model each provider can actually serve", async () => {
    // `providerStatus()` used `DEFAULT_MODEL` for the Gemini row, which is a
    // DeepSeek id in the default deployment — so production logged the pair
    // `gemini:deepseek-v4-pro`, a provider:model that exists nowhere, and the
    // startup line that exists to explain a failover problem read as nonsense.
    const { providerStatus } = await import("../../modules/ai-assistant/config");
    const status = providerStatus();
    const gemini = status.find((s) => s.provider === "gemini");
    const deepseek = status.find((s) => s.provider === "deepseek");
    expect(gemini?.model).toMatch(/gemini/i);
    expect(gemini?.model).not.toMatch(/deepseek/i);
    expect(deepseek?.model).toMatch(/deepseek/i);
  });
});

describe("output-token ceiling by model kind", () => {
  it("gives a reasoning model more room than its thinking needs", async () => {
    // Measured live on `deepseek-v4-pro` with a real 120-row tool result: at
    // `max_tokens:1600` the reply came back EMPTY with `finish_reason:"length"`
    // and all 1600 completion tokens charged to `reasoning_tokens`. The answer
    // was discarded and the operator saw «نفدت محاولات المعالجة» three times in a
    // row. A reasoning model's thinking is charged against the same budget as its
    // reply, so the ceiling has to exceed the thinking.
    const { maxTokensFor } = await import("../../modules/ai-assistant/llm");
    expect(maxTokensFor("deepseek-v4-pro")).toBeGreaterThan(4000);
    expect(maxTokensFor("deepseek-reasoner")).toBeGreaterThan(4000);
    // A non-reasoning id spends its whole budget on the reply, so it keeps the
    // small ceiling.
    expect(maxTokensFor("deepseek-chat")).toBeLessThanOrEqual(2000);
    expect(maxTokensFor("gemini-3.6-flash")).toBeLessThanOrEqual(2000);
  });
});
