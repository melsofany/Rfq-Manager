import { describe, it, expect, vi, beforeEach } from "vitest";

// Mirrors MAX_TOOL_ROUNDS in agent.ts; imported lazily inside tests to avoid
// hoisting issues, so assert the two agree in one place.
const MAX_ROUNDS = 5;

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

const warn = vi.fn();
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: (...a: any[]) => warn(...a), error: vi.fn() },
}));

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

  it("echoes Gemini's thought_signature back on the assistant tool-call turn", async () => {
    const call = {
      id: "c1",
      type: "function",
      function: { name: "search_database", arguments: '{"table":"suppliers"}' },
      extra_content: { google: { thought_signature: "SIG-ABC" } },
    };
    chatCompletion
      .mockResolvedValueOnce({ content: null, finishReason: "tool_calls", toolCalls: [call] })
      .mockImplementationOnce((args: any) => {
        const assistant = args.messages.find((m: any) => m.role === "assistant" && m.tool_calls);
        expect(assistant.tool_calls[0].extra_content.google.thought_signature).toBe("SIG-ABC");
        return Promise.resolve({ content: "تم.", finishReason: "stop", toolCalls: [] });
      });

    executeTool.mockResolvedValue({ ok: true, data: { count: 1 } });
    const { runAgent } = await import("../../modules/ai-assistant/agent");
    const out = await runAgent({ phone: "2010", text: "?" });
    expect(out.reply).toBe("تم.");
  });

  it("keeps the round budget asserted against the source constant", async () => {
    const { MAX_TOOL_ROUNDS } = await import("../../modules/ai-assistant/agent");
    expect(MAX_TOOL_ROUNDS).toBe(MAX_ROUNDS);
  });

  it("forbids tool calls on the final round so a tool-happy model still answers", async () => {
    // Reproduces the live failure: the model calls tools every round and, with
    // no forced-answer round, the loop ends with no text at all.
    const call = (n: number) => ({
      id: "c" + n,
      type: "function",
      function: { name: "search_database", arguments: "{}" },
    });
    let round = 0;
    chatCompletion.mockImplementation((args: any) => {
      round++;
      if (round < MAX_ROUNDS) {
        return Promise.resolve({
          content: null,
          finishReason: "tool_calls",
          toolCalls: [call(round)],
        });
      }
      // Final round: tool_choice must be "none", and the model answers.
      expect(args.toolChoice).toBe("none");
      return Promise.resolve({ content: "تقرير مختصر.", finishReason: "stop", toolCalls: [] });
    });
    executeTool.mockResolvedValue({ ok: true, data: { rows: [] } });

    const { runAgent } = await import("../../modules/ai-assistant/agent");
    const out = await runAgent({ phone: "2010", text: "هات ملف من الايميل" });
    expect(out.reply).toBe("تقرير مختصر.");
    // The first rounds must still allow tools.
    expect(chatCompletion.mock.calls[0][0].toolChoice).toBe("auto");
    expect(chatCompletion).toHaveBeenCalledTimes(MAX_ROUNDS);
  });

  it("retries without tool schemas when the model ignores tool_choice=none", async () => {
    // Gemini was observed returning tool calls even under tool_choice "none".
    // The final round must then drop the schemas entirely and get text.
    chatCompletion.mockImplementation((args: any) => {
      const forced = args.toolChoice === "none";
      if (forced && args.tools) {
        return Promise.resolve({
          content: null,
          finishReason: "tool_calls",
          toolCalls: [
            { id: "z", type: "function", function: { name: "search_database", arguments: "{}" } },
          ],
        });
      }
      if (forced) {
        // Schemas omitted: now it must produce text.
        expect(args.tools).toBeUndefined();
        return Promise.resolve({
          content: "تم إرسال ملف PDF.",
          finishReason: "stop",
          toolCalls: [],
        });
      }
      return Promise.resolve({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          { id: "a", type: "function", function: { name: "search_emails", arguments: "{}" } },
        ],
      });
    });
    executeTool.mockResolvedValue({ ok: true, data: { emails: [] } });

    const { runAgent } = await import("../../modules/ai-assistant/agent");
    const out = await runAgent({ phone: "2010", text: "?" });

    expect(out.reply).toBe("تم إرسال ملف PDF.");
    // The ignored last-round call is NOT executed.
    const names = executeTool.mock.calls.map((c) => c[0]);
    expect(names).not.toContain("search_database");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ providerToolChoiceIgnored: true }),
      "AI assistant: model ignored tool_choice=none on the final round",
    );
  });

  it("names the tools it did run when even the no-tools retry yields nothing", async () => {
    chatCompletion.mockResolvedValue({
      content: null,
      finishReason: "tool_calls",
      toolCalls: [
        { id: "x", type: "function", function: { name: "search_database", arguments: "{}" } },
      ],
    });
    executeTool.mockResolvedValue({ ok: false, error: "nope" });
    const { runAgent } = await import("../../modules/ai-assistant/agent");
    const out = await runAgent({ phone: "2010", text: "?" });
    expect(out.reply).toContain("search_database");
    expect(out.reply).toContain("نفدت محاولات المعالجة");
  });
});
