/**
 * Item price analysis — تحليل البنود والاتجاه السعري.
 *
 * The live failure this feature exists to prevent: the operator searched an item
 * and got one card PER RFQ line, so the same article quoted ten times showed ten
 * unrelated prices and no trend could be read. Prices are also stored on two
 * bases (`tax_included` true/false), and comparing a VAT-inclusive quote against
 * a VAT-exclusive one reports a price movement that never happened.
 *
 * Each guard below fails against the naive implementation it replaces:
 *  - no clustering → «one item per RFQ line» (test: one item, one price history)
 *  - no VAT normalisation → a false +14% move (test: 114 incl. == 100 net)
 *  - counting empty quotes → a zero average (test: zero-price counted separately)
 *  - first-vs-last trend → a direction flipped by one outlier (test: halves)
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("drizzle-orm", () => ({
  eq: (left: any, right: any) => ({ __op: "eq", left, right }),
  ne: (left: any, right: any) => ({ __op: "ne", left, right }),
  and: (...args: any[]) => ({ __op: "and", args }),
  or: (...args: any[]) => ({ __op: "or", args }),
  inArray: (left: any, right: any) => ({ __op: "inArray", left, right }),
  ilike: (left: any, right: any) => ({ __op: "ilike", left, right }),
  sql: Object.assign((strings: any, ...values: any[]) => ({ __op: "sql", strings, values }), {
    raw: (s: string) => ({ __op: "sql.raw", s }),
  }),
}));

// ── Table handles (identity matters — the routes match by reference) ─────────
const rfqItemsTable = {
  _: "rfqItems",
  id: "id",
  rfqId: "rfqId",
  partNo: "partNo",
  lineItem: "lineItem",
  description: "description",
  uom: "uom",
  qty: "qty",
  categoryId: "categoryId",
};
const rfqTable = {
  _: "rfq",
  id: "id",
  internalRfqNo: "internalRfqNo",
  customerRfqNo: "customerRfqNo",
  createdAt: "createdAt",
};
const customerRfqItemsTable = {
  _: "customerRfqItems",
  id: "id",
  customerRfqId: "customerRfqId",
  partNo: "partNo",
  lineItem: "lineItem",
  description: "description",
  uom: "uom",
  qty: "qty",
  categoryId: "categoryId",
};
const customerRfqsTable = {
  _: "customerRfqs",
  id: "id",
  customerRfqNo: "customerRfqNo",
  internalNo: "internalNo",
  customerId: "customerId",
  customerName: "customerName",
  createdAt: "createdAt",
};
const customersTable = { _: "customers", id: "id", name: "name" };
const offerItemsTable = {
  _: "offerItems",
  offerId: "offerId",
  rfqItemId: "rfqItemId",
  price: "price",
  taxIncluded: "taxIncluded",
  isApproved: "isApproved",
};
const offersTable = {
  _: "offers",
  id: "id",
  supplierId: "supplierId",
  sentLogId: "sentLogId",
  employeeId: "employeeId",
  createdAt: "createdAt",
};
const suppliersTable = { _: "suppliers", id: "id", name: "name" };
const employeesTable = { _: "employees", id: "id", name: "name" };
const sentLogTable = { _: "sentLog", id: "id", employeeId: "employeeId" };
const itemCategoriesTable = { _: "itemCategories", id: "id", name: "name" };
const taxSettingsTable = { _: "taxSettings" };
const purchaseOrdersTable = {
  _: "purchaseOrders",
  id: "id",
  internalPoNo: "internalPoNo",
  status: "status",
  rfqId: "rfqId",
};
const purchaseOrderItemsTable = {
  _: "purchaseOrderItems",
  id: "id",
  poId: "poId",
  supplierId: "supplierId",
  lineItem: "lineItem",
  partNo: "partNo",
  lineStatus: "lineStatus",
  customerPoItemId: "customerPoItemId",
};
const customerPoItemsTable = {
  _: "customerPoItems",
  id: "id",
  customerRfqItemId: "customerRfqItemId",
};

// ── Per-test fixtures ────────────────────────────────────────────────────────
let supplierItemRows: any[];
let customerItemRows: any[];
let priceRows: any[];
let employeeRows: any[];
let categoryRows: any[];
let taxRows: any[];
let poLineRows: any[];
/** The `where(...)` argument the issued-PO query was built with. */
let poWhereArg: any;
let selectCount: number;
let offerSeq: number;

function chainable(value: any): any {
  const obj: any = {
    then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject),
  };
  const self = () => obj;
  obj.where = vi.fn(self);
  obj.innerJoin = vi.fn(self);
  obj.leftJoin = vi.fn(self);
  obj.orderBy = vi.fn(self);
  obj.groupBy = vi.fn(self);
  obj.having = vi.fn(self);
  obj.limit = vi.fn(self);
  return obj;
}

