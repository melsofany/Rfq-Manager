import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A provider that cannot serve at all must not silence the assistant.
 *
 * Measured live: the configured primary was DeepSeek and its key had no
 * balance, so every request answered `402 insufficient_balance_error`. 402 was
 * not in the chain's "move on" set, so the error was treated as PERMANENT and
 * thrown — before Gemini, which answered normally, was ever dialled. The
 * operator saw an assistant that did nothing.
 */
describe("provider failover on a billing/auth refusal", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    vi.resetModules();
    process.env.DEEPSEEK_API_KEY = "ds-test-key";
    process.env.AI_API_KEY = "gemini-test-key";
    process.env.AI_MODEL = "deepseek-chat";
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.AI_API_KEY;
    delete process.env.AI_MODEL;
    vi.resetModules();
  });

  function mockFetch(handler: (url: string) => Response) {
    global.fetch = vi.fn(async (input: unknown) => handler(String(input))) as never;
  }

  it("switches to the working provider when the primary has no balance", async () => {
    const seen: string[] = [];
    mockFetch((url) => {
      seen.push(url);
      if (url.includes("deepseek")) {
        return new Response(
          JSON.stringify({
            error: { message: "Insufficient Balance", type: "insufficient_balance_error" },
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "رد من جيميناي" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    const result = await chatCompletion({
      model: process.env.AI_MODEL as string,
      messages: [{ role: "user", content: "مرحبا" }],
    });
    expect(result.content).toContain("جيميناي");
    // The dead provider is probed ONCE, not once per model it serves.
    expect(seen.filter((u) => u.includes("deepseek")).length).toBe(1);
  });

  it("still surfaces a permanent request error (400) without burning the chain", async () => {
    const seen: string[] = [];
    mockFetch((url) => {
      seen.push(url);
      return new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    const { chatCompletion } = await import("../../modules/ai-assistant/llm");
    await expect(
      chatCompletion({
        model: process.env.AI_MODEL as string,
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toThrow();
    expect(seen.length).toBe(1);
  });
});
