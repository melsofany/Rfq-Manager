/**
 * The learning loop: the assistant asks instead of guessing, and the answer is
 * KEPT.
 *
 * The operator's requirement was "with time, and from the user, it learns
 * everything about the company". The assistant already had memory + org-profile
 * storage, but two links in the loop were missing and both are tested here:
 *
 *  1. nothing in the prompt recruited knowledge, so the model guessed rather
 *     than asking (covered by the budget/structure tests); and
 *  2. when the operator DID explain a rule in answer to a question, the
 *     explanation was not captured — so the same question returned next session.
 *
 * The capture runs on every turn with no model call (the Gemini free tier is 20
 * requests/day/model, and quota exhaustion is this assistant's recorded failure
 * mode), so it must be narrow. These tests pin the narrowness as much as the
 * behaviour: a question must never be stored as knowledge.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const inserted: Array<Record<string, unknown>> = [];

vi.mock("@workspace/db", () => {
  const chain = (rows: unknown[]) => {
    const p: any = Promise.resolve(rows);
    p.where = () => chain(rows);
    p.orderBy = () => chain(rows);
    p.limit = () => chain(rows);
    p.returning = () => Promise.resolve(rows);
    return p;
  };
  return {
    db: {
      select: () => chain([]),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          const p: any = Promise.resolve([{ ...v, id: inserted.length }]);
          p.returning = () => Promise.resolve([{ ...v, id: inserted.length }]);
          p.then = (res: any, rej: any) =>
            Promise.resolve([{ ...v, id: inserted.length }]).then(res, rej);
          return p;
        },
      }),
      update: () => ({ set: () => chain([]) }),
    },
    aiAssistantMemoriesTable: { phone: {}, category: {}, key: {}, id: {} },
  };
});

vi.mock("../../modules/ai-assistant/guardrails", () => ({
  checkMemoryWrite: () => ({ ok: true }),
}));

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { looksLikeQuestion, distillMemories } = await import("../../modules/ai-assistant/memory");

beforeEach(() => {
  inserted.length = 0;
});

describe("distillMemories — captures the operator's explanation", () => {
  it("stores a business rule the operator states in answer to a question", async () => {
    await distillMemories({
      phone: "201000000000",
      userText: "قاعدة العمل هي إن أرقام أوامر شراء EDC تبدأ بحرف P بعدين سنة بعدين E",
      assistantText: "ما معنى هذا الرقم؟",
    });
    expect(inserted.length).toBe(1);
    expect(inserted[0].category).toBe("rule");
    expect(String(inserted[0].value)).toContain("أوامر شراء EDC");
  });

  it("captures «خلي بالك إن…» as a standing instruction", async () => {
    await distillMemories({
      phone: "201000000000",
      userText: "خلي بالك إن الأريستون بتتكتب ARSTON في المستندات",
      assistantText: "ثواني أتحقق",
    });
    expect(inserted.length).toBe(1);
    expect(String(inserted[0].value)).toContain("ARSTON");
  });

  it("never stores a QUESTION as knowledge", async () => {
    // The assistant's own follow-up arrives as the next "user" turn. Storing it
    // would teach the memory a question and pollute every later prompt.
    await distillMemories({
      phone: "201000000000",
      userText: "إيه معنى الرقم اللي طلع في التقرير؟",
      assistantText: "…",
    });
    expect(inserted.length).toBe(0);
  });

  it("ignores an ordinary task description, not a rule", async () => {
    // The distiller runs on EVERY turn, so a loose pattern would fill the memory
    // with one-off requests and make the injected block useless.
    await distillMemories({
      phone: "201000000000",
      userText: "هات تقرير بأوامر الشراء الواردة من EDC خلال 2026",
      assistantText: "…",
    });
    expect(inserted.length).toBe(0);
  });

  it("still stores an explicit «افتكر إن» teaching, unchanged", async () => {
    await distillMemories({
      phone: "201000000000",
      userText: "افتكر إن العميل الرئيسي اسمه EDC",
      assistantText: "تم",
    });
    expect(inserted.length).toBe(1);
    expect(inserted[0].category).toBe("rule");
  });
});

describe("looksLikeQuestion", () => {
  it("classifies interrogatives and trailing question marks", () => {
    expect(looksLikeQuestion("إيه معنى ده؟")).toBe(true);
    expect(looksLikeQuestion("هل الرقم ده صح؟")).toBe(true);
    expect(looksLikeQuestion("ليه مش موجود")).toBe(true);
    expect(looksLikeQuestion("كام بند اتكرر؟")).toBe(true);
    expect(looksLikeQuestion("")).toBe(true);
  });

  it("accepts a plain statement as an explanation", () => {
    expect(looksLikeQuestion("قاعدة العمل هي إن الشحن على المورد")).toBe(false);
    expect(looksLikeQuestion("خلي بالك إن ARSTON معناها ARISTON")).toBe(false);
  });
});