/**
 * The issued-PO query's builder. Records the `where(...)` argument so a test can
 * assert the cancellation filter is really applied — the returned rows bypass
 * SQL, so without this the filter could be deleted and every test still pass.
 */
function poChainable(value: any): any {
  const obj = chainable(value);
  obj.where = vi.fn((arg: any) => {
    poWhereArg = arg;
    return obj;
  });
  return obj;
}

/** Every `ne(...)` comparison inside a (possibly nested) `and(...)` clause. */
function neComparisons(node: any): Array<{ left: unknown; right: unknown }> {
  if (!node || typeof node !== "object") return [];
  if (node.__op === "ne") return [{ left: node.left, right: node.right }];
  if (node.__op === "and") return (node.args ?? []).flatMap(neComparisons);
  return [];
}

const dbMock: any = {
  select: vi.fn((_arg?: any) => {
    selectCount += 1;
    return {
      from: vi.fn((table: any) => {
        if (table === rfqItemsTable) return chainable(supplierItemRows);
        if (table === customerRfqItemsTable) return chainable(customerItemRows);
        if (table === offerItemsTable) return chainable(priceRows);
        if (table === employeesTable) return chainable(employeeRows);
        if (table === itemCategoriesTable) return chainable(categoryRows);
        if (table === taxSettingsTable) return chainable(taxRows);
        if (table === purchaseOrderItemsTable) return poChainable(poLineRows);
        return chainable([]);
      }),
    };
  }),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  rfqItemsTable,
  rfqTable,
  customerRfqItemsTable,
  customerRfqsTable,
  customersTable,
  offerItemsTable,
  offersTable,
  suppliersTable,
  employeesTable,
  sentLogTable,
  itemCategoriesTable,
  taxSettingsTable,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
  customerPoItemsTable,
}));

let testApp: express.Express;
let mod: typeof import("../../modules/rfq/item-analysis");
// Type-only import: `mod` is a runtime binding, so it cannot be used as a
// namespace for type annotations.
type PricePoint = import("../../modules/rfq/item-analysis").PricePoint;

beforeAll(async () => {
  mod = await import("../../modules/rfq/item-analysis");
  testApp = express();
  testApp.use(express.json());
  testApp.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    req.session = { employeeId: 1, role: "admin" };
    next();
  });
  testApp.use("/api", mod.default);
});

beforeEach(() => {
  vi.clearAllMocks();
  supplierItemRows = [];
  customerItemRows = [];
  priceRows = [];
  employeeRows = [];
  categoryRows = [];
  taxRows = [{ id: 1, vatRate: "14", withholdingRate: "3" }];
  poLineRows = [];
  poWhereArg = undefined;
  selectCount = 0;
  offerSeq = 1000;
});

// ── Identity (pure) ──────────────────────────────────────────────────────────

describe("item identity for clustering", () => {
  it("treats an ERP article code as an identity, a bare row number as not one", () => {
    expect(mod.looksLikeErpCode("1531.032.GENRAL.7513")).toBe(true);
    expect(mod.looksLikeErpCode("5720.006.GENRAL.0089")).toBe(true);
    expect(mod.looksLikeErpCode("10")).toBe(false);
    expect(mod.looksLikeErpCode("12345")).toBe(false);
    expect(mod.looksLikeErpCode("")).toBe(false);
    expect(mod.looksLikeErpCode(null)).toBe(false);
  });

  it("keys a row part no → ERP code → folded description", () => {
    expect(
      mod.clusterKeyOf({ partNo: "LC1D-32M7", lineItem: "1531.032.X", description: "x" }),
    ).toBe("pn:LC1D32M7");
    expect(
      mod.clusterKeyOf({ partNo: null, lineItem: "1531.032.GENRAL.7513", description: "x" }),
    ).toBe("li:1531.032.genral.7513");
    // A short bare number is NOT an article code, so the description is used.
    expect(mod.clusterKeyOf({ partNo: null, lineItem: "10", description: "Cable 3x2.5" })).toBe(
      "desc:cable 3x2 5",
    );
    expect(mod.clusterKeyOf({ partNo: null, lineItem: null, description: "  " })).toBe("raw:");
  });

  it("parses a key back into its kind, rejecting an unknown kind", () => {
    expect(mod.parseClusterKey("pn:LC1D32M7")).toEqual({ kind: "pn", value: "LC1D32M7" });
    expect(mod.parseClusterKey("li:abc")).toEqual({ kind: "li", value: "abc" });
    expect(mod.parseClusterKey("desc:cable 3x2.5")).toEqual({ kind: "desc", value: "cable 3x2.5" });
    expect(mod.parseClusterKey("nope:x")).toBeNull();
    expect(mod.parseClusterKey("pn")).toBeNull();
  });
});

