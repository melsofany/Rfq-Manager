import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Runtime proof that the Mastra engine actually drives a REAL Mastra `Agent`
 * through the REAL `CortobaLanguageModel` and the REAL `chatCompletion` chain.
 *
 * The other mastra suites mock `@mastra/core/agent`, so they prove the control
 * flow but NOT that Mastra accepts our model bridge, our JSON-schema tool
 * definitions and our message shapes at runtime. That integration is exactly
 * where a bridge mismatch would surface, so here Mastra is NOT mocked — only the
 * provider HTTP call is, which keeps the model quota untouched.
 */

const logCalls: Array<{ msg: string; meta: any }> = [];
vi.mock("../../shared/logger", () => ({
  logger: {
    info: (meta: any, msg: string) => logCalls.push({ msg, meta }),
    warn: (meta: any, msg: string) => logCalls.push({ msg, meta }),
    error: (meta: any, msg: string) => logCalls.push({ msg, meta }),
  },
}));

// The provider layer reads its key at module load; set it before the import.
process.env.AI_API_KEY = "test-key";
process.env.AI_AGENT_ENGINE = "mastra";

const { runToolLoop, mastraEngineEnabled } =
  await import("../../modules/ai-assistant/mastra-agent");
const { resetModelState } = await import("../../modules/ai-assistant/llm");
const { clearScanCache } = await import("../../modules/ai-assistant/email");

/** A provider reply in the OpenAI-compatible shape chatCompletion parses. */
function completion(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const ctx: any = { settings: { model: "gemini-3.6-flash" }, phone: "201000000000", outbox: [] };

beforeEach(() => {
  logCalls.length = 0;
  resetModelState();
  clearScanCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mastra engine: real runtime integration (Mastra not mocked)", () => {
  it("is selected only by AI_AGENT_ENGINE", () => {
    expect(mastraEngineEnabled()).toBe(true);
  });

  it("drives a real Mastra Agent through the provider bridge and answers", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          // First round: the model asks for a tool, in the shape Mastra reads.
          return completion({
            model: "gemini-3.6-flash",
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "system_overview", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          });
        }
        // Second round: prose, ending the loop.
        return completion({
          model: "gemini-3.6-flash",
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "الإجابة النهائية مبنية على الأداة." },
            },
          ],
        });
      }),
    );

    const out = await runToolLoop({
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "نظرة عامة على النظام" }] as any,
      ctx,
      maxRounds: 3,
      signal: new AbortController().signal,
      phone: ctx.phone,
      remainingBudgetMs: 120000,
    });

    // The tool round really executed through the real registry, and the loop
    // ended on the model's prose rather than on a budget forcer.
    expect(out.exchanges.some((e) => e.name === "system_overview")).toBe(true);
    expect(out.finalText).toContain("الإجابة النهائية");
    expect(out.taskTrace.toolCalls).toBeGreaterThan(0);
  });

  it("returns a usable result even when the provider fails outright", async () => {
    // Every provider attempt fails. The engine must still return a result rather
    // than throwing or hanging — the operator's reply must never be left
    // undetermined by an upstream fault.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream exploded", { status: 500 })),
    );

    const out = await runToolLoop({
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "سؤال" }] as any,
      ctx,
      maxRounds: 2,
      signal: new AbortController().signal,
      phone: ctx.phone,
      remainingBudgetMs: 120000,
    });

    expect(out).toBeTruthy();
    expect(out.taskTrace).toBeDefined();
  });
});
