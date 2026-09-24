import { describe, it, expect, vi, beforeEach } from "vitest";

// Mirrors MAX_TOOL_ROUNDS in agent.ts; imported lazily inside tests to avoid
// hoisting issues, so assert the two agree in one place.
const MAX_ROUNDS = 5;

// ── Mock the LLM so the loop is deterministic ────────────────────────────────
const chatCompletion = vi.fn();
const extractDocumentText = vi.fn(async (..._a: any[]): Promise<string | null> => null);
const transcribeAudio = vi.fn(async (..._a: any[]): Promise<string | null> => null);
vi.mock("../../modules/ai-assistant/llm", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatCompletion: (...args: any[]) => chatCompletion(...args),
  transcribeAudio,
  extractDocumentText,
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
  or: () => ({}),
  isNull: () => ({}),
  desc: () => ({}),
  asc: () => ({}),
  sql: Object.assign((..._a: any[]) => ({}), { join: (..._a: any[]) => ({}) }),
}));

// Memory is read on every turn (core memory) and written after it; stub the
// module so the loop tests stay focused on tool-calling behaviour.
vi.mock("../../modules/ai-assistant/memory", () => ({
  recallMemories: vi.fn(async () => []),
  renderMemoryBlock: () => "",
  distillMemories: vi.fn(async () => []),
}));

// The entity vocabulary is prefetched from the database before every answer.
// Stub it so the loop tests do not need the real table bindings, and so a case
// can control exactly what the "known names" list contains.
type Vocab = {
  suppliers: { id: number | null; name: string }[];
  customers: { id: number | null; name: string }[];
};
const entityVocabulary = vi.fn(async (): Promise<Vocab> => ({ suppliers: [], customers: [] }));
const findUnknownEntityNames = vi.fn((_t: string, _k: unknown) => [] as string[]);
vi.mock("../../modules/ai-assistant/db-tools", () => ({
  entityVocabulary: (...a: unknown[]) => entityVocabulary(...(a as [])),
  findUnknownEntityNames: (t: string, k: unknown) => findUnknownEntityNames(t, k),
}));