// ── Price statistics (pure) ──────────────────────────────────────────────────

function pt(price: number, date: string | null, opts: Partial<PricePoint> = {}): PricePoint {
  return {
    rfqItemId: 1,
    offerId: opts.offerId ?? ++offerSeq,
    date,
    supplierId: 1,
    supplierName: "S",
    price,
    priceNet: price,
    taxIncluded: false,
    rfqId: 1,
    internalRfqNo: "CRQ-1",
    customerRfqNo: null,
    employeeId: null,
    employeeName: null,
    isApproved: false,
    lineItem: null,
    partNo: null,
    customerRfqItemId: null,
    poNos: [],
    ...opts,
  };
}

describe("computePriceStats", () => {
  it("counts an empty quote separately instead of averaging it as zero", () => {
    const stats = mod.computePriceStats([
      pt(100, "2026-01-01T00:00:00Z"),
      pt(0, "2026-01-02T00:00:00Z"),
      pt(200, "2026-01-03T00:00:00Z"),
    ]);
    expect(stats.pricedCount).toBe(2);
    expect(stats.zeroPriceCount).toBe(1);
    expect(stats.avgPriceNet).toBe(150); // NOT 100 (which a zero-inclusive mean gives)
    expect(stats.minPriceNet).toBe(100);
  });

  it("says 'insufficient' rather than guessing a direction from one price", () => {
    const stats = mod.computePriceStats([pt(100, "2026-01-01T00:00:00Z")]);
    expect(stats.direction).toBe("insufficient");
    expect(stats.changePct).toBeNull();
    // Two prices is still not a trend.
    const two = mod.computePriceStats([
      pt(100, "2026-01-01T00:00:00Z"),
      pt(400, "2026-02-01T00:00:00Z"),
    ]);
    expect(two.direction).toBe("insufficient");
  });

  it("measures the trend across halves, so one outlier cannot flip the direction", () => {
    // first-vs-last would read 100 → 100 = flat; the halves read -81.8% (down).
    const stats = mod.computePriceStats([
      pt(100, "2026-01-01T00:00:00Z"),
      pt(1000, "2026-02-01T00:00:00Z"),
      pt(100, "2026-03-01T00:00:00Z"),
      pt(100, "2026-04-01T00:00:00Z"),
    ]);
    expect(stats.direction).toBe("down");
    expect(stats.changePct).toBe(-81.82);
  });

  it("reports a small move as flat, and a real rise as up", () => {
    const flat = mod.computePriceStats([
      pt(100, "2026-01-01T00:00:00Z"),
      pt(101, "2026-02-01T00:00:00Z"),
      pt(102, "2026-03-01T00:00:00Z"),
      pt(101, "2026-04-01T00:00:00Z"),
    ]);
    expect(flat.direction).toBe("flat");
    const up = mod.computePriceStats([
      pt(100, "2026-01-01T00:00:00Z"),
      pt(110, "2026-02-01T00:00:00Z"),
      pt(150, "2026-03-01T00:00:00Z"),
      pt(160, "2026-04-01T00:00:00Z"),
    ]);
    expect(up.direction).toBe("up");
    expect(up.changePct).toBe(47.62);
  });

  it("builds a monthly series from the priced quotes only", () => {
    const stats = mod.computePriceStats([
      pt(100, "2026-01-05T00:00:00Z"),
      pt(200, "2026-01-20T00:00:00Z"),
      pt(0, "2026-01-25T00:00:00Z"),
      pt(300, "2026-02-01T00:00:00Z"),
    ]);
    expect(stats.series).toEqual([
      { month: "2026-01", avgPriceNet: 150, count: 2 },
      { month: "2026-02", avgPriceNet: 300, count: 1 },
    ]);
  });

  it("counts one supplier quote ONCE even when the RFQ lists the article on three lines", () => {
    // The live shape: RFQ CRQ-2026-000135 carries the same contactor on 3 lines,
    // and each supplier's single quote is stored once per line. Counted as three
    // observations the quote is triple-weighted in every average and the history
    // shows the same offer repeated.
    const rows = [
      pt(3258.78, "2026-08-10T00:00:00Z", { offerId: 100, rfqItemId: 651 }),
      pt(3258.78, "2026-08-10T00:00:00Z", { offerId: 100, rfqItemId: 654 }),
      pt(3258.78, "2026-08-10T00:00:00Z", { offerId: 100, rfqItemId: 659 }),
      pt(3460, "2026-08-10T00:00:00Z", { offerId: 108, rfqItemId: 651 }),
      pt(3460, "2026-08-10T00:00:00Z", { offerId: 108, rfqItemId: 654 }),
      pt(3460, "2026-08-10T00:00:00Z", { offerId: 108, rfqItemId: 659 }),
    ];
    const deduped = mod.dedupePriceObservations(rows);
    expect(deduped).toHaveLength(2); // NOT 6

    const stats = mod.computePriceStats(deduped);
    // Two suppliers at 3258.78 and 3460 → the mean is 3359.39, not the
    // 3:3-weighted value a per-line count would give (identical here, so also
    // assert the count that would have been wrong).
    expect(stats.pricedCount).toBe(2);
    expect(stats.avgPriceNet).toBe(3359.39);
  });

  it("keeps two DIFFERENT prices from the same offer — that is two observations", () => {
    const rows = [
      pt(100, "2026-08-10T00:00:00Z", { offerId: 100, rfqItemId: 1 }),
      pt(150, "2026-08-10T00:00:00Z", { offerId: 100, rfqItemId: 2 }),
    ];
    expect(mod.dedupePriceObservations(rows)).toHaveLength(2);
  });
});

