import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The unified engine must own the SAME four hardened behaviours the two loops
 * it replaced did, because those are the recorded fixes for the operator's
 * reports («بيعيد نفس البحث», the assistant going silent, a census abandoned
 * mid-read, and a provider fault losing gathered evidence):
 *
 *   1. identical-call dedup within a run;
 *   2. a forced tool-free final round;
 *   3. stuck steering after a repeatedly failing call;
 *   4. a progress-based budget extension for a resumable census.
 *
 * They are driven against a scripted `chatCompletion`, because that is now the
 * ONLY provider seam — the engine has no agent framework to mock, which is the
 * point of the refactor.
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
  // Both tools are registered up front so the resumable-census case is reachable
  // in the original definition (a `vi.doMock` inside a test body does not
  // re-evaluate an already-imported module).
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

/** One scripted model round: the tool it calls, or a final answer. */
interface ScriptedRound {
  tool?: string;
  args?: Record<string, unknown>;
  /** The observation string the tool result is surfaced as (drives TaskTrace). */
  result?: string;
  thought?: string;
  /** When set, the provider call rejects — an overloaded/faulted model. */
  throws?: boolean;
  /** When set, the round is the model's final answer (no tool calls). */
  answer?: string;
  /**
   * A reasoning model that exhausted its token budget on `reasoning_content`:
   * empty text with `finishReason:"length"`. Measured live on `deepseek-v4-pro`.
   */
  truncated?: boolean;
}

const chatCompletion = vi.fn();
vi.mock("../../modules/ai-assistant/llm", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    chatCompletion: (...args: any[]) => chatCompletion(...args),
  };
});

let script: ScriptedRound[] = [];
let roundIdx = 0;
const seenMessages: any[][] = [];
const toolChoices: string[] = [];

/**
 * Drive `chatCompletion` from the script: a round with a `tool` returns a
 * tool-call turn; a round with `answer` (or an exhausted script) returns text.
 * A `throws` round rejects.
 */
function installScriptedModel() {
  chatCompletion.mockImplementation((opts: any) => {
    seenMessages.push(opts.messages);
    toolChoices.push(String(opts.toolChoice));
    const round = script[roundIdx++];
    if (!round) return Promise.resolve({ content: "تم", toolCalls: [], finishReason: "stop" });
    // `toolChoice:"none"` forbids tool calls, exactly as a real provider would
    // honour it on the forced final round. A `truncated` round models a reasoning
    // model that spent its whole token budget thinking: empty text + `length`.
    if (opts.toolChoice === "none") {
      return Promise.resolve({
        content: round.truncated ? "" : (round.answer ?? round.thought ?? "تم"),
        toolCalls: [],
        finishReason: round.truncated ? "length" : "stop",
      });
    }
    if (round.throws) return Promise.reject(new Error("provider exploded"));
    if (round.truncated) {
      return Promise.resolve({ content: "", toolCalls: [], finishReason: "length" });
    }
    if (round.answer !== undefined || !round.tool) {
      return Promise.resolve({
        content: round.answer ?? "تم",
        toolCalls: [],
        finishReason: "stop",
      });
    }
    return Promise.resolve({
      content: round.thought ?? `round ${roundIdx}`,
      toolCalls: [
        {
          id: `call_${roundIdx}`,
          type: "function",
          function: { name: round.tool, arguments: JSON.stringify(round.args ?? {}) },
        },
      ],
      finishReason: "tool_calls",
      modelUsed: "gemini-3.6-flash",
      providerUsed: "gemini",
    });
  });
}

const { runToolLoop, engineName } = await import("../../modules/ai-assistant/engine");

