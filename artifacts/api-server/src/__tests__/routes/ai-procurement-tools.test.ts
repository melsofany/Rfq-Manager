/**
 * Database-first procurement tools.
 *
 * These exist because the arithmetic must happen in the database, not in the
 * model — so the assertions below are about the SHAPE of the result the model
 * receives (source, completeness, confidence, method) and about the aggregate
 * rows being surfaced faithfully. A tool that silently dropped rows or claimed
 * completeness it did not have is exactly the bug class this module targets.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The db handle and table identities are plain objects here; only their identity
// matters, because the mock resolves a fixture by the `from()` table object.
const T = {
  purchaseOrdersTable: { _: "purchase_orders" },
  purchaseOrderItemsTable: { _: "purchase_order_items" },
  suppliersTable: { _: "suppliers" },
  offersTable: { _: "offers" },
  offerItemsTable: { _: "offer_items" },
  supplierInvoicesTable: { _: "supplier_invoices" },
  customerPosTable: { _: "customer_pos" },
  customerPoItemsTable: { _: "customer_po_items" },
};

/** Per-table fixtures: `group` for a GROUP BY query, `plain` for a plain one. */
type Fixture = { group?: unknown[]; plain?: unknown[] };
let fixtures: Map<unknown, Fixture>;

function builder(table: unknown) {
  const state = { grouped: false };
  const resolve = () => {
    const f = fixtures.get(table) ?? {};
    if (state.grouped) return f.group ?? [];
    return f.plain ?? [];
  };
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const b: any = {
    innerJoin: () => b,
    leftJoin: () => b,
    where: () => b,
    groupBy: () => {
      state.grouped = true;
      return b;
    },
    having: () => b,
    orderBy: () => b,
    limit: () => b,
    then: (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej),
  };
  return b;
}

vi.mock("@workspace/db", () => ({
  db: { select: () => ({ from: (t: unknown) => builder(t) }) },
  ...T,
}));

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

vi.mock("../../modules/ai-assistant/email", () => ({
  normalizeText: (s: string) => (s || "").trim(),
}));

// `find_missing_records` reads the authoritative table registry, so its test
// supplies a registry entry whose `.table` carries a drizzle columns symbol.
const missingTable = {
  _: "purchase_orders",
  [Symbol.for("drizzle:Columns")]: { internalPoNo: { name: "internal_po_no" } },
};
vi.mock("../../modules/ai-assistant/db-tools", () => ({
  TABLES: { purchase_orders: { table: missingTable } },
}));

const {
  getPurchaseOrderStatus,
  getSupplierPerformance,
  aggregatePoItems,
  getUnfulfilledOrders,
  getLatestSupplierPrice,
  getOpenSupplierInvoices,
  detectDuplicates,
  findMissingRecords,
} = await import("../../modules/ai-assistant/procurement-tools");

beforeEach(() => {
  fixtures = new Map();
  // The lazy registry mock is shared; point it at the shared table object.
  (missingTable as unknown as { _: string })._ = "purchase_orders";
  void missingTable;
});

