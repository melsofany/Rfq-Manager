import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The bridge is the part of the Mastra swap that has no test-free safety net:
 * a wrong shape does not throw, it silently drops a tool argument or loses the
 * Gemini thought signature. These tests pin the translation against the shapes
 * that actually worked live.
 */
const chatCompletion = vi.fn();
vi.mock("../../modules/ai-assistant/llm", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatCompletion: (...args: any[]) => chatCompletion(...args),
}));

const { CortobaLanguageModel } = await import("../../modules/ai-assistant/mastra-model");

function textResult(text: string) {
  return {
    content: text,
    toolCalls: [],
    finishReason: "stop",
    modelUsed: "gemini-3.8-flash",
    providerUsed: "gemini" as const,
  };
}

beforeEach(() => {
  chatCompletion.mockReset();
});

describe("CortobaLanguageModel bridge", () => {
  it("converts a system + user prompt into the provider's message shape", async () => {
    chatCompletion.mockResolvedValue(textResult("مرحبا"));
    const model = new CortobaLanguageModel("gemini-3.8-flash", "https://example/v1beta/openai");

    await model.doGenerate({
      prompt: [
        { role: "system", content: "أنت مساعد" },
        { role: "user", content: [{ type: "text", text: "كم عدد الأوامر؟" }] },
      ],
    });

    const sent = chatCompletion.mock.calls[0][0];
    expect(sent.model).toBe("gemini-3.8-flash");
    expect(sent.baseUrl).toBe("https://example/v1beta/openai");
    expect(sent.messages[0]).toEqual({ role: "system", content: "أنت مساعد" });
    // A text-only user turn must stay a plain string, not a content-part array.
    expect(sent.messages[1]).toEqual({ role: "user", content: "كم عدد الأوامر؟" });
  });

  it("passes a tool call's arguments through to Mastra as the RAW json string", async () => {
    // Mastra calls `input.replace(...)`, so a parsed object here throws
    // "input.replace is not a function" — the exact failure seen live.
    chatCompletion.mockResolvedValue({
      content: null,
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "count_database", arguments: '{"table":"purchase_orders"}' },
        },
      ],
      finishReason: "tool_calls",
    });
    const model = new CortobaLanguageModel("m");

    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    });

    const part: any = result.content.find((c: any) => c.type === "tool-call");
    expect(part.input).toBe('{"table":"purchase_orders"}');
    expect(typeof part.input).toBe("string");
    expect(part.toolName).toBe("count_database");
    expect(result.finishReason.unified).toBe("tool-calls");
  });

  it("round-trips the Gemini thought_signature through providerMetadata", async () => {
    // Gemini 3 rejects the follow-up request unless the opaque signature is
    // echoed. This is what makes tool calling work on Gemini at all, and it is
    // why the bridge carries it rather than a stock AI-SDK provider.
    chatCompletion.mockResolvedValue({
      content: null,
      toolCalls: [
        {
          id: "call_9",
          type: "function",
          function: { name: "search_database", arguments: "{}" },
          extra_content: { google: { thought_signature: "SIG-abc" } },
        },
      ],
      finishReason: "tool_calls",
    });
    const model = new CortobaLanguageModel("m");
    const generated = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    });
    const part: any = generated.content.find((c: any) => c.type === "tool-call");
    expect(part.providerMetadata.cortoba.thoughtSignature).toBe("SIG-abc");

    // Now feed the assistant turn back in: the signature must return as the
    // provider's own `extra_content.google.thought_signature`.
    chatCompletion.mockReset();
    chatCompletion.mockResolvedValue(textResult("تم"));
    await model.doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "x" }] },
        { role: "assistant", content: [part] },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_9",
              toolName: "search_database",
              output: { type: "text", value: '{"ok":true}' },
            },
          ],
        },
      ],
    });

    const echo = chatCompletion.mock.calls[0][0];
    const assistant = echo.messages.find((m: any) => m.role === "assistant");
    expect(assistant.tool_calls[0].extra_content).toEqual({
      google: { thought_signature: "SIG-abc" },
    });
    // A string tool result must reach the provider verbatim, not JSON-quoted.
    const toolMsg = echo.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toBe('{"ok":true}');
    expect(toolMsg.tool_call_id).toBe("call_9");
  });

  it("forwards the tool catalogue and maps toolChoice=none", async () => {
    chatCompletion.mockResolvedValue(textResult("ok"));
    const model = new CortobaLanguageModel("m");
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      tools: [
        {
          type: "function",
          name: "count_database",
          description: "count rows",
          inputSchema: { type: "object", properties: { table: { type: "string" } } },
        },
      ],
      toolChoice: { type: "none" },
    });

    const sent = chatCompletion.mock.calls[0][0];
    expect(sent.toolChoice).toBe("none");
    expect(sent.tools[0].function.name).toBe("count_database");
    // The JSON schema is reused as-is rather than rewritten as zod.
    expect(sent.tools[0].function.parameters.properties.table.type).toBe("string");
  });

  it("flattens an image content part into the provider's image_url shape", async () => {
    chatCompletion.mockResolvedValue(textResult("ok"));
    const model = new CortobaLanguageModel("m");
    await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "حلّل الصورة" },
            { type: "file", mediaType: "image/jpeg", data: "https://img/x.jpg" },
          ],
        },
      ],
    });
    const sent = chatCompletion.mock.calls[0][0];
    expect(Array.isArray(sent.messages[0].content)).toBe(true);
    expect(sent.messages[0].content).toContainEqual({
      type: "image_url",
      image_url: { url: "https://img/x.jpg" },
    });
  });

  it("keeps an image that Mastra passes as downloaded BYTES", async () => {
    // Live, Mastra downloads the image and hands the model a Uint8Array. The
    // first version of this bridge only accepted a string and therefore dropped
    // the operator's photo without any error.
    chatCompletion.mockResolvedValue(textResult("ok"));
    const model = new CortobaLanguageModel("m");
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "حلّل الصورة" },
            { type: "file", mediaType: "image/png", data: bytes },
          ],
        },
      ],
    });

    const sent = chatCompletion.mock.calls[0][0];
    const img = sent.messages[0].content.find((p: any) => p.type === "image_url");
    expect(img).toBeTruthy();
    expect(img.image_url.url).toBe(
      `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
    );
  });
});

describe("mastra engine selection", () => {
  it("keeps the proven legacy loop by default and switches on an explicit opt-in", async () => {
    const { mastraEngineEnabled } = await import("../../modules/ai-assistant/mastra-agent");
    const prev = process.env.AI_AGENT_ENGINE;
    delete process.env.AI_AGENT_ENGINE;
    // The default must stay legacy until the loop's four hardened behaviours
    // (dedup, forced final round, steering, budget extension) are ported — the
    // regression tests for those run against the legacy loop.
    expect(mastraEngineEnabled()).toBe(false);
    process.env.AI_AGENT_ENGINE = "mastra";
    expect(mastraEngineEnabled()).toBe(true);
    process.env.AI_AGENT_ENGINE = "legacy";
    expect(mastraEngineEnabled()).toBe(false);
    if (prev === undefined) delete process.env.AI_AGENT_ENGINE;
    else process.env.AI_AGENT_ENGINE = prev;
  });
});