describe("unified engine: the engine label is honest", () => {
  it("reports its real name, not a switch that no longer exists", async () => {
    // The startup log used to print `engine: "mastra"` from a ternary whose
    // condition had been reduced to a constant `true`, while the bundle carried
    // zero `@mastra` code. That label was believed during verification of the
    // reasoning-token fix and pointed it at the wrong loop. A log line that
    // describes something untrue is the same defect class as the census that
    // reported 0 attachments for a readable mailbox.
    expect(engineName()).toBe("unified");
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../index.ts", import.meta.url), "utf8"),
    );
    // The selection log must call the real accessor, never the vestigial one.
    expect(src).toContain("engine: engineName()");
    expect(src).not.toContain("mastraEngineEnabled()");
  });
});

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
  seenMessages.length = 0;
  toolChoices.length = 0;
  roundIdx = 0;
  script = [];
  executeTool.mockReset();
  executeTool.mockResolvedValue({ ok: true, data: { rows: 1 } });
  chatCompletion.mockReset();
  installScriptedModel();
});

describe("unified engine: identical-call dedup", () => {
  it("runs an identical tool call once per run, not once per repeat", async () => {
    // The model issues the SAME call in two rounds. Without dedup that is two
    // executions of work already done — the recorded «بيعيد نفس البحث» report,
    // which burns the scarce daily quota.
    script = [
      { tool: "count_database", args: { table: "purchase_orders" }, result: "5" },
      { tool: "count_database", args: { table: "purchase_orders" }, result: "5" },
      { answer: "العدد 5" },
    ];

    const out = await run(4);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(out.finalText).toBe("العدد 5");
  });

  it("treats a reordered argument object as the same call", async () => {
    script = [
      { tool: "count_database", args: { a: 1, b: 2 }, result: "5" },
      { tool: "count_database", args: { b: 2, a: 1 }, result: "5" },
      { answer: "تم" },
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
      { answer: "تم" },
    ];

    await run(4);

    expect(executeTool).toHaveBeenCalledTimes(2);
  });
});

describe("unified engine: forced tool-free final round", () => {
  it("forbids tool calls on the last round", async () => {
    // Every tool round ends on a tool call. Without forbidding tools on the final
    // round the run would end with no text — the operator's «مش بيبعت حاجة»
    // silence.
    script = [
      { tool: "count_database", args: { n: 1 }, result: "1" },
      { tool: "count_database", args: { n: 2 }, result: "2" },
    ];

    const out = await run(1);

    // The last round carried toolChoice "none", and the provider answered text.
    expect(toolChoices).toContain("none");
    expect(out.finalText).toBeTruthy();
  });
});

describe("unified engine: stuck steering", () => {
  it("steers the model instead of letting a repeatedly failing call loop", async () => {
    executeTool.mockResolvedValue({ ok: false, error: "bad args" });
    script = [
      { tool: "count_database", args: { bad: true }, result: "ERROR: bad args" },
      { tool: "count_database", args: { bad: true }, result: "ERROR: bad args" },
      { answer: "تم" },
    ];

    await run(3);

    // A steering turn was pushed into the conversation the model then saw.
    const steered = seenMessages.some((convo) =>
      convo.some(
        (m: any) => typeof m.content === "string" && m.content.includes("غيّر الاستراتيجية"),
      ),
    );
    expect(steered).toBe(true);
    expect(logCalls.some((c) => c.msg === "AI assistant: task stuck")).toBe(true);
  });
});

