/**
 * The system prompt is a BUDGET, and this guards it.
 *
 * Live history: the prompt grew to ~19.7k characters and 40+ overlapping rules.
 * That matters because the model is asked to hold the tool contracts AND the
 * rules in view at once — a prompt that size stops being obeyed selectively, and
 * the recorded symptoms (ignoring the stated source, calling the wrong tool,
 * answering from the wrong tables) followed. The rules that can be enforced in
 * code were moved out of the prose; what remains must stay compact and free of
 * the duplicated mandates that made the old one contradictory.
 */
import { describe, it, expect } from "vitest";
import { systemPrompt } from "../../modules/ai-assistant/agent";
import { DEFAULT_SETTINGS, type AiSettings } from "../../modules/ai-assistant/config";

const settings: AiSettings = { ...DEFAULT_SETTINGS, language: "ar" };

describe("system prompt budget", () => {
  const prompt = systemPrompt(settings);

  it("stays under the size where the rules stop being followed", () => {
    // 9.5k leaves room for growth while failing the 19.7k body that was live when
    // the assistant started ignoring its own instructions.
    expect(prompt.length).toBeLessThan(9_500);
    expect(prompt.length).toBeGreaterThan(1_000);
  });

  it("keeps the business knowledge that has no code-level equivalent", () => {
    expect(prompt).toContain("Line Item");
    expect(prompt).toContain("RFQ");
    expect(prompt).toContain("التكرار");
    // The customer-PO vs purchase-order distinction is business mapping the code
    // cannot infer from the question alone.
    expect(prompt).toContain("customer_pos");
  });

  it("states the honest capability limits", () => {
    // The model has claimed it could send WhatsApp messages; it cannot.
    expect(prompt).toMatch(/لا.*إرسال/);
    expect(prompt).toContain("send_email");
  });

  it("does not repeat the no-fabrication mandate into contradictions", () => {
    // The old prompt asserted the same rule five times in different words; the
    // count is the signal that it had become noise rather than instruction.
    const mentions = prompt.match(/لا ت?خمّ?ن|التخمين|غير متوفر/g) ?? [];
    expect(mentions.length).toBeLessThanOrEqual(6);
  });

  it("honours the configured language and appends an operator override", () => {
    expect(systemPrompt({ ...settings, language: "en" })).toContain("English");
    const withOverride = systemPrompt({ ...settings, systemPrompt: "قاعدة إضافية" });
    expect(withOverride).toContain("قاعدة إضافية");
    expect(withOverride).toContain("تعليمات إضافية من الإدارة");
  });
});
