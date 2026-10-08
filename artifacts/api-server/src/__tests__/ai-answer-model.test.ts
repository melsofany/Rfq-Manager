import { describe, expect, it } from "vitest";
import { ANSWER_MODEL, forcedAnswerModel } from "../modules/ai-assistant/config";

describe("forced answer model", () => {
  it("uses the light DeepSeek chat model for a DeepSeek primary", () => {
    if (!ANSWER_MODEL) return;
    expect(forcedAnswerModel("deepseek-v4-pro")).toBe(ANSWER_MODEL);
    expect(ANSWER_MODEL).toBe("deepseek-chat");
  });

  it("keeps a Gemini primary unchanged", () => {
    expect(forcedAnswerModel("gemini-3.1-flash-lite")).toBe("gemini-3.1-flash-lite");
  });
});
