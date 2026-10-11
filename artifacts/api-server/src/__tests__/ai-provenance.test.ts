import { describe, expect, it } from "vitest";
import { provenanceFooter } from "../modules/ai-assistant/provenance";

const reply = "وجدت الطلب 26R012450 والكمية 200 وميعاد الإغلاق 2026-10-10 حسب النظام.";
const t = (name: string, args: Record<string, unknown> = {}, ok = true) => ({ name, args, ok });

describe("provenance footer", () => {
  it("names the real tables that were read", () => {
    const f = provenanceFooter({
      intent: "document_lookup",
      reply,
      usedTools: [
        t("search_database", { table: "customer_rfqs" }),
        t("run_readonly_query", {
          sql: "SELECT * FROM customer_rfq_items i JOIN customer_rfqs r ON 1=1",
        }),
      ],
    });
    expect(f).toContain("customer_rfqs");
    expect(f).toContain("customer_rfq_items");
    expect(f).toContain("المصدر");
  });
  it("names the mailbox for mail tools", () => {
    expect(
      provenanceFooter({ intent: "email_search", reply, usedTools: [t("scan_emails")] }),
    ).toContain("البريد الإلكتروني");
  });
  it("ignores failed calls and warns when a data answer has no successful read", () => {
    const f = provenanceFooter({
      intent: "document_lookup",
      reply,
      usedTools: [t("search_database", { table: "x" }, false)],
    });
    expect(f).toContain("لم يستند");
  });
  it("stays silent for chat, short replies, replies with a source, and non-source tools", () => {
    expect(provenanceFooter({ intent: "smalltalk", reply, usedTools: [] })).toBe("");
    expect(provenanceFooter({ intent: "document_lookup", reply: "تمام", usedTools: [] })).toBe("");
    expect(
      provenanceFooter({
        intent: "document_lookup",
        reply: reply + "\nالمصدر: customer_rfqs",
        usedTools: [],
      }),
    ).toBe("");
    expect(
      provenanceFooter({
        intent: "report",
        reply: "ملخص عام بدون أرقام محددة هنا إطلاقًا ولا غيره",
        usedTools: [t("recall_memory")],
      }),
    ).toBe("");
  });
});
