import { describe, expect, it, beforeEach } from "vitest";
import {
  clearSourceChoice,
  needsSourceChoice,
  parseSourceChoice,
  resolveSourceChoice,
} from "../../modules/ai-assistant/source-choice";
import { routeQuestion } from "../../modules/ai-assistant/router";

describe("source choice for censuses", () => {
  beforeEach(() => clearSourceChoice());

  it("asks when a census names no source", () => {
    expect(needsSourceChoice("اعمل حصر لكل أوامر الشراء في 2026")).toBe(true);
    expect(needsSourceChoice("كام مرة اتطلب البند ده وكميته الإجمالية؟")).toBe(true);
  });

  it("does not ask when the source is already named", () => {
    expect(needsSourceChoice("اعمل حصر لأوامر EDC من الميل")).toBe(false);
    expect(needsSourceChoice("حصر البنود من قاعدة البيانات")).toBe(false);
    expect(needsSourceChoice("حصر من الواتساب")).toBe(false);
  });

  it("does not ask for a plain document lookup", () => {
    expect(needsSourceChoice("وين أمر الشراء 104؟")).toBe(false);
  });

  it("asks once, then completes the held question with the chosen source", () => {
    const first = resolveSourceChoice("p1", "اعمل حصر لكل بنود EDC");
    expect(first.kind).toBe("ask");
    const second = resolveSourceChoice("p1", "2");
    expect(second.kind).toBe("run");
    if (second.kind !== "run") return;
    expect(second.text).toContain("اعمل حصر لكل بنود EDC");
    // The chosen email directive must actually route to the email source.
    expect(routeQuestion(second.text).sourceScope).toBe("email");
  });

  it("routes the database choice without the email scope", () => {
    resolveSourceChoice("p2", "حصر كل الأوامر");
    const r = resolveSourceChoice("p2", "قاعدة البيانات");
    expect(r.kind).toBe("run");
    if (r.kind !== "run") return;
    expect(routeQuestion(r.text).sourceScope).toBe("any");
  });

  it("drops the held question when the operator moves on to something else", () => {
    resolveSourceChoice("p3", "حصر كل الأوامر");
    const next = resolveSourceChoice(
      "p3",
      "وين أمر الشراء 104 من الميل النهارده؟ ومين المورد اللي عليه",
    );
    expect(next).toEqual({
      kind: "run",
      text: "وين أمر الشراء 104 من الميل النهارده؟ ومين المورد اللي عليه",
    });
  });

  it("expires a held question after its window", () => {
    resolveSourceChoice("p4", "حصر كل الأوامر", 0);
    const late = resolveSourceChoice("p4", "1", 11 * 60 * 1000);
    expect(late.kind).toBe("run");
    if (late.kind === "run") expect(late.text).toBe("1");
  });

  it("parses bare choices and rejects long sentences", () => {
    expect(parseSourceChoice("1")).toBe("db");
    expect(parseSourceChoice("٢")).toBe("email");
    expect(parseSourceChoice("واتساب")).toBe("whatsapp");
    expect(parseSourceChoice("ده سؤال تاني خالص بالتفصيل عن موضوع مختلف تماما")).toBeNull();
  });
});

describe("runAgent asks for a source before a census", () => {
  it("returns the source question without calling the model", async () => {
    clearSourceChoice();
    const { runAgent } = await import("../../modules/ai-assistant/agent");
    const out = await runAgent({ phone: "2011", text: "اعمل حصر لكل أوامر الشراء" }).catch(
      (e: unknown) => ({ reply: String(e), attachments: [] }),
    );
    expect(out.reply).toContain("البيانات دي هجيبها من فين؟");
  });
});

describe("continuation of a census", () => {
  beforeEach(() => clearSourceChoice());

  it("does not ask a source question for «اكمل الحصر»", () => {
    const r = resolveSourceChoice("c1", "اكمل الحصر");
    expect(r.kind).toBe("run");
  });

  it("resumes the last census with its source instead of starting over", () => {
    resolveSourceChoice("c2", "اعمل حصر لكل بنود EDC");
    resolveSourceChoice("c2", "2");
    const r = resolveSourceChoice("c2", "اكمل الحصر");
    expect(r.kind).toBe("run");
    if (r.kind !== "run") return;
    expect(r.text).toContain("اعمل حصر لكل بنود EDC");
    expect(r.text).toContain("استكمل المهمة السابقة");
    expect(routeQuestion(r.text).sourceScope).toBe("email");
  });

  it("expires the resumable census after its window", () => {
    resolveSourceChoice("c3", "حصر كل الأوامر من الميل", 0);
    const r = resolveSourceChoice("c3", "كمل", 31 * 60 * 1000);
    expect(r).toEqual({ kind: "run", text: "كمل" });
  });
});
