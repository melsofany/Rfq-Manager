import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the LLM so the loop is deterministic ────────────────────────────────
const chatCompletion = vi.fn();
vi.mock("../../modules/ai-assistant/llm", () => ({
  chatCompletion: (...args: any[]) => chatCompletion(...args),
  transcribeAudio: vi.fn(async () => null),
}));

// ── Mock tools so execution is observable ────────────────────────────────────
const executeTool = vi.fn();
vi.mock("../../modules/ai-assistant/tools", () => ({
  toolDefinitions: () => [
    { type: "function", function: { name: "search_database", description: "", parameters: {} } },
  ],
  executeTool: (...args: any[]) => executeTool(...args),
  asText: (d: unknown) => JSON.stringify(d),
}));

vi.mock("../../modules/ai-assistant/config", async () => {
  const actual = await vi.importActual<any>("../../modules/ai-assistant/config");
  return {
    ...actual,
    loadSettings: vi.fn(async () => ({
      enabled: true,
      model: "test-model",
      baseUrl: null,
      systemPrompt: null,
      language: "ar",
      allowEmail: true,
      allowDatabase: true,
      allowPdf: true,
    })),
  };
});

// ── Mock DB persistence ──────────────────────────────────────────────────────
const table = { _: "aiMessages" };
const inserts: any[] = [];
vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
    }),
    insert: () => ({
      values: (v: any) => {
        inserts.push(v);
        return Promise.resolve();
      },
    }),
    delete: () => ({ where: () => Promise.resolve() }),
  },
  aiAssistantMessagesTable: table,
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  desc: () => ({}),
}));

describe("AI assistant agent loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inserts.length = 0;
  });

  it("executes a tool call and returns the final answer", async () => {
    chatCompletion
      .mockResolvedValueOnce({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "search_database", arguments: '{"table":"purchase_orders"}' },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: "يوجد 3 أوامر شراء.",
        finishReason: "stop",
        toolCalls: [],
      });

    executeTool.mockResolvedValue({ ok: true, data: { count: 3 } });

    const { runAgent } = await import("../../modules/ai-assistant/agent");
    const out = await runAgent({ phone: "2010", text: "كم عدد أوامر الشراء؟" });

    expect(out.reply).toBe("يوجد 3 أوامر شراء.");
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][0]).toBe("search_database");
    expect(executeTool.mock.calls[0][1]).toEqual({ table: "purchase_orders" });
    // user + assistant turns persisted
    expect(inserts).toHaveLength(2);
    expect(inserts[0].role).toBe("user");
    expect(inserts[1].role).toBe("assistant");
  });

  it("answers directly when the model calls no tools", async () => {
    chatCompletion.mockResolvedValueOnce({
      content: "مرحبًا!",
      finishReason: "stop",
      toolCalls: [],
    });
    const { runAgent } = await import("../../modules/ai-assistant/agent");
    const out = await runAgent({ phone: "2010", text: "مرحبا" });
    expect(out.reply).toBe("مرحبًا!");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("feeds tool errors back to the model", async () => {
    chatCompletion
      .mockResolvedValueOnce({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          { id: "c1", type: "function", function: { name: "search_database", arguments: "{}" } },
        ],
      })
      .mockImplementationOnce((args: any) => {
        const toolMsg = args.messages.find((m: any) => m.role === "tool");
        expect(toolMsg.content).toContain("ERROR");
        return Promise.resolve({ content: "تعذّر الوصول.", finishReason: "stop", toolCalls: [] });
      });

    executeTool.mockResolvedValue({ ok: false, error: "Unknown table" });
    const { runAgent } = await import("../../modules/ai-assistant/agent");
    const out = await runAgent({ phone: "2010", text: "?" });
    expect(out.reply).toBe("تعذّر الوصول.");
  });
});
