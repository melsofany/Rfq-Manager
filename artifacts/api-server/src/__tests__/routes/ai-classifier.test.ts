import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the provider seam (the classifier's only I/O) and the config gate.
const hoisted = vi.hoisted(() => ({ aiConfigured: true }));
const chatCompletion = vi.fn();
vi.mock("../../modules/ai-assistant/llm", () => ({
  chatCompletion: (...args: any[]) => chatCompletion(...args),
}));

vi.mock("../../modules/ai-assistant/config", () => ({
  DEFAULT_MODEL: "deepseek-v4-pro",
  get isAiConfigured() {
    return hoisted.aiConfigured;
  },
  loadSettings: async () => ({
    enabled: true,
    model: "deepseek-v4-pro",
    baseUrl: null,
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

import { classifyItemsWithAi, parseClassifyReply } from "../../modules/rfq/ai-classifier";

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
});

describe("AI item classifier", () => {
  it("maps the model's category CODE to the category id", async () => {
    chatCompletion.mockResolvedValue(
      reply({ results: [{ i: 1, code: "electrical", confidence: 88 }] }),
    );
    const out = await classifyItemsWithAi([{ description: "قاطع كهرباء 63A" }], CATEGORIES);
    expect(out).toEqual([{ categoryId: 3, confidence: 88, matchedTerm: "electrical" }]);
  });

  it("classifies a BATCH in one request, indexed by position", async () => {
    chatCompletion.mockResolvedValue(
      reply({
        results: [
          { i: 1, code: "equipment", confidence: 90 },
          { i: 2, code: "spare_parts", confidence: 70 },
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
      reply({ results: [{ i: 1, code: "غير معروف", confidence: 0 }] }),
    );
    const out = await classifyItemsWithAi([{ description: "ZZZ ???" }], CATEGORIES);
    expect(out).toEqual([null]);
  });

  it("REFUSES a code the model invented (not in the catalogue)", async () => {
    chatCompletion.mockResolvedValue(
      reply({ results: [{ i: 1, code: "plumbing", confidence: 95 }] }),
    );
    const out = await classifyItemsWithAi([{ description: "مواسير" }], CATEGORIES);
    expect(out).toEqual([null]);
  });

  it("tolerates a fenced code block around the JSON", async () => {
    chatCompletion.mockResolvedValue({
      content:
        'إليك النتيجة:\n```json\n{"results":[{"i":1,"code":"electrical","confidence":80}]}\n```',
      toolCalls: [],
      finishReason: "stop",
    });
    const out = await classifyItemsWithAi([{ description: "كابل" }], CATEGORIES);
    expect(out?.[0]?.categoryId).toBe(3);
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
});

describe("parseClassifyReply", () => {
  it("ignores out-of-range indices and missing confidence", () => {
    const out = parseClassifyReply(
      JSON.stringify({
        results: [
          { i: 0, code: "electrical", confidence: 90 },
          { i: 3, code: "equipment", confidence: 90 },
          { i: 1, code: "equipment" },
        ],
      }),
      2,
    );
    expect(out?.[0]).toEqual({ code: "equipment", confidence: 0 });
    expect(out?.[1]).toBeNull();
  });

  it("returns null for a non-JSON reply", () => {
    expect(parseClassifyReply("not json at all", 2)).toBeNull();
    expect(parseClassifyReply(null, 2)).toBeNull();
  });
});