describe("summariseBySupplier", () => {
  it("rolls up per supplier, cheapest first, ignoring empty quotes", () => {
    const out = mod.summariseBySupplier([
      pt(300, "2026-01-01T00:00:00Z", { supplierId: 1, supplierName: "A" }),
      pt(200, "2026-02-01T00:00:00Z", { supplierId: 1, supplierName: "A" }),
      pt(0, "2026-03-01T00:00:00Z", { supplierId: 2, supplierName: "B" }),
      pt(100, "2026-04-01T00:00:00Z", { supplierId: 3, supplierName: "C" }),
    ]);
    expect(out.map((s) => s.supplierName)).toEqual(["C", "A"]);
    const a = out.find((s) => s.supplierName === "A")!;
    expect(a.quotedCount).toBe(2);
    expect(a.minPriceNet).toBe(200);
    expect(a.lastPriceNet).toBe(200);
    expect(a.avgPriceNet).toBe(250);
    // B only ever sent an empty quote, so it is not a "supplier" of a price.
    expect(out.some((s) => s.supplierName === "B")).toBe(false);
  });
});

// ── Search route ─────────────────────────────────────────────────────────────

function supplierItem(over: any = {}) {
  return {
    rfqItemId: 1,
    rfqId: 1,
    internalRfqNo: "CRQ-2026-000001",
    customerRfqNo: null,
    partNo: "LC1D32M7",
    lineItem: "1531.032.GENRAL.7513",
    description: "P/N : LC1D 32 M7 , SCHNIEDER CONTACTOR",
    uom: "PCS",
    qty: "2",
    categoryId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function priceRow(over: any = {}) {
  return {
    rfqItemId: 1,
    // Each fixture row is a DISTINCT offer by default, so a test that does not
    // care about offer identity is not accidentally collapsed by the dedupe.
    offerId: ++offerSeq,
    price: "100",
    taxIncluded: false,
    isApproved: false,
    offerCreatedAt: new Date("2026-01-01T00:00:00Z"),
    offerEmployeeId: 7,
    sentEmployeeId: 7,
    supplierId: 1,
    supplierName: "H-EMAS",
    rfqId: 1,
    internalRfqNo: "CRQ-2026-000001",
    customerRfqNo: null,
    // Identity keys the issued-PO match reads off the quote's own line.
    lineItem: "1531.032.GENRAL.7513",
    partNo: "LC1D32M7",
    customerRfqItemId: null,
    ...over,
  };
}

describe("search-term normalisation", () => {
  it("reduces a term to uppercase alphanumerics so punctuation cannot hide a match", () => {
    expect(mod.normalizeSearchToken("LC1D32M7")).toBe("LC1D32M7");
    expect(mod.normalizeSearchToken("lc1d 32 m7")).toBe("LC1D32M7");
    expect(mod.normalizeSearchToken("LC1D-32/M7")).toBe("LC1D32M7");
    expect(mod.normalizeSearchToken("  1531.032.GENRAL.7513 ")).toBe("1531032GENRAL7513");
  });

  it("builds a WHERE clause that matches the NORMALISED form, not only the raw term", () => {
    // The operator types «LC1D32M7» while the ERP stores «LC1D 32 M7». A raw
    // substring match finds nothing and the item looks absent — so the clause
    // must carry the normalised term as well.
    const clause: any = mod.buildItemMatch(
      { description: "d", partNo: "p", lineItem: "l" },
      "LC1D32M7",
    );
    const flat = JSON.stringify(clause);
    expect(flat).toContain("LC1D32M7");
    expect(flat).toContain("regexp_replace");
    // The raw phrase stays for prose searches («circuit breaker»).
    expect(clause.__op).toBe("or");
    expect(clause.args.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps a one-character term out of the normalised clauses", () => {
    const clause: any = mod.buildItemMatch({ description: "d", partNo: "p", lineItem: "l" }, "L");
    expect(clause.args).toHaveLength(1); // only the raw-description clause
  });
});

describe("GET /items/analysis/search", () => {
  it("groups the same article quoted on several RFQs into ONE item", async () => {
    supplierItemRows = [
      supplierItem({ rfqItemId: 651, rfqId: 181 }),
      supplierItem({ rfqItemId: 654, rfqId: 182 }),
      supplierItem({
        rfqItemId: 1180,
        rfqId: 315,
        description: "P/N : LC1D 32 M7 , SCHNIEDER CONTACTOR FRANCE",
      }),
    ];
    priceRows = [
      priceRow({ rfqItemId: 651, price: "3390", supplierId: 1, supplierName: "الشركة العالمية" }),
      priceRow({ rfqItemId: 654, price: "3460", supplierId: 2, supplierName: "هاي فولت" }),
      priceRow({ rfqItemId: 1180, price: "3180", supplierId: 3, supplierName: "H-EMAS" }),
    ];

    const res = await request(testApp).get("/api/items/analysis/search?q=LC1D32M7");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1); // NOT three
    const item = res.body.items[0];
    expect(item.key).toBe("pn:LC1D32M7");
    expect(item.pricedCount).toBe(3);
    expect(item.supplierCount).toBe(3);
    expect(item.supplierRfqCount).toBe(3);
    expect(item.minPriceNet).toBe(3180);
    expect(item.maxPriceNet).toBe(3460);
  });

  it("folds a description-only row into the part-numbered cluster", async () => {
    // The operator's real case: one RFQ prints the code, the next identifies the
    // article by description alone. It is ONE item, not two.
    supplierItemRows = [
      supplierItem({ rfqItemId: 1, rfqId: 1 }),
      supplierItem({
        rfqItemId: 2,
        rfqId: 2,
        partNo: null,
        lineItem: null,
        description: "P/N : LC1D 32 M7 , SCHNIEDER CONTACTOR FRANCE TELE",
      }),
    ];
    priceRows = [priceRow({ rfqItemId: 1, price: "100" })];

    const res = await request(testApp).get("/api/items/analysis/search?q=LC1D");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].key).toBe("pn:LC1D32M7");
  });

  it("does not merge two different part numbers", async () => {
    supplierItemRows = [
      supplierItem({ rfqItemId: 1, partNo: "AAA111" }),
      supplierItem({ rfqItemId: 2, partNo: "BBB222" }),
    ];
    const res = await request(testApp).get("/api/items/analysis/search?q=con");
    expect(res.body.items).toHaveLength(2);
  });

  it("returns nothing (and touches no table) for a term shorter than two characters", async () => {
    const res = await request(testApp).get("/api/items/analysis/search?q=L");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(selectCount).toBe(0);
  });

  it("includes the customer requests the item appeared on", async () => {
    supplierItemRows = [supplierItem()];
    customerItemRows = [
      {
        customerRfqItemId: 900,
        customerRfqId: 10,
        customerRfqNo: "CRFQ-2026-000010",
        internalNo: "100",
        customerName: "EDC",
        storedCustomerName: null,
        partNo: "LC1D32M7",
        lineItem: null,
        description: "CONTACTOR",
        uom: "PCS",
        qty: "5",
        categoryId: null,
        createdAt: new Date("2026-02-01T00:00:00Z"),
      },
    ];
    priceRows = [priceRow()];
    const res = await request(testApp).get("/api/items/analysis/search?q=LC1D32M7");
    const item = res.body.items[0];
    expect(item.requestCount).toBe(1);
    expect(item.totalQty).toBe(7); // 2 from the RFQ line + 5 from the request
  });
});

