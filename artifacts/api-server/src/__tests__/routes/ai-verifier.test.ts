/**
 * Deterministic verifier (P2 / PR 5).
 *
 * The layer exists to catch an answer that is traceable but WRONG — a total that
 * does not reconcile against the database. These tests pin the two decisions that
 * matter: a mismatch must be reported (never silently accepted), and a question
 * with no large figure must be SKIPPED rather than reported as "verified" (a skip
 * is not evidence that a figure was right).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let poItemTotal = 0;
const poItemsT = { _: "po_items", qty: "qty", lineStatus: "lineStatus", createdAt: "createdAt" };
const customerItemsT = { _: "customer_items", qty: "qty" };

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: (t: any) => ({
        where: () => {
          if (t === poItemsT) return Promise.resolve([{ total: poItemTotal }]);
          return Promise.resolve([{ n: 0, qty: 0 }]);
        },
        // no-where variant (count queries)
        then: (res: any) => Promise.resolve([{ n: 0 }]).then(res),
      }),
    }),
  },
  purchaseOrderItemsTable: poItemsT,
  customerPoItemsTable: customerItemsT,
}));

vi.mock("drizzle-orm", () => ({
  sql: Object.assign((..._a: unknown[]) => ({ sql: true }), { join: () => ({}) }),
  ne: (...a: unknown[]) => ({ ne: a }),
}));

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { extractReportedTotals, verifyAnswer, confidenceFromVerification } =
  await import("../../modules/ai-assistant/verifier");

describe("reported-total extraction", () => {
  it("finds a thousands-separated figure", () => {
    expect(extractReportedTotals("الإجمالي 1,842 وحدة")).toContain(1842);
  });

  it("finds a bare 4+ digit figure", () => {
    expect(extractReportedTotals("إجمالي الكميات 3710")).toContain(3710);
  });

  it("does NOT treat a small incidental integer as a total", () => {
    // "3 PO lines" is not a figure to reconcile, and querying the DB for it
    // would produce a spurious disagreement on a perfectly good answer.
    expect(extractReportedTotals("عندنا 3 أوامر شراء")).toHaveLength(0);
  });

  it("reads Arabic-Indic digits too", () => {
    expect(extractReportedTotals("الإجمالي ١٫٨٤٢")).toBeDefined();
    expect(extractReportedTotals("إجمالي ٣٧١٠ رسالة")).toContain(3710);
  });

  it("does NOT read the leading digits of a Line Item / document code as a total", () => {
    // The live false alarm: an answer about an email census listed codes like
    // «1531.032.GENRAL.7538» and «P26E14708», and the bare `\d{4,}` matcher took
    // the leading «1531» as a monetary total — reconciling an email figure
    // against the database and printing «PARTIALLY_VERIFIED» on a correct answer.
    expect(extractReportedTotals("البند 1531.032.GENRAL.7538 متكرر")).toHaveLength(0);
    expect(extractReportedTotals("أمر الشراء P26E14708")).toHaveLength(0);
    expect(extractReportedTotals("رقم 26R011936 واردة")).toHaveLength(0);
    // A real, separated total is still found.
    expect(extractReportedTotals("الإجمالي 3,710 رسالة")).toContain(3710);
  });
});

describe("answer verification", () => {
  beforeEach(() => {
    poItemTotal = 0;
  });

  it("reports a disagreement when the answer's total does not reconcile", async () => {
    poItemTotal = 999;
    const r = await verifyAnswer({ answerText: "إجمالي الكميات 1,842 وحدة" });
    expect(r.outcome).toBe("disagreement");
    expect(r.note).toContain("999");
  });

  it("passes when the total reconciles exactly", async () => {
    poItemTotal = 1842;
    const r = await verifyAnswer({ answerText: "إجمالي الكميات 1,842 وحدة" });
    expect(r.outcome).toBe("verified");
  });

  it("SKIPS (not verifies) an answer with no large figure", async () => {
    // The distinction is the point: a skip proves nothing, so it must not be
    // reported as a pass.
    const r = await verifyAnswer({ answerText: "المورد شركة الأمل" });
    expect(r.outcome).toBe("skipped");
    expect(r.checks).toHaveLength(0);
  });

  it("downgrades a VERIFIED claim to PARTIALLY_VERIFIED on disagreement", () => {
    expect(confidenceFromVerification("VERIFIED", { outcome: "disagreement", checks: [] })).toBe(
      "PARTIALLY_VERIFIED",
    );
  });

  it("never upgrades a low-confidence answer", () => {
    expect(
      confidenceFromVerification("INSUFFICIENT_EVIDENCE", { outcome: "disagreement", checks: [] }),
    ).toBe("INSUFFICIENT_EVIDENCE");
    expect(confidenceFromVerification("VERIFIED", { outcome: "skipped", checks: [] })).toBe(
      "VERIFIED",
    );
  });
});