describe("AI assistant agent loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks() only clears recorded calls; queued `...Once` results would
    // survive into the next case and make an unrelated test see a tool call.
    chatCompletion.mockReset();
    inserts.length = 0;
    extractDocumentText.mockResolvedValue(null);
    // Default: no known names, and the name checker finds nothing — the loop
    // tests below exercise the number check. The name check is covered by the
    // dedicated suites (mirroring db-tools' real implementation).
    entityVocabulary.mockResolvedValue({ suppliers: [], customers: [] });
    findUnknownEntityNames.mockReturnValue([]);
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
    // Deliberately NOT an email-scoped question: the source-scope guard is a
    // separate behaviour (see the scope test below) and would append its own
    // notice here.
    const out = await runAgent({ phone: "2010", text: "اعمل تقرير مختصر" });
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

  it("reads a document and feeds the extracted text into the same turn", async () => {
    extractDocumentText.mockResolvedValue("بند ١: صمام ٣ بوصة — ١٢ قطعة — ٥٠٠ جنيه");
    chatCompletion.mockResolvedValue({
      content: "الملف يحتوي بندًا واحدًا.",
      finishReason: "stop",
      toolCalls: [],
    });

    const { runAgent } = await import("../../modules/ai-assistant/agent");
    const out = await runAgent({
      phone: "2010",
      text: "لخّص ده",
      document: { buffer: Buffer.from("pdf"), mimeType: "application/pdf", filename: "po.pdf" },
    });

    expect(out.reply).toBe("الملف يحتوي بندًا واحدًا.");
    expect(extractDocumentText).toHaveBeenCalledWith(
      expect.anything(),
      "application/pdf",
      null,
      "test-model",
    );
    // The contents must reach the model in the SAME user turn, or it would have
    // to guess at a file it cannot see.
    const msgs = chatCompletion.mock.calls[0][0].messages;
    const user = msgs.find((m: any) => m.role === "user");
    expect(String(user.content)).toContain("صمام ٣ بوصة");
    expect(String(user.content)).toContain("po.pdf");
  });

  it("keeps a long document from crowding out the question by capping the text", async () => {
    extractDocumentText.mockResolvedValue("X".repeat(100_000));
    chatCompletion.mockResolvedValue({ content: "ok", finishReason: "stop", toolCalls: [] });

    const { runAgent, MAX_DOCUMENT_CHARS } = await import("../../modules/ai-assistant/agent");
    await runAgent({
      phone: "2010",
      text: "?",
      document: { buffer: Buffer.from("pdf"), mimeType: "application/pdf" },
    });
    const msgs = chatCompletion.mock.calls[0][0].messages;
    const user = msgs.find((m: any) => m.role === "user");
    const xs = String(user.content).match(/X+/)?.[0].length ?? 0;
    expect(xs).toBeLessThanOrEqual(MAX_DOCUMENT_CHARS);
  });

  it("does not claim to have read a document it could not extract", async () => {
    extractDocumentText.mockResolvedValue(null);
    chatCompletion.mockResolvedValue({ content: "تمام", finishReason: "stop", toolCalls: [] });

    const { runAgent } = await import("../../modules/ai-assistant/agent");
    await runAgent({
      phone: "2010",
      document: {
        buffer: Buffer.from("x"),
        mimeType: "application/octet-stream",
        filename: "b.bin",
      },
    });
    const msgs = chatCompletion.mock.calls[0][0].messages;
    const user = msgs.find((m: any) => m.role === "user");
    // The model is told the file could not be read instead of being asked about
    // an empty document.
    expect(String(user.content)).toContain("تعذّر قراءة الملف");
  });

  it("keeps the extracted text out of the stored history", async () => {
    extractDocumentText.mockResolvedValue("سري جدا: تكلفة ١٢٣");
    chatCompletion.mockResolvedValue({ content: "ok", finishReason: "stop", toolCalls: [] });

    const { runAgent } = await import("../../modules/ai-assistant/agent");
    await runAgent({
      phone: "2010",
      text: "لخّص",
      document: { buffer: Buffer.from("pdf"), mimeType: "application/pdf", filename: "po.pdf" },
    });
    const userRow = inserts.find((r: any) => r.role === "user");
    expect(userRow.content).toContain("po.pdf");
    expect(userRow.content).not.toContain("سري جدا");
  });

  // ── Tool-call deduplication (quota savings) ────────────────────────────────
  describe("identical tool calls in one run", () => {
    it("executes an identical (tool, args) call only ONCE", async () => {
      // The model re-issuing the same search when the first result did not match
      // its expectation used to spend another scarce round (Gemini free tier is
      // 20 requests/day/model) on work already done.
      const same = {
        id: "c",
        type: "function",
        function: { name: "search_database", arguments: '{"table":"suppliers","search":"النور"}' },
      };
      chatCompletion
        .mockResolvedValueOnce({ content: null, finishReason: "tool_calls", toolCalls: [same] })
        .mockResolvedValueOnce({
          content: null,
          finishReason: "tool_calls",
          toolCalls: [{ ...same, id: "c2" }],
        })
        .mockResolvedValueOnce({ content: "تم.", finishReason: "stop", toolCalls: [] });
      executeTool.mockResolvedValue({ ok: true, data: { count: 1 } });

      const { runAgent } = await import("../../modules/ai-assistant/agent");
      const out = await runAgent({ phone: "2010", text: "?" });

      expect(out.reply).toBe("تم.");
      expect(executeTool).toHaveBeenCalledTimes(1);
      // The repeated call still gets an answer in the transcript, so the model
      // sees a result for every tool_call_id it emitted.
      const toolMsgs = chatCompletion.mock.calls[2][0].messages.filter(
        (m: any) => m.role === "tool",
      );
      expect(toolMsgs).toHaveLength(2);
      expect(toolMsgs[1].content).toBe(toolMsgs[0].content);
    });

    it("treats argument key order as the same call", async () => {
      const call = (args: string, id: string) => ({
        id,
        type: "function",
        function: { name: "scan_emails", arguments: args },
      });
      chatCompletion
        .mockResolvedValueOnce({
          content: null,
          finishReason: "tool_calls",
          toolCalls: [call('{"from":"edc","limit":50}', "a")],
        })
        .mockResolvedValueOnce({
          content: null,
          finishReason: "tool_calls",
          toolCalls: [call('{"limit":50,"from":"edc"}', "b")],
        })
        .mockResolvedValueOnce({ content: "تم.", finishReason: "stop", toolCalls: [] });
      executeTool.mockResolvedValue({ ok: true, data: { matched: 0 } });

      const { runAgent, toolCacheKey } = await import("../../modules/ai-assistant/agent");
      await runAgent({ phone: "2010", text: "?" });

      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(toolCacheKey("scan_emails", { a: 1, b: 2 })).toBe(
        toolCacheKey("scan_emails", { b: 2, a: 1 }),
      );
    });

    it("still runs two calls that only differ in one argument", async () => {
      const call = (args: string, id: string) => ({
        id,
        type: "function",
        function: { name: "search_database", arguments: args },
      });
      chatCompletion
        .mockResolvedValueOnce({
          content: null,
          finishReason: "tool_calls",
          toolCalls: [call('{"table":"suppliers"}', "a")],
        })
        .mockResolvedValueOnce({
          content: null,
          finishReason: "tool_calls",
          toolCalls: [call('{"table":"customers"}', "b")],
        })
        .mockResolvedValueOnce({ content: "تم.", finishReason: "stop", toolCalls: [] });
      executeTool.mockResolvedValue({ ok: true, data: { rows: [] } });

      const { runAgent } = await import("../../modules/ai-assistant/agent");
      await runAgent({ phone: "2010", text: "?" });

      expect(executeTool).toHaveBeenCalledTimes(2);
    });
  });

  // ── Deterministic grounding verification (generator → critic) ───────────────
  describe("grounding verification", () => {
    it("corrects an answer that cites a number no tool returned", async () => {
      const call = {
        id: "c1",
        type: "function",
        function: {
          name: "lookup_document",
          arguments: '{"type":"customer_rfq","number":"26R011936"}',
        },
      };
      chatCompletion
        .mockResolvedValueOnce({ content: null, finishReason: "tool_calls", toolCalls: [call] })
        // The draft invents 26R099999, which never appeared in any tool result.
        .mockResolvedValueOnce({
          content: "الطلب 26R099999 موجود في النظام.",
          finishReason: "stop",
          toolCalls: [],
        })
        // Verification round returns the corrected answer.
        .mockImplementationOnce((args: any) => {
          const instruction = args.messages[args.messages.length - 1];
          expect(instruction.role).toBe("user");
          expect(String(instruction.content)).toContain("26R099999");
          expect(args.toolChoice).toBe("none");
          return Promise.resolve({
            content: "لا يوجد طلب آخر بهذا الرقم.",
            finishReason: "stop",
            toolCalls: [],
          });
        });
      executeTool.mockResolvedValue({ ok: true, data: { found: true, rfq: { id: 7 } } });

      const { runAgent } = await import("../../modules/ai-assistant/agent");
      const out = await runAgent({ phone: "2010", text: "?" });

      expect(out.reply).toBe("لا يوجد طلب آخر بهذا الرقم.");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ ungrounded: ["26R099999"] }),
        expect.stringContaining("absent from every tool result"),
      );
    });

    it("does NOT challenge a number that a tool really returned", async () => {
      const call = {
        id: "c1",
        type: "function",
        function: { name: "scan_emails", arguments: "{}" },
      };
      chatCompletion
        .mockResolvedValueOnce({ content: null, finishReason: "tool_calls", toolCalls: [call] })
        .mockResolvedValueOnce({
          content: "وصل الطلب 26R011936 وهو مسجل.",
          finishReason: "stop",
          toolCalls: [],
        });
      executeTool.mockResolvedValue({ ok: true, data: { numbers: ["26R011936"] } });

      const { runAgent } = await import("../../modules/ai-assistant/agent");
      const out = await runAgent({ phone: "2010", text: "?" });

      expect(out.reply).toBe("وصل الطلب 26R011936 وهو مسجل.");
      // Exactly one tool round + one answer round: no verification request.
      expect(chatCompletion).toHaveBeenCalledTimes(2);
    });

    it("accepts a number the operator themselves stated", async () => {
      chatCompletion.mockResolvedValueOnce({
        content: "تمام، 26R055555 في الطلب.",
        finishReason: "stop",
        toolCalls: [],
      });
      const { runAgent } = await import("../../modules/ai-assistant/agent");
      const out = await runAgent({ phone: "2010", text: "افتكر إن رقم الطلب 26R055555" });
      expect(out.reply).toBe("تمام، 26R055555 في الطلب.");
      expect(chatCompletion).toHaveBeenCalledTimes(1);
    });

    it("keeps the draft when the verification round fails", async () => {
      chatCompletion
        .mockResolvedValueOnce({
          content: "الرقم 99X12345.",
          finishReason: "stop",
          toolCalls: [],
        })
        .mockRejectedValueOnce(new Error("provider down"));
      const { runAgent } = await import("../../modules/ai-assistant/agent");
      const out = await runAgent({ phone: "2010", text: "?" });
      // Losing a good reply to an unavailable verifier is not acceptable.
      expect(out.reply).toBe("الرقم 99X12345.");
    });

    it("classifies document ids and ignores money/quantities", async () => {
      const { findGroundingNumbers, findUngroundedNumbers } =
        await import("../../modules/ai-assistant/agent");
      expect(findGroundingNumbers("الطلب 26R011936 بمبلغ 1,234.50 جنيه")).toEqual(["26R011936"]);
      expect(findGroundingNumbers("أمر P26E13477 و INV-2026-000045")).toEqual([
        "P26E13477",
        "INV-2026-000045",
      ]);
      // A bare quantity/amount/year is never a document to challenge.
      expect(findGroundingNumbers("12 قطعة بقيمة 5000 و 2026")).toEqual([]);

      const grounded = new Set(["26R011936"]);
      expect(findUngroundedNumbers("الطلب 26R011936", grounded)).toEqual([]);
      // Quoting the suffix of a grounded id is fine.
      expect(findUngroundedNumbers("الطلب 011936", grounded)).toEqual([]);
      // An EXTENDED id is not the id the tool returned.
      expect(findUngroundedNumbers("الطلب 26R0119367", grounded)).toEqual(["26R0119367"]);
      expect(findUngroundedNumbers("الطلب 26R099999", grounded)).toEqual(["26R099999"]);
    });
  });

  // ── Entity-name grounding (the «هاي فولت» lesson) ───────────────────────────
  describe("name grounding", () => {
    it("corrects an answer that names a supplier the system does not have", async () => {
      entityVocabulary.mockResolvedValue({
        suppliers: [{ id: 167, name: "هاي فولت" }],
        customers: [],
      });
      findUnknownEntityNames.mockReturnValue(["شركة النور"]);
      chatCompletion
        .mockResolvedValueOnce({
          content: "أمر الشراء 37 خاص بشركة النور للتوريدات.",
          finishReason: "stop",
          toolCalls: [],
        })
        .mockImplementationOnce((args: any) => {
          const instruction = args.messages[args.messages.length - 1];
          expect(String(instruction.content)).toContain("شركة النور");
          expect(String(instruction.content)).toContain("قوائم النظام");
          return Promise.resolve({
            content: "أمر الشراء 37 خاص بهاي فولت.",
            finishReason: "stop",
            toolCalls: [],
          });
        });

      const { runAgent } = await import("../../modules/ai-assistant/agent");
      const out = await runAgent({ phone: "2010", text: "أمر شراء 37 لمين؟" });

      expect(out.reply).toBe("أمر الشراء 37 خاص بهاي فولت.");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ unknownNames: ["شركة النور"] }),
        expect.stringContaining("absent from every tool result"),
      );
    });

    it("injects the real supplier vocabulary into the system prompt", async () => {
      entityVocabulary.mockResolvedValue({
        suppliers: [{ id: 167, name: "هاي فولت" }],
        customers: [{ id: 4, name: "المصرية للحفر" }],
      });
      chatCompletion.mockResolvedValueOnce({ content: "تم.", finishReason: "stop", toolCalls: [] });

      const { runAgent } = await import("../../modules/ai-assistant/agent");
      await runAgent({ phone: "2010", text: "?" });

      const system = chatCompletion.mock.calls[0][0].messages[0];
      expect(String(system.content)).toContain("هاي فولت");
      expect(String(system.content)).toContain("المصرية للحفر");
      expect(String(system.content)).toContain("لا تخترع اسمًا");
    });
  });

  // ── Premature refusal re-ask ────────────────────────────────────────────────
  describe("premature refusal", () => {
    it("re-asks once when the model gives up without searching", async () => {
      chatCompletion
        .mockResolvedValueOnce({
          content: "لا يوجد مورد بهذا الاسم.",
          finishReason: "stop",
          toolCalls: [],
        })
        .mockImplementationOnce((args: any) => {
          const instruction = args.messages[args.messages.length - 1];
          expect(String(instruction.content)).toContain("لا تُنهِ الرد قبل أن تحاول");
          return Promise.resolve({
            content: "بحثت في جدول الموردين باسم «النور» ولم أجد نتيجة.",
            finishReason: "stop",
            toolCalls: [],
          });
        });
      const { runAgent } = await import("../../modules/ai-assistant/agent");
      const out = await runAgent({ phone: "2010", text: "فين مورد النور؟" });

      expect(chatCompletion).toHaveBeenCalledTimes(2);
      expect(out.reply).toContain("بحثت في جدول الموردين");
    });

    it("does NOT re-ask an answer that already carries data", async () => {
      chatCompletion.mockResolvedValueOnce({
        content: "لم أجد طلبات جديدة، ويوجد 12 بندًا مسجلًا في الأمر.",
        finishReason: "stop",
        toolCalls: [],
      });
      const { runAgent } = await import("../../modules/ai-assistant/agent");
      await runAgent({ phone: "2010", text: "?" });
      // A concrete count means the model did real work; the «لم أجد» clause must
      // not be read as a bare refusal and re-asked.
      expect(chatCompletion).toHaveBeenCalledTimes(1);
    });

    it("re-asks at most once even if the model keeps refusing", async () => {
      chatCompletion.mockResolvedValue({
        content: "لا توجد نتائج.",
        finishReason: "stop",
        toolCalls: [],
      });
      const { runAgent } = await import("../../modules/ai-assistant/agent");
      const out = await runAgent({ phone: "2010", text: "?" });
      expect(out.reply).toBe("لا توجد نتائج.");
      // 1 draft + 1 re-ask only.
      expect(chatCompletion).toHaveBeenCalledTimes(2);
    });

    it("classifies refusal language without misfiring on ordinary prose", async () => {
      const { isRefusalSentence } = await import("../../modules/ai-assistant/agent");
      expect(isRefusalSentence("لا يوجد مورد بهذا الاسم")).toBe(true);
      expect(isRefusalSentence("لم أجد نتائج في البريد")).toBe(true);
      expect(isRefusalSentence("هذه المعلومة غير متوفرة حاليًا")).toBe(true);
      expect(isRefusalSentence("no results found")).toBe(true);
      // Data-bearing prose is not a refusal.
      expect(isRefusalSentence("الطلب 26R011936 مسجل في النظام")).toBe(false);
      expect(isRefusalSentence("يوجد 12 بندًا في الأمر")).toBe(false);
    });
  });

  // ── Router integration: the path decides the round budget ──────────────────
  describe("router-driven budget", () => {
    it("caps a simple document lookup at the FAST path's rounds", async () => {
      // A fast-path question must not be allowed to run for the deep budget.
      // The model here keeps calling tools; the loop must still stop at the fast
      // ceiling (2), not the deep one (5).
      let rounds = 0;
      chatCompletion.mockImplementation((args: any) => {
        rounds += 1;
        // Behave like a real model: on the tool-forbidding final round it
        // answers instead of calling another tool.
        if (args.toolChoice === "none") {
          return Promise.resolve({ content: "تم.", finishReason: "stop", toolCalls: [] });
        }
        return Promise.resolve({
          content: null,
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "c" + rounds,
              type: "function",
              function: { name: "lookup_document", arguments: "{}" },
            },
          ],
        });
      });
      executeTool.mockResolvedValue({ ok: true, data: { found: true } });

      const { runAgent } = await import("../../modules/ai-assistant/agent");
      const { FAST_MAX_ROUNDS } = await import("../../modules/ai-assistant/router");
      await runAgent({ phone: "2010", text: "أمر الشراء P26E11407 تبع مين؟" });
      expect(rounds).toBe(FAST_MAX_ROUNDS);
    });

    it("lets an analytical question use the full deep budget", async () => {
      let rounds = 0;
      chatCompletion.mockImplementation((args: any) => {
        rounds += 1;
        if (args.toolChoice === "none") {
          return Promise.resolve({ content: "تم.", finishReason: "stop", toolCalls: [] });
        }
        return Promise.resolve({
          content: null,
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "c" + rounds,
              type: "function",
              function: { name: "search_database", arguments: "{}" },
            },
          ],
        });
      });
      executeTool.mockResolvedValue({ ok: true, data: { rows: [] } });

      const { runAgent } = await import("../../modules/ai-assistant/agent");
      const { DEEP_MAX_ROUNDS } = await import("../../modules/ai-assistant/router");
      await runAgent({ phone: "2010", text: "اعمل حصر لكل PO في البريد خلال 2026" });
      expect(rounds).toBe(DEEP_MAX_ROUNDS);
    });

    it("does not spend a verification round on a plain greeting", async () => {
      // A greeting has no facts, so the router turns verification off and the
      // model gets exactly one round.
      chatCompletion.mockResolvedValueOnce({
        content: "وعليكم السلام! اسألني عن أي شيء.",
        finishReason: "stop",
        toolCalls: [],
      });
      const { runAgent } = await import("../../modules/ai-assistant/agent");
      const out = await runAgent({ phone: "2010", text: "السلام عليكم" });
      expect(out.reply).toContain("وعليكم السلام");
      expect(chatCompletion).toHaveBeenCalledTimes(1);
    });
  });

  // ── Telemetry ──────────────────────────────────────────────────────────────
  describe("source-scope enforcement", () => {
    it("labels an email-scoped question that was answered from the database", async () => {
      // «من الميل مش قاعدة البيانات» is a CONSTRAINT on the source. A run that
      // never read the mailbox answered about a different dataset, so the reply
      // must say so rather than pass itself off as the requested census.
      chatCompletion.mockResolvedValueOnce({
        content: "لا توجد أوامر شراء.",
        finishReason: "stop",
        toolCalls: [],
      });
      const { runAgent } = await import("../../modules/ai-assistant/agent");
      const out = await runAgent({
        phone: "2010",
        text: "هات أوامر الشراء الواردة من الميل مش قاعدة البيانات",
      });
      expect(out.reply).toContain("البريد الإلكتروني");
      expect(out.reply).toContain("النظام الداخلي");
    });

    it("does NOT add the warning when an email tool actually ran", async () => {
      chatCompletion
        .mockResolvedValueOnce({
          content: null,
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "search_emails", arguments: '{"query":"EDC PO"}' },
            },
          ],
        })
        .mockResolvedValueOnce({ content: "وجدت 12 رسالة.", finishReason: "stop", toolCalls: [] });
      executeTool.mockResolvedValue({ ok: true, data: { results: [] } });
      const { runAgent } = await import("../../modules/ai-assistant/agent");
      const out = await runAgent({ phone: "2010", text: "أوامر الشراء من البريد" });
      expect(out.reply).not.toContain("لم يُقرأ البريد");
    });
  });

  describe("request metrics", () => {
    it("records the intent, path, rounds and outcome for an answer", async () => {
      const { resetMetrics, recentMetrics } = await import("../../modules/ai-assistant/metrics");
      resetMetrics();
      chatCompletion.mockResolvedValueOnce({
        content: "أمر الشراء P26E11407 تبع هاي فولت.",
        finishReason: "stop",
        toolCalls: [],
      });
      const { runAgent } = await import("../../modules/ai-assistant/agent");
      await runAgent({ phone: "2010", text: "أمر الشراء P26E11407 تبع مين؟" });

      const [m] = recentMetrics(1);
      expect(m.intent).toBe("document_lookup");
      expect(m.path).toBe("fast");
      expect(m.outcome).toBe("answered");
      expect(m.rounds).toBe(1);
      expect(m.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("records a failed run with its outcome before rethrowing", async () => {
      const { resetMetrics, recentMetrics } = await import("../../modules/ai-assistant/metrics");
      resetMetrics();
      chatCompletion.mockRejectedValue(new Error("LLM request budget exhausted"));
      const { runAgent } = await import("../../modules/ai-assistant/agent");
      await expect(runAgent({ phone: "2010", text: "كام أمر شراء؟" })).rejects.toThrow();
      const [m] = recentMetrics(1);
      expect(m.outcome).toBe("timeout");
      expect(m.intent).toBe("count_aggregate");
    });

    it("records the evidence level of a tool-backed answer", async () => {
      const { resetMetrics, recentMetrics } = await import("../../modules/ai-assistant/metrics");
      resetMetrics();
      chatCompletion.mockResolvedValueOnce({
        content: "عدد أوامر الشراء 5.",
        finishReason: "stop",
        toolCalls: [],
      });
      const { runAgent } = await import("../../modules/ai-assistant/agent");
      await runAgent({ phone: "2010", text: "كام أمر شراء؟" });
      const [m] = recentMetrics(1);
      // No tool ran and nothing was reconciled, so the reply is a verified
      // absence of data rather than a weak answer.
      expect(m.confidence).toBe("VERIFIED");
    });

    it("downgrades the evidence level when a grounding correction was needed", async () => {
      const metrics = await import("../../modules/ai-assistant/metrics");
      metrics.resetMetrics();
      // A first draft that cites a document number no tool produced is what the
      // verifier rewrites — and a corrected answer must read as
      // PARTIALLY_VERIFIED on the dashboard, not as a clean reply.
      const call = {
        id: "c1",
        type: "function",
        function: {
          name: "lookup_document",
          arguments: '{"type":"customer_rfq","number":"26R011936"}',
        },
      };
      chatCompletion
        .mockResolvedValueOnce({ content: null, finishReason: "tool_calls", toolCalls: [call] })
        .mockResolvedValueOnce({
          content: "الطلب 26R099999 موجود في النظام.",
          finishReason: "stop",
          toolCalls: [],
        })
        .mockResolvedValueOnce({
          content: "لا يوجد طلب آخر بهذا الرقم.",
          finishReason: "stop",
          toolCalls: [],
        });
      executeTool.mockResolvedValue({ ok: true, data: { found: true, rfq: { id: 7 } } });
      const { runAgent } = await import("../../modules/ai-assistant/agent");
      await runAgent({ phone: "2010", text: "?" });
      const [m] = metrics.recentMetrics(1);
      expect(m.confidence).toBe("PARTIALLY_VERIFIED");
    });
  });
});