// ── Detail route ─────────────────────────────────────────────────────────────

describe("GET /items/analysis/item", () => {
  it("rejects a malformed key with 400 and an unknown item with 404", async () => {
    expect((await request(testApp).get("/api/items/analysis/item?key=nope")).status).toBe(400);
    expect((await request(testApp).get("/api/items/analysis/item")).status).toBe(400);
    supplierItemRows = [];
    const res = await request(testApp).get("/api/items/analysis/item?key=pn%3ANOTHING");
    expect(res.status).toBe(404);
  });

  it("normalises a VAT-inclusive quote to a comparable net price", async () => {
    supplierItemRows = [supplierItem()];
    priceRows = [
      priceRow({
        rfqItemId: 1,
        price: "114",
        taxIncluded: true,
        offerCreatedAt: new Date("2026-01-01T00:00:00Z"),
      }),
      priceRow({
        rfqItemId: 1,
        price: "100",
        taxIncluded: false,
        offerCreatedAt: new Date("2026-02-01T00:00:00Z"),
      }),
      priceRow({
        rfqItemId: 1,
        price: "114",
        taxIncluded: true,
        offerCreatedAt: new Date("2026-03-01T00:00:00Z"),
      }),
    ];
    const res = await request(testApp).get("/api/items/analysis/item?key=pn%3ALC1D32M7");
    expect(res.status).toBe(200);
    const nets = res.body.priceHistory.map((p: any) => p.priceNet);
    // 114 incl. VAT at 14% is 100 net — identical to the exclusive quote, so the
    // change is flat rather than a false +14%.
    expect(nets).toEqual([100, 100, 100]);
    expect(res.body.stats.changePct).toBe(0);
    expect(res.body.stats.direction).toBe("flat");
  });

  it("returns the full analysis: trend, history with supplier + employee, requests", async () => {
    supplierItemRows = [supplierItem({ categoryId: 4 })];
    categoryRows = [{ id: 4, name: "كهرباء" }];
    employeeRows = [{ id: 7, name: "Ahmed youssef" }];
    customerItemRows = [
      {
        customerRfqItemId: 900,
        customerRfqId: 10,
        customerRfqNo: "CRFQ-2026-000010",
        internalNo: "100",
        customerName: "EDC",
        storedCustomerName: null,
        partNo: "LC1D32M7",
        lineItem: null,
        description: "CONTACTOR",
        uom: "PCS",
        qty: "5",
        categoryId: 4,
        createdAt: new Date("2026-02-01T00:00:00Z"),
      },
    ];
    priceRows = [
      priceRow({
        rfqItemId: 1,
        price: "3460",
        offerCreatedAt: new Date("2026-03-01T00:00:00Z"),
        supplierId: 2,
        supplierName: "هاي فولت",
      }),
      priceRow({
        rfqItemId: 1,
        price: "3180",
        offerCreatedAt: new Date("2026-01-15T00:00:00Z"),
        supplierId: 1,
        supplierName: "H-EMAS",
      }),
      priceRow({
        rfqItemId: 1,
        price: "0",
        offerCreatedAt: new Date("2026-02-10T00:00:00Z"),
        supplierId: 3,
        supplierName: "بدون عرض",
      }),
    ];

    const res = await request(testApp).get("/api/items/analysis/item?key=pn%3ALC1D32M7");
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.vatRate).toBe(14);
    expect(body.categoryName).toBe("كهرباء");
    expect(body.description).toBe("P/N : LC1D 32 M7 , SCHNIEDER CONTACTOR");

    // History is chronological, and the empty quote is still visible.
    expect(body.priceHistory.map((p: any) => p.date.slice(0, 10))).toEqual([
      "2026-01-15",
      "2026-02-10",
      "2026-03-01",
    ]);
    expect(body.priceHistory[1].price).toBe(0);
    expect(body.stats.pricedCount).toBe(2);
    expect(body.stats.zeroPriceCount).toBe(1);
    expect(body.stats.lastSupplierName).toBe("هاي فولت");

    // The employee who brought the price is named, from the sent-log row.
    expect(body.priceHistory[0].employeeName).toBe("Ahmed youssef");
    expect(body.suppliers).toHaveLength(2); // the empty quote is not a supplier price
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].customerRfqNo).toBe("CRFQ-2026-000010");
  });
});