describe("unified engine: progress-based budget extension", () => {
  it("grants one extra round when a tool reports more work remains", async () => {
    // The resumable-census shape, driven through the REAL tool output: the
    // extension reads the observation, not the scripted prose. The fixed budget
    // used to abandon the census mid-read; the extension is what lets it finish.
    executeTool.mockResolvedValue({
      ok: true,
      data: { isComplete: false, remainingMessages: 300 },
    });
    script = [
      { tool: "count_database", args: { page: 1 }, result: "x" },
      { tool: "count_database", args: { page: 2 }, result: "x" },
      { tool: "count_database", args: { page: 3 }, result: "x" },
      { answer: "تم" },
    ];

    // maxRounds 2 => the last (forced) round is round 1. The extension is the
    // ONLY way a THIRD round runs, so its absence is what abandons the census.
    await run(2);

    const extension = logCalls.find((c) => c.msg === "AI assistant: task extend");
    expect(extension?.meta?.reason).toBe("progress");
    expect(extension?.meta?.engine).toBe("unified");
  });

  it("does NOT extend when the tools report no pending work", async () => {
    // Completed work is not progress: a model repeating a finished lookup has
    // failed to answer and must not be granted another day's quota on it.
    executeTool.mockResolvedValue({ ok: true, data: { isComplete: true } });
    script = [
      { tool: "count_database", args: { n: 1 }, result: "x" },
      { tool: "count_database", args: { n: 2 }, result: "x" },
      { answer: "تم" },
    ];

    await run(2);

    expect(logCalls.some((c) => c.msg === "AI assistant: task extend")).toBe(false);
  });

  it("does NOT extend when the remaining run budget cannot afford a round", async () => {
    executeTool.mockResolvedValue({
      ok: true,
      data: { isComplete: false, remainingMessages: 300 },
    });
    script = [
      { tool: "count_database", args: { page: 1 }, result: "x" },
      { tool: "count_database", args: { page: 2 }, result: "x" },
    ];

    // Below EXTEND_MIN_REMAINING_MS (25s): a late round is worse than answering
    // with what we have, because the operator is waiting in a chat window.
    await run(2, 1000);

    expect(logCalls.some((c) => c.msg === "AI assistant: task extend")).toBe(false);
  });
});

describe("unified engine: degraded but honest exit", () => {
  it("keeps the exchanges gathered when a provider round throws", async () => {
    script = [
      { tool: "count_database", args: { page: 1 }, result: '{"isComplete":false}' },
      { throws: true },
      { answer: "الإجابة من الأدوات السابقة" },
    ];

    const out = await run(4);

    // The turn that succeeded is still in the ledger the caller verifies — a
    // mid-run fault must not discard what was already gathered.
    expect(out.exchanges.some((e) => e.name === "count_database")).toBe(true);
    expect(
      logCalls.some(
        (c) => c.msg === "AI assistant: provider round failed, answering from the transcript",
      ),
    ).toBe(true);
    // And it still produced an answer rather than silence.
    expect(out.finalText).toBeTruthy();
  });
});

describe("unified engine: the engine's own trace is reported, not just logged", () => {
  it("returns a populated taskTrace so the dashboard sees the real run", async () => {
    script = [{ tool: "count_database", args: { a: 1 }, result: "5" }, { answer: "تم" }];

    const out = await run(3);

    expect(out.taskTrace.steps).toBeGreaterThan(0);
    expect(out.taskTrace.toolCalls).toBeGreaterThan(0);
    expect(out.taskTrace.distinctTools).toBeGreaterThan(0);
  });
});

describe("unified engine: provider-agnostic by construction", () => {
  it("never reaches for an agent framework — the provider seam is chatCompletion", async () => {
    // The whole point of the refactor: one loop over `chatCompletion`, so the
    // model chain, per-model quota memory, warm-model promotion and the
    // Gemini↔DeepSeek rescue all apply with no second implementation to drift.
    script = [{ tool: "count_database", args: { a: 1 }, result: "5" }, { answer: "تم" }];

    await run(3);

    // Every model call went through the provider layer.
    expect(chatCompletion).toHaveBeenCalled();
    const first = chatCompletion.mock.calls[0][0];
    expect(first.model).toBe("gemini-3.6-flash");
    expect(first.toolChoice).toBe("auto");
  });
});

