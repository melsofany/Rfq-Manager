import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Mastra engine must own the SAME four hardened behaviours as the legacy
 * loop, because those are the recorded fixes for the operator's reports
 * («بيعيد نفس البحث», the assistant going silent, a census abandoned mid-read).
 * A green bridge test (message/schema translation) says nothing about them, so
 * these tests drive the real `runToolLoop` against a scripted Mastra `Agent` and
 * assert the control flow, not the translation.
 */

const logCalls: Array<{ msg: string; meta: any }> = [];
vi.mock("../../shared/logger", () => ({
  logger: {
    info: (meta: any, msg: string) => logCalls.push({ msg, meta }),
    warn: (meta: any, msg: string) => logCalls.push({ msg, meta }),
    error: (meta: any, msg: string) => logCalls.push({ msg, meta }),
  },
}));

const executeTool = vi.fn();
vi.mock("../../modules/ai-assistant/tools", () => ({
  executeTool: (...args: any[]) => executeTool(...args),
  // Both tools are registered up front: a `vi.doMock` inside a test body does
  // not re-evaluate an already-imported module, so the resumable-census case
  // has to be reachable in the original definition.
  toolDefinitions: () => [
    {
      type: "function",
      function: {
        name: "count_database",
        description: "count rows",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "scan_email_items",
        description: "scan mail",
        parameters: { type: "object", properties: {} },
      },
    },
  ],
  asText: (d: unknown) => (typeof d === "string" ? d : JSON.stringify(d ?? null)),
}));

/** One scripted model round: the tool it calls and the observation it reports. */
interface ScriptedRound {
  tool: string;
  args: Record<string, unknown>;
  /** The observation string the tool result is surfaced as (drives TaskTrace). */
  result: string;
  thought?: string;
  /** When set, invoking the tool rejects — a provider/segment fault. */
  throws?: boolean;
}

let script: ScriptedRound[] = [];
let roundIdx = 0;
const agentsCreated: any[] = [];
const generateConvos: any[][] = [];
const generateMaxSteps: number[] = [];

/**
 * A scripted Mastra Agent. `generate` consumes one scripted round per step: it
 * invokes the REAL (dedup-wrapped) tool executor so `executeTool` call counts
 * are meaningful, then hands the engine a step whose observation is the
 * scripted result. When the script is exhausted — or when the agent has no
 * tools (the forced-answer turn) — it returns the final answer.
 */
vi.mock("@mastra/core/agent", () => ({
  Agent: class {
    opts: any;
    tools: any;
    constructor(opts: any) {
      this.opts = opts;
      this.tools = opts?.tools ?? {};
      agentsCreated.push(this);
    }
    async generate(convo: any[], options: any) {
      generateConvos.push(convo);
      generateMaxSteps.push(options?.maxSteps);
      const hasTools = !!this.opts?.tools;
      const steps: any[] = [];
      let text = "";

      if (hasTools) {
        const round = script[roundIdx++];
        if (round) {
          if (round.throws) throw new Error("provider exploded");
          const fn = this.tools[round.tool];
          if (fn) await fn.execute(round.args);
          steps.push({
            text: round.thought ?? `round ${roundIdx}`,
            toolCalls: [{ type: "tool-call", payload: { toolName: round.tool, args: round.args } }],
            toolResults: [
              { type: "tool-result", payload: { toolName: round.tool, result: round.result } },
            ],
          });
        } else {
          text = "تم";
        }
      } else {
        text = "الإجابة النهائية من الأدوات السابقة";
      }

      for (const s of steps) options?.onStepFinish?.(s);

      return {
        text,
        modelUsed: "gemini-3.6-flash",
        providerUsed: "gemini",
        steps,
        response: {
          messages: [
            { role: "user", content: "سؤال" },
            ...steps.flatMap((s) => [
              { role: "assistant", content: s.text, tool_calls: s.toolCalls },
              ...s.toolResults.map((r: any) => ({ role: "tool", content: r.payload.result })),
            ]),
            text
              ? { role: "assistant", content: text }
              : { role: "assistant", content: "", tool_calls: steps.at(-1)?.toolCalls ?? [] },
          ],
        },
      };
    }
  },
}));

vi.mock("@mastra/core/tools", () => ({ createTool: (t: any) => t }));

const { runToolLoop } = await import("../../modules/ai-assistant/mastra-agent");

const ctx: any = { settings: {}, phone: "201000000000", outbox: [] };

function run(maxRounds: number, budget = 150000) {
  return runToolLoop({
    model: "gemini-3.6-flash",
    messages: [{ role: "user", content: "سؤال" }] as any,
    ctx,
    maxRounds,
    signal: new AbortController().signal,
    phone: ctx.phone,
    remainingBudgetMs: budget,
  });
}

beforeEach(() => {
  logCalls.length = 0;
  agentsCreated.length = 0;
  generateConvos.length = 0;
  generateMaxSteps.length = 0;
  roundIdx = 0;
  script = [];
  executeTool.mockReset();
  executeTool.mockResolvedValue({ ok: true, data: { rows: 1 } });
});