// ── Issued supplier PO number on each price ──────────────────────────────────
//
// The operator's requirement: the supplier PO number must appear beside a price
// WHEN an order was issued to that supplier for that article, and must NOT
// appear when the order was cancelled.

/** A live PO line as `loadIssuedPoLines` returns it (already cancellation-filtered). */
function poLine(over: any = {}) {
  return {
    poId: 900,
    poNo: "PO-2026-000041",
    supplierId: 1,
    rfqId: 1,
    lineItem: "1531.032.GENRAL.7513",
    partNo: "LC1D32M7",
    customerRfqItemId: null,
    ...over,
  };
}

/** The order numbers of a match result — the rung assertions only care about these. */
function poNos(refs: Array<{ poNo: string }>): string[] {
  return refs.map((r) => r.poNo);
}

describe("matchIssuedPos", () => {
  it("links on the customer-request line both the quote and the PO were raised from", () => {
    // The strongest rung, and the only one that survives a PO with no rfq_id.
    const quote = pt(100, "2026-01-01", {
      supplierId: 7,
      customerRfqItemId: 900,
      rfqId: null,
      lineItem: null,
      partNo: null,
    });
    const lines = [
      poLine({
        poNo: "PO-1",
        supplierId: 7,
        rfqId: null,
        lineItem: null,
        partNo: null,
        customerRfqItemId: 900,
      }),
      poLine({
        poNo: "PO-2",
        supplierId: 7,
        rfqId: null,
        lineItem: null,
        partNo: null,
        customerRfqItemId: 901,
      }),
    ];
    expect(poNos(mod.matchIssuedPos(quote, lines))).toEqual(["PO-1"]);
  });

  it("links on the line item code when there is no shared customer-request line", () => {
    const quote = pt(100, "2026-01-01", {
      supplierId: 7,
      lineItem: "1531.032.GENRAL.7513",
      partNo: null,
      customerRfqItemId: null,
    });
    const lines = [
      poLine({
        poNo: "PO-A",
        supplierId: 7,
        lineItem: "1531.032.GENRAL.7513",
        partNo: null,
        customerRfqItemId: null,
      }),
      poLine({
        poNo: "PO-B",
        supplierId: 7,
        lineItem: "1531.032.GENRAL.9999",
        partNo: null,
        customerRfqItemId: null,
      }),
    ];
    expect(poNos(mod.matchIssuedPos(quote, lines))).toEqual(["PO-A"]);
  });

  it("links on the part number even when it is written with spaces and dashes", () => {
    // `LC1D 32 M7` and `LC1D32M7` are one article — the ERP prints both forms.
    const quote = pt(100, "2026-01-01", {
      supplierId: 7,
      lineItem: null,
      partNo: "LC1D 32 M7",
      customerRfqItemId: null,
    });
    const lines = [
      poLine({
        poNo: "PO-C",
        supplierId: 7,
        lineItem: null,
        partNo: "LC1D32M7",
        customerRfqItemId: null,
      }),
    ];
    expect(poNos(mod.matchIssuedPos(quote, lines))).toEqual(["PO-C"]);
  });

  it("falls back to the request itself only when no stronger rung matched", () => {
    const quote = pt(100, "2026-01-01", {
      supplierId: 7,
      rfqId: 55,
      lineItem: "X1",
      partNo: null,
      customerRfqItemId: null,
    });
    const lines = [
      poLine({
        poNo: "PO-D",
        supplierId: 7,
        rfqId: 55,
        lineItem: "Y2",
        partNo: null,
        customerRfqItemId: null,
      }),
    ];
    expect(poNos(mod.matchIssuedPos(quote, lines))).toEqual(["PO-D"]);
  });

  it("never links a PO issued to a DIFFERENT supplier", () => {
    const quote = pt(100, "2026-01-01", { supplierId: 7, lineItem: "L1", partNo: null });
    const lines = [poLine({ poNo: "PO-E", supplierId: 8, lineItem: "L1", partNo: null })];
    expect(poNos(mod.matchIssuedPos(quote, lines))).toEqual([]);
  });

  it("returns nothing when the supplier has no order at all", () => {
    const quote = pt(100, "2026-01-01", { supplierId: 7 });
    expect(poNos(mod.matchIssuedPos(quote, []))).toEqual([]);
  });

  it("collects every matching order once, de-duplicated", () => {
    const quote = pt(100, "2026-01-01", {
      supplierId: 7,
      lineItem: "L1",
      partNo: null,
      customerRfqItemId: null,
    });
    const lines = [
      poLine({ poNo: "PO-F", supplierId: 7, lineItem: "L1", partNo: null }),
      poLine({ poNo: "PO-F", supplierId: 7, lineItem: "L1", partNo: null }),
      poLine({ poNo: "PO-G", supplierId: 7, lineItem: "L1", partNo: null }),
    ];
    expect(poNos(mod.matchIssuedPos(quote, lines))).toEqual(["PO-F", "PO-G"]);
  });
});