describe("evidence envelope", () => {
  it("marks an incomplete result PARTIALLY_VERIFIED even with no warning text", async () => {
    // The census bug in miniature: a capped list must never read as complete.
    fixtures.set(T.purchaseOrderItemsTable, {
      group: [{ partNo: "A", description: "A", occurrences: 3, poCount: 3, totalQty: 10 }],
      plain: [{ n: 1000 }],
    });
    const res = await aggregatePoItems({ limit: 1 });
    expect(res.isComplete).toBe(false);
    expect(res.confidence).toBe("PARTIALLY_VERIFIED");
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it("marks a complete, warning-free result VERIFIED", async () => {
    fixtures.set(T.purchaseOrderItemsTable, {
      group: [{ partNo: "A", description: "A", occurrences: 2, poCount: 2, totalQty: 10 }],
      plain: [{ n: 1 }],
    });
    const res = await aggregatePoItems({ limit: 20 });
    expect(res.isComplete).toBe(true);
    expect(res.confidence).toBe("VERIFIED");
  });
});

describe("get_purchase_order_status", () => {
  it("resolves supplier names for items and rolls up received quantity", async () => {
    fixtures.set(T.purchaseOrdersTable, {
      plain: [{ id: 1, internalPoNo: "P26E1", sheetPoNo: "104", status: "sent" }],
    });
    fixtures.set(T.purchaseOrderItemsTable, {
      plain: [
        {
          poId: 1,
          supplierId: 5,
          qty: 100,
          totalReceivedQty: 60,
          totalAcceptedQty: 60,
          lineStatus: "partial",
        },
        {
          poId: 1,
          supplierId: 5,
          qty: 50,
          totalReceivedQty: 0,
          totalAcceptedQty: 0,
          lineStatus: "pending",
        },
      ],
    });
    fixtures.set(T.suppliersTable, { plain: [{ id: 5, name: "هاي فولت" }] });

    const res = await getPurchaseOrderStatus("P26E1");
    const data = res.data as { found: boolean; orders: any[] };
    expect(data.found).toBe(true);
    const order = data.orders[0];
    expect(order.totalQty).toBe(150);
    expect(order.receivedQty).toBe(60);
    expect(order.suppliers[0].supplierName).toBe("هاي فولت");
    expect(res.source).toContain("purchase_orders");
    expect(res.method).toBeTruthy();
  });

  it("returns a clear, complete 'not found' rather than an empty success", async () => {
    fixtures.set(T.purchaseOrdersTable, { plain: [] });
    const res = await getPurchaseOrderStatus("NOPE");
    expect((res.data as any).found).toBe(false);
    expect(res.recordCount).toBe(0);
    expect(res.warnings[0]).toContain("لا يوجد");
  });
});

describe("get_supplier_performance", () => {
  it("computes acceptance rate from the SQL sums", async () => {
    fixtures.set(T.suppliersTable, { plain: [{ id: 5, name: "هاي فولت" }] });
    fixtures.set(T.purchaseOrderItemsTable, {
      group: [
        {
          supplierId: 5,
          itemCount: 2,
          poCount: 1,
          totalQty: 200,
          acceptedQty: 150,
          rejectedQty: 50,
          rejectedLines: 0,
        },
      ],
    });
    fixtures.set(T.offersTable, {
      group: [{ supplierId: 5, offerCount: 4, lastOfferAt: "2026-01-01" }],
    });

    const res = await getSupplierPerformance({ supplier: "هاي فولت" });
    const s = (res.data as any).suppliers[0];
    expect(s.acceptanceRate).toBe(0.75);
    expect(s.offerCount).toBe(4);
    expect(res.filters).toEqual({ supplier: "هاي فولت", sinceDays: null });
  });

  it("warns when the term matched several suppliers", async () => {
    fixtures.set(T.suppliersTable, {
      plain: [
        { id: 5, name: "هاي فولت" },
        { id: 6, name: "هاي فولت للتوريدات" },
      ],
    });
    fixtures.set(T.purchaseOrderItemsTable, { group: [] });
    fixtures.set(T.offersTable, { group: [] });
    const res = await getSupplierPerformance({ supplier: "هاي فولت" });
    expect(res.warnings.join(" ")).toContain("موردين");
  });
});

describe("aggregate_po_items", () => {
  it("surfaces the grouping row and echoes the ordering", async () => {
    fixtures.set(T.purchaseOrderItemsTable, {
      group: [
        { partNo: "0600", description: "GENRAL", occurrences: 134, poCount: 134, totalQty: 900 },
      ],
      plain: [{ n: 3 }],
    });
    const res = await aggregatePoItems({ by: "occurrences", limit: 20 });
    expect((res.data as any).ordering).toBe("occurrences");
    expect((res.data as any).items[0].occurrences).toBe(134);
    expect(res.method).toContain("مرات الورود");
  });

  it("warns when the ranking was capped", async () => {
    fixtures.set(T.purchaseOrderItemsTable, {
      group: [{ partNo: "A", description: "A", occurrences: 1, poCount: 1, totalQty: 1 }],
      plain: [{ n: 50 }],
    });
    const res = await aggregatePoItems({ limit: 1 });
    expect(res.warnings[0]).toContain("أعلى");
  });
});

describe("get_unfulfilled_orders", () => {
  it("returns the open PO rows with the supplier resolved", async () => {
    fixtures.set(T.purchaseOrderItemsTable, {
      group: [
        {
          poId: 1,
          internalPoNo: "P26E1",
          sheetPoNo: "104",
          status: "sent",
          createdAt: "2026-01-01",
          openLines: 2,
          openQty: 150,
          supplierName: "هاي فولت",
        },
      ],
    });
    const res = await getUnfulfilledOrders({});
    expect((res.data as any).orders[0].supplierName).toBe("هاي فولت");
    expect(res.isComplete).toBe(true);
  });
});

describe("get_latest_supplier_price", () => {
  it("orders by date descending and picks the latest as `latest`", async () => {
    fixtures.set(T.purchaseOrderItemsTable, {
      plain: [
        { price: "100", date: "2026-01-01", partNo: "A", supplierId: 5, poId: 1 },
        { price: "120", date: "2026-05-01", partNo: "A", supplierId: 5, poId: 2 },
      ],
    });
    fixtures.set(T.offerItemsTable, { plain: [] });
    fixtures.set(T.offersTable, { plain: [] });

    const res = await getLatestSupplierPrice({ partNo: "A" });
    const data = res.data as any;
    expect(data.latest.price).toBe(120);
    expect(data.prices[0].date).toBe("2026-05-01");
  });

  it("reports a clear warning when no price exists", async () => {
    fixtures.set(T.purchaseOrderItemsTable, { plain: [] });
    fixtures.set(T.offerItemsTable, { plain: [] });
    fixtures.set(T.offersTable, { plain: [] });
    const res = await getLatestSupplierPrice({ partNo: "ZZZ" });
    expect((res.data as any).prices).toEqual([]);
    expect(res.warnings[0]).toContain("لا يوجد سعر");
  });

  it("requires a part to search for", async () => {
    const res = await getLatestSupplierPrice({});
    expect(res.warnings[0]).toContain("حدّد");
  });
});

describe("get_open_supplier_invoices", () => {
  it("totals the outstanding balance", async () => {
    fixtures.set(T.supplierInvoicesTable, {
      plain: [
        { invoiceNo: "SI-1", supplierName: "A", balance: "150.5" },
        { invoiceNo: "SI-2", supplierName: "B", balance: "49.5" },
      ],
    });
    const res = await getOpenSupplierInvoices({});
    const data = res.data as any;
    expect(data.totalBalance).toBe(200);
    expect(res.recordCount).toBe(2);
  });
});

describe("detect_duplicates", () => {
  it("returns the duplicate values", async () => {
    fixtures.set(T.purchaseOrdersTable, {
      group: [{ value: "104", occurrences: 3 }],
    });
    // `detect_duplicates` validates the column against the drizzle column map,
    // so the mocked table must expose one.
    (T.purchaseOrdersTable as unknown as Record<symbol, unknown>)[Symbol.for("drizzle:Columns")] = {
      internalPoNo: { name: "internal_po_no" },
    };
    const res = await detectDuplicates({ table: "purchase_orders", column: "internalPoNo" });
    expect((res.data as any).duplicates[0].occurrences).toBe(3);
    expect(res.source).toContain("internalPoNo");
  });

  it("warns about an unknown column instead of throwing", async () => {
    const res = await detectDuplicates({ table: "suppliers", column: "nope" });
    expect(res.warnings[0]).toContain("غير موجود");
  });
});

describe("find_missing_records", () => {
  it("returns the numbers absent from the database, ignoring case/spaces", async () => {
    fixtures.set(missingTable, { plain: [{ value: "P26E1" }] });
    const res = await findMissingRecords({
      numbers: ["p26e1", "P26E2"],
      table: "purchase_orders",
      column: "internalPoNo",
    });
    const data = res.data as any;
    expect(data.missing).toEqual(["P26E2"]);
    expect(data.presentCount).toBe(1);
    expect(data.checkedCount).toBe(2);
  });
});
