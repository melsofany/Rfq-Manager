/**
 * The prompt's STRUCTURE is a contract, not decoration.
 *
 * The rewrite follows the open-source agent prompts that hold up under long,
 * tool-heavy runs (Manus' `<agent_loop>`/`<message_rules>`, same.new's tag
 * sections, Cline's direct-tone rule): a tagged section per concern. The tags
 * are load-bearing — they are how a small model keeps the loop contract distinct
 * from the business facts instead of blurring them together.
 *
 * Two behaviours this guards were learned live:
 *  - the assistant used to narrate its tool calls to the operator ("سأستخدم أداة
 *    كذا", "search_database") instead of answering;
 *  - the prompt drifted away from naming the tools/parameters, which produced
 *    wrong-tool selection and repeated calls (PR #200), so the concrete names
 *    must stay even though the assistant must not SAY them.
 */
import { describe, it, expect } from "vitest";
import { systemPrompt } from "../../modules/ai-assistant/agent";
import { DEFAULT_SETTINGS, type AiSettings } from "../../modules/ai-assistant/config";

const settings: AiSettings = { ...DEFAULT_SETTINGS, language: "ar" };
const prompt = systemPrompt(settings);

describe("agent prompt structure (Manus/same.new style)", () => {
  it("keeps one tagged section per concern", () => {
    for (const tag of [
      "agent_loop",
      "action_rules",
      "communication_rules",
      "source_selection",
      "counting_rules",
      "knowledge_base",
      "capabilities",
      "security",
    ]) {
      expect(prompt, `missing <${tag}>`).toContain(`<${tag}>`);
      expect(prompt, `unclosed <${tag}>`).toContain(`</${tag}>`);
    }
  });

  it("states the loop contract: one tool per iteration, then stop", () => {
    expect(prompt).toContain("أداة واحدة في كل تكرار");
    expect(prompt).toContain("توقّف عن الأدوات واكتب الرد النهائي");
    // Repeating the same call with the same arguments is the recorded way this
    // assistant burns its per-model daily quota without making progress.
    expect(prompt).toContain("نفس المعطيات");
  });

  it("forbids narrating tool calls to the operator", () => {
    // The rule is about what the OPERATOR sees — the prompt itself still has to
    // name the tools (see the drift test below).
    expect(prompt).toContain("لا تذكر أسماء الأدوات للمدير");
  });

  it("still names the concrete tools and parameters (PR #200 regression)", () => {
    // Removing these was the PR #200 defect: the model no longer knew which
    // parameter to pass, so it selected the wrong tool or looped.
    for (const token of [
      "scan_emails",
      "scan_email_items",
      "search_sent_emails",
      "send_email",
      "lookup_document",
      "supplier_overview",
      "get_email_attachment",
      "start_census_job",
      "generate_pdf",
      "compareTable",
      "exportCsv",
      "contains",
    ]) {
      expect(prompt, `prompt stopped naming ${token}`).toContain(token);
    }
  });

  it("carries the current date so relative windows resolve", () => {
    expect(prompt).toMatch(/التاريخ اليوم: \d{4}-\d{2}-\d{2}/);
  });

  it("makes asking the operator the preferred move over guessing", () => {
    expect(prompt).toContain("اسأل المدير بوضوح بدل التخمين");
  });
});