describe("mastra loop: identical-call dedup", () => {
  it("runs an identical tool call once per run, not once per repeat", async () => {
    // The model issues the SAME call in two rounds. Without dedup that is two
    // executions of work already done — the recorded «بيعيد نفس البحث» report,
    // which burns the scarce daily quota.
    script = [
      { tool: "count_database", args: { table: "purchase_orders" }, result: "5" },
      { tool: "count_database", args: { table: "purchase_orders" }, result: "5" },
    ];

    const out = await run(4);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(out.finalText).toBe("تم");
  });

  it("treats a reordered argument object as the same call", async () => {
    script = [
      { tool: "count_database", args: { a: 1, b: 2 }, result: "5" },
      { tool: "count_database", args: { b: 2, a: 1 }, result: "5" },
    ];

    await run(4);

    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("does NOT memoize a resumable census, so a repeat returns the next batch", async () => {
    // A second identical `scan_email_items` call IS the resume operation; the
    // session cursor advanced, so memoizing it froze the model on batch one.
    executeTool.mockResolvedValueOnce({ ok: true, data: { scanned: 150, remainingMessages: 20 } });
    executeTool.mockResolvedValueOnce({ ok: true, data: { scanned: 170, remainingMessages: 0 } });
    script = [
      { tool: "scan_email_items", args: { mailbox: "info", limit: 150 }, result: "{}" },
      { tool: "scan_email_items", args: { mailbox: "info", limit: 150 }, result: "{}" },
    ];

    await run(4);

    expect(executeTool).toHaveBeenCalledTimes(2);
  });
});

describe("mastra loop: forced tool-free final round", () => {
  it("answers with the tools removed when the model never stops calling them", async () => {
    // Every tool round ends on a tool call. Without a forced tool-free turn the
    // run would end with no text — the operator's «مش بيبعت حاجة» silence.
    script = [
      { tool: "count_database", args: { n: 1 }, result: "1" },
      { tool: "count_database", args: { n: 2 }, result: "2" },
    ];

    const out = await run(1);

    expect(out.finalText).toBe("الإجابة النهائية من الأدوات السابقة");
    // The forced turn ran on an agent with NO tools: removing the schemas is
    // what the provider cannot ignore (tool_choice="none" alone was not enough).
    expect(agentsCreated.some((a) => !a.opts?.tools)).toBe(true);
    expect(logCalls.some((c) => c.msg === "AI assistant: task force")).toBe(true);
  });
});

describe("mastra loop: stuck steering", () => {
  it("steers the model instead of letting a repeatedly failing call loop", async () => {
    executeTool.mockResolvedValue({ ok: false, error: "bad args" });
    script = [
      { tool: "count_database", args: { bad: true }, result: "ERROR: bad args" },
      { tool: "count_database", args: { bad: true }, result: "ERROR: bad args" },
    ];

    await run(3);

    // A steering turn was pushed into the conversation the model then saw.
    const steered = generateConvos.some((convo) =>
      convo.some(
        (m: any) => typeof m.content === "string" && m.content.includes("غيّر الاستراتيجية"),
      ),
    );
    expect(steered).toBe(true);
    expect(logCalls.some((c) => c.msg === "AI assistant: task stuck")).toBe(true);
  });
});

describe("mastra loop: progress-based budget extension", () => {
  const pendingWork = '{"isComplete":false,"remainingMessages":300}';

  it("grants one extra round when a tool reports more work remains", async () => {
    // The resumable-census shape. The fixed budget used to abandon the census
    // mid-read; the extension is what lets it finish.
    script = [
      { tool: "count_database", args: { page: 1 }, result: pendingWork },
      { tool: "count_database", args: { page: 2 }, result: pendingWork },
      { tool: "count_database", args: { page: 3 }, result: "{}" },
    ];

    // maxRounds 1 => a granted extension is the ONLY way a second tool segment
    // runs; without it the run goes straight to the forced answer.
    await run(1);

    const toolSegments = generateConvos.filter((_, i) => generateMaxSteps[i] > 1).length;
    expect(toolSegments).toBeGreaterThanOrEqual(2);
    const extension = logCalls.find((c) => c.msg === "AI assistant: task extend");
    expect(extension?.meta?.reason).toBe("progress");
    expect(extension?.meta?.engine).toBe("mastra");
  });

  it("does NOT extend when the tools report no pending work", async () => {
    script = [
      { tool: "count_database", args: { n: 1 }, result: '{"rows":1}' },
      { tool: "count_database", args: { n: 2 }, result: '{"rows":1}' },
    ];

    await run(1);

    expect(logCalls.some((c) => c.msg === "AI assistant: task extend")).toBe(false);
  });

  it("does NOT extend when the remaining run budget cannot afford a round", async () => {
    script = [
      { tool: "count_database", args: { page: 1 }, result: pendingWork },
      { tool: "count_database", args: { page: 2 }, result: pendingWork },
    ];

    // Below EXTEND_MIN_REMAINING_MS (25s): a late round is worse than answering
    // with what we have, because the operator is waiting in a chat window.
    await run(1, 1000);

    expect(logCalls.some((c) => c.msg === "AI assistant: task extend")).toBe(false);
  });
});

describe("mastra loop: degraded but honest exit", () => {
  it("keeps the exchanges gathered when a tool segment throws", async () => {
    script = [
      { tool: "count_database", args: { page: 1 }, result: '{"isComplete":false}' },
      { tool: "count_database", args: { page: 2 }, result: "{}", throws: true },
    ];

    const out = await run(1);

    // The turn that succeeded is still in the ledger the caller verifies — a
    // mid-run fault must not discard what was already gathered.
    expect(out.exchanges.some((e) => e.name === "count_database")).toBe(true);
    expect(logCalls.some((c) => c.msg === "AI assistant: mastra segment failed")).toBe(true);
  });
});