describe("unified engine: a truncated answer is not an answer", () => {
  it("re-asks tool-free when the model spends its whole budget thinking", async () => {
    // The live failure: the model called its tool successfully, then returned an
    // empty turn (reasoning tokens ate `max_tokens`) — and the loop assigned that
    // empty string as the answer, so `finalText` was "" and the operator got
    // «نفدت محاولات المعالجة قبل الوصول لرد نهائي» on three consecutive tries.
    // The tool-free re-ask is genuinely different: fewer input tokens leave more
    // budget for the reply.
    script = [
      { tool: "scan_email_items", args: {}, result: "853 items" },
      { truncated: true },
      { answer: "أكثر بند تكراراً: WATER HEATER ARISTON (20 أمر)" },
    ];

    const out = await run(3);

    expect(out.finalText).toContain("WATER HEATER ARISTON");
  });

  it("does not report an empty turn as an answer", async () => {
    // Guards the assignment itself: with no re-ask available the result must be
    // null so the caller emits an honest notice, never "".
    script = [
      { tool: "scan_email_items", args: {}, result: "853 items" },
      { truncated: true },
      { truncated: true },
    ];

    const out = await run(3);

    expect(out.finalText).toBeNull();
  });

  it("retries an empty stop turn instead of treating it as a completed answer", async () => {
    // Some provider gateways label an intermittent empty completion as `stop`,
    // not `length`. It is still not an answer and must receive the same bounded
    // tool-free retry as a truncated reasoning turn.
    script = [
      { tool: "scan_email_items", args: {}, result: "853 items" },
      { answer: "" },
      { answer: "النتيجة مبنية على البيانات المقروءة." },
    ];

    const out = await run(3);

    expect(out.finalText).toBe("النتيجة مبنية على البيانات المقروءة.");
  });
});

describe("unified engine: the answer is always funded", () => {
  it("answers from the transcript instead of starting a round it cannot afford", async () => {
    // The recorded live failure: a scan took ~85s of the 150s run, so the next
    // completion could not be funded. The provider was called anyway, threw
    // «budget exhausted», and the retry threw identically — finalText stayed
    // null and the operator got the exhausted notice AFTER the mail was read.
    //
    // No sleep: the ctx deadline is already in the past, which is exactly the
    // state the run is in after an expensive tool returns.
    script = [{ tool: "count_database" }, { answer: "answer from evidence" }];
    // The tool round EATS the clock, exactly as the 85s scan did. Without this
    // the run still looks fresh and the gate would never be reached.
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    executeTool.mockImplementation(async () => {
      clock += 90_000;
      return { ok: true, data: { rows: 7 } };
    });
    try {
      const pastCtx: any = {
        settings: {},
        phone: ctx.phone,
        outbox: [],
        deadline: clock + 150_000,
      };
      const res = await runToolLoop({
        model: "gemini-3.6-flash",
        messages: [{ role: "user", content: "q" }] as any,
        ctx: pastCtx,
        maxRounds: 5,
        signal: new AbortController().signal,
        phone: ctx.phone,
        remainingBudgetMs: 150_000,
      });
      expect(res.finalText).toBe("answer from evidence");
      // Round 1 must NOT have been requested as a tool round: the run answered
      // with `toolChoice:"none"` instead of starting a round it cannot fund.
      expect(toolChoices).toEqual(["auto", "none"]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("passes its own deadline to the completion it does make", async () => {
    script = [{ answer: "ok" }];
    const withDeadline: any = {
      settings: {},
      phone: ctx.phone,
      outbox: [],
      deadline: Date.now() + 60_000,
    };
    await runToolLoop({
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "q" }] as any,
      ctx: withDeadline,
      maxRounds: 3,
      signal: new AbortController().signal,
      phone: ctx.phone,
      remainingBudgetMs: 150_000,
    });
    // Without a deadline the completion asks for its full allowance and throws on
    // a run that cannot fund it; with one it is clamped to the run's remainder.
    const deadline = chatCompletion.mock.calls[0]?.[0]?.deadlineMs;
    expect(typeof deadline).toBe("number");
    expect(deadline).toBeLessThanOrEqual(withDeadline.deadline);
  });
});
