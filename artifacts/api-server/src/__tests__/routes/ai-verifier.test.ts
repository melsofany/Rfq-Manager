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

const { verifyAnswer, confidenceFromVerification } =
  await import("../../modules/ai-assistant/verifier");

describe("reported-total extraction (removed)", () => {
  // `extractReportedTotals` was DELETED: mining a figure from the prose and
  // reconciling it against a database SUM is how a YEAR («2025») and a Part
  // Number («680632») were compared to the total quantity and every correct
  // answer was stamped PARTIALLY_VERIFIED. The verifier now only reconciles a
  // tool's OWN aggregate — see the cases below.
  it("no longer exists as an exported helper", async () => {
    const mod: Record<string, unknown> = await import("../../modules/ai-assistant/verifier");
    expect(mod.extractReportedTotals).toBeUndefined();
  });
});

describe("answer verification", () => {
  beforeEach(() => {
    poItemTotal = 0;
  });

  const agg = (total: number) => [{ tool: "aggregate_po_items", total }];

  it("reports a disagreement when the tool's total does not reconcile", async () => {
    poItemTotal = 999;
    const r = await verifyAnswer({
      answerText: "إجمالي الكميات 1,842 وحدة",
      toolAggregates: agg(1842),
    });
    expect(r.outcome).toBe("disagreement");
    expect(r.note).toContain("999");
  });

  it("passes when the tool's total reconciles exactly", async () => {
    poItemTotal = 1842;
    const r = await verifyAnswer({
      answerText: "إجمالي الكميات 1,842 وحدة",
      toolAggregates: agg(1842),
    });
    expect(r.outcome).toBe("verified");
  });

  it("SKIPS (not verifies) an answer with no large figure", async () => {
    // The distinction is the point: a skip proves nothing, so it must not be
    // reported as a pass.
    const r = await verifyAnswer({ answerText: "المورد شركة الأمل" });
    expect(r.outcome).toBe("skipped");
    expect(r.checks).toHaveLength(0);
  });

  it("NEVER reconciles a figure mined from the PROSE (the year / part-number bug)", async () => {
    // Live: the caveat «المرصود 2025 والمحسوب 14265 … PARTIALLY_VERIFIED» was
    // appended to correct answers about 2025/2026 items because the verifier took
    // the first large number in the prose — a YEAR («2025») or a Part Number
    // («680632») — and compared it to the sum of every PO line. With no tool
    // aggregate, the check must have nothing to reconcile.
    poItemTotal = 14265;
    const r = await verifyAnswer({
      answerText: "الأصناف التي تم توريدها خلال عامي 2025 و 2026 والموديل 680632",
    });
    expect(r.outcome).toBe("skipped");
    expect(r.checks).toHaveLength(0);
  });

  it("skips a total from a tool that aggregates only a SUBSET of the table", async () => {
    // A single order's quantity is not comparable to the whole-table SUM, so
    // reconciling it would flag a correct answer.
    poItemTotal = 15280;
    const r = await verifyAnswer({
      answerText: "إجمالي كميات الأمر 9,200",
      toolAggregates: [{ tool: "get_purchase_order_status", total: 9200 }],
    });
    expect(r.outcome).toBe("skipped");
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

describe("collectToolTotals", () => {
  it("collects a whole-result aggregate but NOT a single row's qty", async () => {
    // The tool's own aggregate is the only figure the verifier may reconcile;
    // a per-row `qty` is one line item, not a dataset total.
    const { collectToolTotals } = await import("../../modules/ai-assistant/agent");
    expect(
      collectToolTotals(
        "aggregate_po_items",
        JSON.stringify({ data: { items: [], totalQty: 15280 } }),
      ),
    ).toContain(15280);
    expect(
      collectToolTotals("search_database", JSON.stringify({ data: { rows: [{ qty: 9000 }] } })),
    ).toHaveLength(0);
  });

  it("sums the aggregate_po_items rows, since that IS the dataset total", async () => {
    const { collectToolTotals } = await import("../../modules/ai-assistant/agent");
    const content = JSON.stringify({
      data: {
        items: [
          { totalQty: 5000, occurrences: 3 },
          { totalQty: 3000, occurrences: 2 },
        ],
      },
    });
    expect(collectToolTotals("aggregate_po_items", content)).toContain(8000);
  });

  it("ignores a total below the reconciliation threshold and unparseable content", async () => {
    const { collectToolTotals } = await import("../../modules/ai-assistant/agent");
    expect(
      collectToolTotals("aggregate_po_items", JSON.stringify({ data: { totalQty: 12 } })),
    ).toHaveLength(0);
    expect(collectToolTotals("aggregate_po_items", "not json")).toHaveLength(0);
  });
});