describe("issued supplier PO on the price history", () => {
  it("shows the PO number beside the price of the supplier who got the order", async () => {
    supplierItemRows = [supplierItem()];
    priceRows = [
      priceRow({
        offerId: 1,
        rfqItemId: 1,
        supplierId: 1,
        supplierName: "H-EMAS",
        price: "3180",
        offerCreatedAt: new Date("2026-01-15T00:00:00Z"),
      }),
      priceRow({
        offerId: 2,
        rfqItemId: 1,
        supplierId: 2,
        supplierName: "هاي فولت",
        price: "3460",
        offerCreatedAt: new Date("2026-03-01T00:00:00Z"),
      }),
    ];
    // Only H-EMAS was given the order.
    poLineRows = [poLine({ poNo: "PO-2026-000041", supplierId: 1 })];

    const res = await request(testApp).get("/api/items/analysis/item?key=pn%3ALC1D32M7");
    expect(res.status).toBe(200);
    const bySupplier = Object.fromEntries(
      res.body.priceHistory.map((p: any) => [p.supplierName, p.poNos.map((r: any) => r.poNo)]),
    );
    expect(bySupplier["H-EMAS"]).toEqual(["PO-2026-000041"]);
    // The other supplier quoted but was never ordered from.
    expect(bySupplier["هاي فولت"]).toEqual([]);

    expect(res.body.poSummary).toEqual({
      quotedWithPo: 1,
      poNumbers: ["PO-2026-000041"],
    });
  });

  it("does NOT show an order that was cancelled", async () => {
    // The loadIssuedPoLines query filters cancelled rows in SQL, so a cancelled
    // order is simply absent from `poLineRows` here — which is exactly what the
    // operator asked for: an cancelled order must not read as an issued one.
    supplierItemRows = [supplierItem()];
    priceRows = [
      priceRow({
        offerId: 1,
        rfqItemId: 1,
        supplierId: 1,
        supplierName: "H-EMAS",
        price: "3180",
        offerCreatedAt: new Date("2026-01-15T00:00:00Z"),
      }),
    ];
    poLineRows = [];

    const res = await request(testApp).get("/api/items/analysis/item?key=pn%3ALC1D32M7");
    expect(res.status).toBe(200);
    expect(res.body.priceHistory[0].poNos).toEqual([]);
    expect(res.body.poSummary.quotedWithPo).toBe(0);
    expect(res.body.poSummary.poNumbers).toEqual([]);
  });

  it("filters cancelled orders in SQL, on BOTH the header and the line", async () => {
    // The test above passes even with the filter deleted, because the mock's
    // rows never go through SQL. This asserts the filter itself: both
    // cancellation shapes must be excluded, and `'cancelled'` must be the value
    // compared — an inverted or missing comparison would let a cancelled order
    // be displayed as an issued one.
    supplierItemRows = [supplierItem()];
    priceRows = [priceRow({ rfqItemId: 1 })];
    poLineRows = [poLine()];

    await request(testApp).get("/api/items/analysis/item?key=pn%3ALC1D32M7");

    const comparisons = neComparisons(poWhereArg);
    const compared = comparisons.map((c) => [c.left, c.right]);
    expect(compared).toContainEqual([purchaseOrderItemsTable.lineStatus, "cancelled"]);
    expect(compared).toContainEqual([purchaseOrdersTable.status, "cancelled"]);
    // Both filters must be present, i.e. joined by `and`, not `or`.
    expect(comparisons).toHaveLength(2);
  });

  it("carries the order's ID, so the number can link to its detail page", async () => {
    // The live bug this guards: the API returned only the number, so the portal
    // built `/purchase-orders?q=PO-…` — a search URL that opens the LIST, not
    // the order. The id is what `/purchase-orders/:id` needs.
    supplierItemRows = [supplierItem()];
    priceRows = [
      priceRow({
        offerId: 1,
        rfqItemId: 1,
        supplierId: 1,
        supplierName: "H-EMAS",
        price: "3180",
        offerCreatedAt: new Date("2026-01-15T00:00:00Z"),
      }),
    ];
    poLineRows = [poLine({ poId: 137, poNo: "PO-2026-000041", supplierId: 1 })];

    const res = await request(testApp).get("/api/items/analysis/item?key=pn%3ALC1D32M7");
    expect(res.status).toBe(200);
    expect(res.body.priceHistory[0].poNos).toEqual([{ id: 137, poNo: "PO-2026-000041" }]);
  });

  it("reports the issued-order count per item on the search list", async () => {
    supplierItemRows = [supplierItem()];
    priceRows = [
      priceRow({ offerId: 1, rfqItemId: 1, supplierId: 1, price: "3180" }),
      priceRow({ offerId: 2, rfqItemId: 1, supplierId: 2, price: "3460" }),
    ];
    poLineRows = [poLine({ poNo: "PO-2026-000041", supplierId: 1 })];

    const res = await request(testApp).get("/api/items/analysis/search?q=LC1D32M7");
    expect(res.status).toBe(200);
    expect(res.body.items[0].poIssuedCount).toBe(1);
  });
});
