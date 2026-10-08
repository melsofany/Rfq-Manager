import { describe, it, expect } from "vitest";
import {
  messagesForProvider,
  GEMINI_SIGNATURE_PLACEHOLDER,
  type ChatMessage,
} from "../modules/ai-assistant/llm";

/**
 * Live (2026-10-08): the run fell from DeepSeek to Gemini mid-conversation. The
 * replayed DeepSeek tool-call turn had no thought signature, Gemini answered 400
 * ("missing a thought_signature"), and the forced answer was lost.
 */
const deepseekTurn: ChatMessage = {
  role: "assistant",
  content: null,
  tool_calls: [{ id: "c1", type: "function", function: { name: "scan_emails", arguments: "{}" } }],
};
const geminiTurnSigned: ChatMessage = {
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "c2",
      type: "function",
      function: { name: "search_database", arguments: "{}" },
      extra_content: { google: { thought_signature: "REAL_SIG" } },
    },
  ],
};
const history: ChatMessage[] = [
  { role: "user", content: "q" },
  deepseekTurn,
  { role: "tool", tool_call_id: "c1", name: "scan_emails", content: "ok" },
  geminiTurnSigned,
];

describe("messagesForProvider", () => {
  it("gives every Gemini tool call a signature, using the placeholder when none was captured", () => {
    const out = messagesForProvider(history, "gemini");
    const first = out[1].tool_calls![0];
    expect(first.extra_content?.google?.thought_signature).toBe(GEMINI_SIGNATURE_PLACEHOLDER);
    expect(first.function.name).toBe("scan_emails");
  });

  it("keeps a real signature that was already captured", () => {
    const out = messagesForProvider(history, "gemini");
    expect(out[3].tool_calls![0].extra_content?.google?.thought_signature).toBe("REAL_SIG");
  });

  it("does not mutate the input history", () => {
    messagesForProvider(history, "gemini");
    expect(deepseekTurn.tool_calls![0].extra_content).toBeUndefined();
  });

  it("leaves DeepSeek requests untouched", () => {
    expect(messagesForProvider(history, "deepseek")).toBe(history);
  });

  it("returns the same array when nothing needs adapting", () => {
    const plain: ChatMessage[] = [{ role: "user", content: "hi" }];
    expect(messagesForProvider(plain, "gemini")).toBe(plain);
  });
});
