/**
 * `lookup_document` must not report «غير موجود» from a search of the WRONG table.
 *
 * The live failure: the operator asked about an order from the CUSTOMER (EDC) and
 * the model searched `purchase_orders` — our orders to SUPPLIERS — then told him
 * the order was «غير موجود في قاعدة البيانات»، while the number lived in
 * `customer_pos` the whole time (verified against production: id 841,
 * CPO-2025-000484 / P25E26553, customer EDC, status sent).
 *
 * A supplier PO number and a customer PO number are shaped alike («P26E14708»),
 * so the type is a guess the model can get wrong. A prompt rule alone had already
 * failed to prevent this, so a miss now checks the sibling table before any
 * negative claim is made — a negative claim needs evidence.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// `tools.ts` imports ~25 table bindings. A Proxy hands back a stable identity for
// EVERY export, so the fixture lookup can key on the binding name and a newly
// imported table does not break the suite.
const { fixtures } = vi.hoisted(() => {
  const fx: Record<string, unknown[]> = {};
  const cache: Record<string, any> = {};
  const proxy = new Proxy(cache, {
    get(t, prop: string) {
      if (prop === "then") return undefined; // not a promise
      if (!t[prop]) t[prop] = { _: prop };
      return t[prop];
    },
  });
  return { fixtures: fx };
});

function builder(table: { _: string }) {
  const b: any = {
    where: () => b,
    orderBy: () => b,
    // Every lookup in `lookupDocument` ends in `.limit(n)`, so resolving here
    // means no chain shape goes unhandled.
    limit: () => Promise.resolve(fixtures[table._] ?? []),
  };
  return b;
}

vi.mock("@workspace/db", () => {
  const db = { select: () => ({ from: (t: { _: string }) => builder(t) }) };
  const cache: Record<string, any> = { db };
  return new Proxy(cache, {
    get(t, prop: string) {
      if (prop === "then") return undefined;
      if (prop === "default") return t;
      if (!t[prop]) t[prop] = prop === "db" ? db : { _: prop };
      return t[prop];
    },
  });
});

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  or: (...a: unknown[]) => ({ or: a }),
  eq: (...a: unknown[]) => ({ eq: a }),
  ne: (...a: unknown[]) => ({ ne: a }),
  ilike: (...a: unknown[]) => ({ ilike: a }),
  inArray: (...a: unknown[]) => ({ inArray: a }),
  isNotNull: (...a: unknown[]) => ({ isNotNull: a }),
  desc: (...a: unknown[]) => ({ desc: a }),
  sql: Object.assign((..._a: unknown[]) => ({ sql: true }), { join: () => ({}) }),
}));

vi.mock("../../modules/ai-assistant/email", () => ({ normalizeText: (s: string) => s }));

const ctx = { settings: { allowDatabase: true }, outbox: [], phone: "x" } as any;

describe("lookup_document sibling-table fallback", () => {
  beforeEach(() => {
    for (const k of Object.keys(fixtures)) delete fixtures[k];
    fixtures["purchaseOrdersTable"] = [];
    fixtures["customerPosTable"] = [];
    fixtures["customerPoItemsTable"] = [];
  });

  it("finds a CUSTOMER order when the model wrongly asked for a SUPPLIER order", async () => {
    // The live case: nothing in purchase_orders, but the number IS a customer PO.
    fixtures["purchaseOrdersTable"] = [];
    fixtures["customerPosTable"] = [
      { id: 841, internalPoNo: "CPO-2025-000484", customerPoNo: "P25E26553" },
    ];

    const { executeTool } = await import("../../modules/ai-assistant/tools");
    const res = (await executeTool(
      "lookup_document",
      { type: "supplier_po", number: "P25E26553" },
      ctx,
    )) as any;

    expect(res.ok).toBe(true);
    expect(res.data.found).toBe(true);
    expect(res.data.foundIn).toBe("customer_po");
    expect(res.data.wrongTableTried).toBe("supplier_po");
    // The note must name the right source so the model cannot relay the wrong one.
    expect(res.data.lookupNote).toContain("customer_po");
    expect(res.data.po.customerPoNo).toBe("P25E26553");
  });

  it("does not touch the sibling table when the primary table has the match", async () => {
    fixtures["purchaseOrdersTable"] = [
      { id: 7, internalPoNo: "PO-2026-000007", sheetPoNo: "P26E14708" },
    ];
    fixtures["customerPosTable"] = [{ id: 841, customerPoNo: "P25E26553" }];

    const { executeTool } = await import("../../modules/ai-assistant/tools");
    const res = (await executeTool(
      "lookup_document",
      { type: "supplier_po", number: "P26E14708" },
      ctx,
    )) as any;

    expect(res.data.found).toBe(true);
    expect(res.data.foundIn).toBeUndefined();
    expect(res.data.po.internalPoNo).toBe("PO-2026-000007");
  });

  it("reports absence only AFTER checking both tables, and names them", async () => {
    fixtures["purchaseOrdersTable"] = [];
    fixtures["customerPosTable"] = [];

    const { executeTool } = await import("../../modules/ai-assistant/tools");
    const res = (await executeTool(
      "lookup_document",
      { type: "supplier_po", number: "P99E99999" },
      ctx,
    )) as any;

    expect(res.data.found).toBe(false);
    // A bare "not found" hides WHICH table was searched; the note forces the model
    // to say so instead of implying it checked everywhere.
    expect(res.data.notFoundNote).toContain("supplier_po");
    expect(res.data.notFoundNote).toContain("customer_po");
  });

  it("also resolves the reverse guess (customer_po asked, supplier_po held it)", async () => {
    fixtures["purchaseOrdersTable"] = [
      { id: 7, internalPoNo: "PO-2026-000007", sheetPoNo: "P26E14708" },
    ];
    fixtures["customerPosTable"] = [];

    const { executeTool } = await import("../../modules/ai-assistant/tools");
    const res = (await executeTool(
      "lookup_document",
      { type: "customer_po", number: "P26E14708" },
      ctx,
    )) as any;

    expect(res.data.found).toBe(true);
    expect(res.data.foundIn).toBe("supplier_po");
  });
});
