import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the provider seam (the classifier's only I/O) and the config gate.
const hoisted = vi.hoisted(() => ({
  aiConfigured: true,
  model: "deepseek-v4-pro",
  baseUrl: null as string | null,
}));
const chatCompletion = vi.fn();
vi.mock("../../modules/ai-assistant/llm", () => ({
  chatCompletion: (...args: any[]) => chatCompletion(...args),
}));

vi.mock("../../modules/ai-assistant/config", () => ({
  DEFAULT_MODEL: "deepseek-v4-pro",
  DEFAULT_BASE_URL: "https://api.deepseek.com/v1",
  DEEPSEEK_FALLBACK_MODELS: ["deepseek-chat"],
  isGeminiModelId: (m?: string | null) => /gemini/i.test(m ?? ""),
  isDeepSeekEndpoint: (b?: string | null) => /deepseek/i.test(b ?? ""),
  get isAiConfigured() {
    return hoisted.aiConfigured;
  },
  loadSettings: async () => ({
    enabled: true,
    model: hoisted.model,
    baseUrl: hoisted.baseUrl,
    systemPrompt: null,
    language: "ar",
    allowEmail: true,
    allowDatabase: true,
    allowReadOnlySql: true,
    allowPdf: true,
  }),
}));

vi.mock("../../shared/logger", () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

import {
  classifyItemsWithAi,
  parseClassifyReply,
  classifyMaxTokensFor,
} from "../../modules/rfq/ai-classifier";

const CATEGORIES = [
  { id: 1, code: "equipment", name: "أجهزة" },
  { id: 2, code: "spare_parts", name: "قطع غيار" },
  { id: 3, code: "electrical", name: "كهرباء" },
];

function reply(json: unknown) {
  return { content: JSON.stringify(json), toolCalls: [], finishReason: "stop" };
}

beforeEach(() => {
  chatCompletion.mockReset();
  hoisted.aiConfigured = true;
  hoisted.model = "deepseek-v4-pro";
  hoisted.baseUrl = null;
});

describe("AI item classifier", () => {
  it("maps the model's category NAME to the category id", async () => {
    chatCompletion.mockResolvedValue(
      reply({ results: [{ i: 1, name: "كهرباء", confidence: 88 }] }),
    );
    const out = await classifyItemsWithAi([{ description: "قاطع كهرباء 63A" }], CATEGORIES);
    expect(out).toEqual([
      {
        categoryId: 3,
        confidence: 88,
        matchedTerm: "كهرباء",
        subcategoryIds: [],
        brandId: null,
        attributes: null,
        reason: null,
      },
    ]);
  });

  it("offers categories that have NO code — the operator-added ones", async () => {
    // Most of the catalogue has no `code`; the old code-filter silently dropped
    // them so the model could only ever pick from the 5 seeded categories.
    chatCompletion.mockResolvedValue(
      reply({ results: [{ i: 1, name: "مواسير ولوازم صحية", confidence: 90 }] }),
    );
    const cats = [
      { id: 1, code: "equipment", name: "أجهزة" },
      { id: 7, code: null, name: "مواسير ولوازم صحية" },
    ];
    const out = await classifyItemsWithAi([{ description: "كوع مواسير" }], cats);
    expect(out?.[0]?.categoryId).toBe(7);
    // The whole catalogue must be in the prompt, not just the coded subset.
    const sent = chatCompletion.mock.calls[0][0] as { messages: Array<{ content: string }> };
    expect(JSON.stringify(sent.messages)).toContain("مواسير ولوازم صحية");
  });

  it("classifies a BATCH in one request, indexed by position", async () => {
    chatCompletion.mockResolvedValue(
      reply({
        results: [
          { i: 1, name: "أجهزة", confidence: 90 },
          { i: 2, name: "قطع غيار", confidence: 70 },
        ],
      }),
    );
    const out = await classifyItemsWithAi(
      [{ description: "مضخة مياه" }, { description: "جوان كاوتش" }],
      CATEGORIES,
    );
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(out?.[0]?.categoryId).toBe(1);
    expect(out?.[1]?.categoryId).toBe(2);
  });

  it("returns null for «غير معروف» — never invents a category", async () => {
    chatCompletion.mockResolvedValue(
      reply({ results: [{ i: 1, name: "غير معروف", confidence: 0 }] }),
    );
    const out = await classifyItemsWithAi([{ description: "ZZZ ???" }], CATEGORIES);
    expect(out).toEqual([null]);
  });

  it("REFUSES a category the model invented (not in the catalogue)", async () => {
    chatCompletion.mockResolvedValue(reply({ results: [{ i: 1, name: "سباكة", confidence: 95 }] }));
    const out = await classifyItemsWithAi([{ description: "مواسير" }], CATEGORIES);
    expect(out).toEqual([null]);
  });

  it("tolerates a fenced code block around the JSON", async () => {
    chatCompletion.mockResolvedValue({
      content: 'إليك النتيجة:\n```json\n{"results":[{"i":1,"name":"كهرباء","confidence":80}]}\n```',
      toolCalls: [],
      finishReason: "stop",
    });
    const out = await classifyItemsWithAi([{ description: "كابل" }], CATEGORIES);
    expect(out?.[0]?.categoryId).toBe(3);
  });

  it("matches a name despite spelling variants (hamza / taa marbuta)", async () => {
    chatCompletion.mockResolvedValue(reply({ results: [{ i: 1, name: "اجهزه", confidence: 80 }] }));
    const out = await classifyItemsWithAi([{ description: "لوحة تحكم" }], CATEGORIES);
    expect(out?.[0]?.categoryId).toBe(1);
  });

  it("returns null (fallback) when the reply is unparsable", async () => {
    chatCompletion.mockResolvedValue({ content: "لا أستطيع", toolCalls: [], finishReason: "stop" });
    const out = await classifyItemsWithAi([{ description: "بند" }], CATEGORIES);
    expect(out).toBeNull();
  });

  it("returns null (fallback) when the provider throws", async () => {
    chatCompletion.mockRejectedValue(new Error("503 overloaded"));
    const out = await classifyItemsWithAi([{ description: "بند" }], CATEGORIES);
    expect(out).toBeNull();
  });

  it("returns null WITHOUT a network call when no provider is configured", async () => {
    hoisted.aiConfigured = false;
    const out = await classifyItemsWithAi([{ description: "بند" }], CATEGORIES);
    expect(out).toBeNull();
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it("returns null when there are no categories to choose from", async () => {
    const out = await classifyItemsWithAi([{ description: "بند" }], []);
    expect(out).toBeNull();
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  // ── Reasoning-model budget ────────────────────────────────────────────────
  // A reasoning model (deepseek-v4-pro) charges its thinking against
  // `max_tokens`. At 4000 the reply came back `finish_reason:"length"` with
  // `content:""` — every token spent on reasoning — so the whole batch was
  // silently left unclassified. Reproduced against the live provider (PR #217).
  it("downgrades a DeepSeek reasoning primary to the light model for classification", async () => {
    chatCompletion.mockResolvedValue(reply({ results: [{ i: 1, name: "أجهزة", confidence: 90 }] }));
    await classifyItemsWithAi([{ description: "مضخة" }], CATEGORIES);
    const sent = chatCompletion.mock.calls[0][0] as { model: string; maxTokens?: number };
    // deepseek-chat is the light model; the reasoning primary would spend the
    // whole budget thinking about a closed-list choice.
    expect(sent.model).toBe("deepseek-chat");
    // …and the ceiling still covers the reply for the model actually used.
    expect(sent.maxTokens).toBe(classifyMaxTokensFor(sent.model));
  });

  it("keeps the operator's model when it is NOT a DeepSeek reasoning id", async () => {
    hoisted.model = "gemini-3.6-flash";
    hoisted.baseUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
    chatCompletion.mockResolvedValue(reply({ results: [{ i: 1, name: "أجهزة", confidence: 90 }] }));
    await classifyItemsWithAi([{ description: "مضخة" }], CATEGORIES);
    const sent = chatCompletion.mock.calls[0][0] as { model: string; maxTokens?: number };
    expect(sent.model).toBe("gemini-3.6-flash");
    expect(sent.maxTokens).toBe(4000);
  });

  it("funds the reply of a reasoning model when it must be used at all", () => {
    // Defence in depth: if a deployment has no light model, the reasoning id is
    // still used — and then its thinking must not consume the whole ceiling.
    expect(classifyMaxTokensFor("deepseek-v4-pro")).toBeGreaterThanOrEqual(8000);
    expect(classifyMaxTokensFor("deepseek-r1")).toBeGreaterThanOrEqual(8000);
    expect(classifyMaxTokensFor("deepseek-chat")).toBe(4000);
    expect(classifyMaxTokensFor("gemini-3.6-flash")).toBe(4000);
  });

  it("does NOT treat a truncated reply as «the provider is down» — retries smaller", async () => {
    // First attempt is cut by the token ceiling (empty content, finish=length);
    // the classifier must re-ask with FEWER items, not give up.
    chatCompletion
      .mockResolvedValueOnce({ content: "", toolCalls: [], finishReason: "length" })
      .mockImplementationOnce((opts: { messages: Array<{ content: string }> }) => {
        // The re-ask must be genuinely smaller — count the listed items.
        const listed = opts.messages[1].content.match(/^\d+\. /gm) ?? [];
        expect(listed.length).toBeLessThan(8);
        return Promise.resolve(
          reply({ results: listed.map((_, i) => ({ i: i + 1, name: "كهرباء", confidence: 85 })) }),
        );
      });
    const batch = Array.from({ length: 8 }, () => ({ description: "قاطع" }));
    const out = await classifyItemsWithAi(batch, CATEGORIES);
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(out?.[0]?.categoryId).toBe(3);
  });

  it("returns null when every attempt is truncated", async () => {
    chatCompletion.mockResolvedValue({ content: "", toolCalls: [], finishReason: "length" });
    const batch = Array.from({ length: 8 }, () => ({ description: "قاطع" }));
    const out = await classifyItemsWithAi(batch, CATEGORIES);
    expect(out).toBeNull();
    expect(chatCompletion).toHaveBeenCalledTimes(2);
  });
});

describe("parseClassifyReply", () => {
  it("ignores out-of-range indices and missing confidence", () => {
    const out = parseClassifyReply(
      JSON.stringify({
        results: [
          { i: 0, name: "كهرباء", confidence: 90 },
          { i: 3, name: "أجهزة", confidence: 90 },
          { i: 1, name: "أجهزة" },
        ],
      }),
      2,
    );
    expect(out?.[0]).toEqual({
      main: "أجهزة",
      sub: [],
      brand: null,
      confidence: 0,
      attributes: null,
      reason: null,
    });
    expect(out?.[1]).toBeNull();
  });

  it("returns null for a non-JSON reply", () => {
    expect(parseClassifyReply("not json at all", 2)).toBeNull();
    expect(parseClassifyReply(null, 2)).toBeNull();
  });
});
