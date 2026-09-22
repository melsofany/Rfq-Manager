/**
 * Regression tests for the assistant's *grounding*.
 *
 * Live failure (22/9): asked "how many offers does High Volt have", the agent
 * answered «عروض 237، 232، 231، 230» and then, when challenged, invented
 * «شركة النور» / «الشركة المصرية» as the supplier on PO 37. Nothing threw: the
 * DB search silently returned UNRELATED rows, so the model read real rows as if
 * they were its matches and filled the gaps with invented names.
 *
 * Root cause: `queryRecords` built its filter as
 *   spec.search.map(c => columns[c]).filter(Boolean)
 * and for `offers` the declared columns (`supplierName`, `status`) DO NOT EXIST
 * — the supplier is a foreign key. The filtered array was empty, so no WHERE
 * clause was applied at all and the table's newest rows came back as "results".
 *
 * These tests pin the invariant: a search term that cannot be matched must
 * return NOTHING and must say so, never a full-table scan.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// `@workspace/db` builds its pg Pool at import time, so the URL must exist
// before anything imports it (the real test suite runs without a database).
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/test";

// ── Real table handles + a recording db mock ─────────────────────────────────
type Row = Record<string, unknown>;

/** Every table's rows, keyed by the drizzle table name. */
const store: Record<string, Row[]> = {};
let appliedFilters = 0;

/**
 * Map a drizzle column object back to its JS key. `col.name` is the snake_case
 * DB name, but the mock store is keyed by the camelCase property, so resolve
 * through each table's `drizzle:Columns` map (built from the real tables).
 */
const COL_KEY = new WeakMap<object, string>();

const colName = (c: any): string => {
  const hit = COL_KEY.get(c);
  if (hit) return hit;
  const raw = String(c?.name ?? c ?? "");
  return raw.replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase());
};

function indexColumns(): void {
  for (const table of Object.values(TABLES)) {
    const colsMap = (table as any)?.[Symbol.for("drizzle:Columns")] ?? {};
    for (const [key, col] of Object.entries(colsMap)) {
      if (col && typeof col === "object") COL_KEY.set(col as object, key);
    }
  }
}

function rowsFor(table: any): Row[] {
  const name = String(table?.[Symbol.for("drizzle:Name")] ?? "");
  return store[name] ?? [];
}

/** Evaluate the filter objects our mocked drizzle helpers produce. */
function testRow(row: Row, filter: any): boolean {
  if (!filter) return true;
  if (filter.__and) return filter.__and.every((f: any) => testRow(row, f));
  if (filter.__or) return filter.__or.some((f: any) => testRow(row, f));
  if (filter.__empty) return false; // the `1 = 0` no-match sentinel
  if (filter.__eq) {
    const [col, val] = filter.__eq;
    return row[colName(col)] === val;
  }
  if (filter.__ilike) {
    const [col, pat] = filter.__ilike;
    const needle = String(pat).replace(/%/g, "").toLowerCase();
    return String(row[colName(col)] ?? "")
      .toLowerCase()
      .includes(needle);
  }
  if (filter.__in) {
    const [col, vals] = filter.__in;
    return (vals as unknown[]).includes(row[colName(col)]);
  }
  if (filter.__gte) return true;
  return true;
}

/** Chainable + awaitable query builder that honours the recorded filters. */
function selectBuilder(colsArg?: unknown) {
  const state = { table: null as any, filters: [] as any[] };
  const builder: any = {
    from(table: any) {
      state.table = table;
      return builder;
    },
    where(f: any) {
      state.filters.push(f);
      return builder;
    },
    orderBy() {
      return builder;
    },
    limit() {
      return builder;
    },
    then(resolve: any, reject: any) {
      try {
        const all = rowsFor(state.table).filter((r) => state.filters.every((f) => testRow(r, f)));
        // A search term that produced NO filter is the bug this suite guards.
        if (state.filters.length) appliedFilters++;
        let rows = all.map((r) => ({ ...r }));
        if (colsArg && typeof colsArg === "object" && !Array.isArray(colsArg)) {
          // Projection (e.g. {cnt: count()}): return a single aggregate row.
          rows = [{ cnt: all.length }];
        }
        resolve(rows);
      } catch (e) {
        reject(e);
      }
    },
  };
  return builder;
}

const dbMock: any = {
  select: (cols?: unknown) => selectBuilder(cols),
};

let TABLES: Record<string, any> = {};

vi.mock("@workspace/db", async () => {
  const actual: any = await vi.importActual("@workspace/db");
  TABLES = actual;
  return { ...actual, db: dbMock };
});

vi.mock("drizzle-orm", () => {
  // The production code writes `sql\`1 = 0\`` for the no-match sentinel and
  // `sql\`${col}::text\`` for casts, so `sql` must be callable both as a tagged
  // template and as a plain object property holder.
  const sql: any = (strings: TemplateStringsArray, ..._vals: any[]) => {
    const text = strings.join("?");
    if (text.includes("1 = 0")) return { __empty: true };
    return { __raw: true, toString: () => text };
  };
  return {
    and: (...args: any[]) => ({ __and: args.filter(Boolean) }),
    or: (...args: any[]) => ({ __or: args.filter(Boolean) }),
    eq: (col: any, val: any) => ({ __eq: [col, val] }),
    ilike: (col: any, pat: any) => ({ __ilike: [col, pat] }),
    inArray: (col: any, vals: any) => ({ __in: [col, vals] }),
    desc: (c: any) => c,
    asc: (c: any) => c,
    gte: () => ({ __gte: true }),
    count: () => ({ __count: true }),
    sql,
  };
});

const { queryRecords } = await import("../../modules/ai-assistant/db-tools");
const { tableListForPrompt } = await import("../../modules/ai-assistant/db-tools");

const SUPPLIER_TABLE = "suppliers";
const OFFERS_TABLE = "offers";
const OFFER_ITEMS_TABLE = "offer_items";
const PO_TABLE = "purchase_orders";
const PO_ITEMS_TABLE = "purchase_order_items";

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  appliedFilters = 0;
  indexColumns();
});

describe("queryRecords grounding", () => {
  it("never returns rows for a nonsense term on ANY table (no bare-scan fallback)", async () => {
    // The live bug: `offers` declared a non-existent `supplierName` column, so
    // the filter was empty and the query returned the table's newest rows —
    // which the model then reported as «عروض 237، 232، 231، 230». A term that
    // matches nothing must yield nothing, on every table, always.
    const { getTables } = await import("../../modules/ai-assistant/db-tools");
    store[SUPPLIER_TABLE] = [{ id: 1, name: "شركة النور" }];
    store[OFFERS_TABLE] = [
      { id: 237, supplierId: 1, generalNotes: null },
      { id: 232, supplierId: 1, generalNotes: null },
    ];

    for (const tableName of Object.keys(getTables())) {
      const res = await queryRecords({ table: tableName, search: "ززززز-غير-موجود-قققق" });
      expect(res.rows, `table ${tableName} leaked rows for an unmatchable term`).toHaveLength(0);
    }
  });

  it("explains an unmatched term instead of presenting unfiltered rows", async () => {
    store[SUPPLIER_TABLE] = [];
    store[OFFERS_TABLE] = [{ id: 237, supplierId: 11, generalNotes: null }];

    const res = await queryRecords({ table: "offers", search: "هاي فولت" });

    expect(res.rows).toHaveLength(0);
    // `applied` is true (the search WAS run against real columns) — the point is
    // that it found nothing rather than falling back to a full scan.
    expect(res.filter.searched).toBe("هاي فولت");
  });

  it("reports applied=false when the table exposes no column for the term", async () => {
    // Simulate the original defect: a registry entry whose declared search
    // columns do not exist on the table at all.
    const { getTables } = await import("../../modules/ai-assistant/db-tools");
    const spec = getTables()["offers"];
    const original = spec.search;
    const originalExtra = spec.extraSearch;
    try {
      spec.search = ["supplierName", "status"]; // neither column exists
      delete spec.extraSearch;
      store[OFFERS_TABLE] = [
        { id: 237, supplierId: 11, generalNotes: null },
        { id: 232, supplierId: 12, generalNotes: null },
      ];

      const res = await queryRecords({ table: "offers", search: "هاي فولت" });

      expect(res.rows).toHaveLength(0);
      expect(res.filter.applied).toBe(false);
      expect(res.filter.note).toContain("غير مفلترة");
    } finally {
      spec.search = original;
      spec.extraSearch = originalExtra;
    }
  });

  it("finds offers by a real supplier name through the FK", async () => {
    store[SUPPLIER_TABLE] = [{ id: 167, name: "هاي فولت" }];
    store[OFFERS_TABLE] = [
      { id: 237, supplierId: 167, generalNotes: null },
      { id: 232, supplierId: 99, generalNotes: null },
    ];

    const res = await queryRecords({ table: "offers", search: "هاي فولت" });

    expect(res.rows.map((r) => r.id)).toEqual([237]);
    expect(res.filter.applied).toBe(true);
  });

  it("attaches the supplier NAME to offer rows so the model need not guess", async () => {
    store[SUPPLIER_TABLE] = [{ id: 167, name: "هاي فولت" }];
    store[OFFERS_TABLE] = [{ id: 237, supplierId: 167, generalNotes: null }];
    // rfqId ref resolution must not break when the row is absent.
    store["rfqs"] = [];

    const res = await queryRecords({ table: "offers", search: "هاي فولت" });

    expect(res.rows[0].supplierName).toBe("هاي فولت");
  });

  it("resolves the supplier on a PO through its line items and labels them", async () => {
    store[SUPPLIER_TABLE] = [{ id: 146, name: "هاي فولت" }];
    store[PO_ITEMS_TABLE] = [
      { id: 1, poId: 47, supplierId: 146, description: "COFRIMELL JUICE DISPENSER", lineItem: "1" },
    ];
    store[PO_TABLE] = [
      { id: 47, internalPoNo: "PO-2026-000033", sheetPoNo: "P26E13477" },
      { id: 48, internalPoNo: "PO-2026-000034", sheetPoNo: "P26E13478" },
    ];

    const res = await queryRecords({ table: "purchase_orders", search: "هاي فولت" });

    expect(res.rows.map((r) => r.id)).toEqual([47]);
    expect(res.filter.applied).toBe(true);
  });

  it("labels PO line items with their supplier and PO number", async () => {
    store[SUPPLIER_TABLE] = [{ id: 146, name: "هاي فولت" }];
    store[PO_TABLE] = [{ id: 47, internalPoNo: "PO-2026-000033" }];
    store[PO_ITEMS_TABLE] = [{ id: 1, poId: 47, supplierId: 146, description: "كوس كابلات" }];

    const res = await queryRecords({ table: "purchase_order_items", search: "كوس" });

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].supplierName).toBe("هاي فولت");
    expect(res.rows[0].poNo).toBe("PO-2026-000033");
  });

  it("finds a supplier by its internal numeric id (users say «مورد 95»)", async () => {
    store[SUPPLIER_TABLE] = [
      { id: 95, name: "مورد الكابلات" },
      { id: 96, name: "مورد آخر" },
    ];

    const res = await queryRecords({ table: "suppliers", search: "95" });

    expect(res.rows.map((r) => r.id)).toEqual([95]);
    expect(res.filter.applied).toBe(true);
  });

  it("reports the matched columns in the note", async () => {
    store[SUPPLIER_TABLE] = [{ id: 1, name: "شركة النور" }];
    const res = await queryRecords({ table: "suppliers", search: "النور" });
    expect(res.filter.note).toContain("suppliers.name");
    expect(res.filter.applied).toBe(true);
  });

  it("says so when no search term was given at all", async () => {
    store[SUPPLIER_TABLE] = [{ id: 1, name: "أ" }];
    const res = await queryRecords({ table: "suppliers" });
    expect(res.rows).toHaveLength(1);
    expect(res.filter.searched).toBeNull();
    expect(res.filter.note).toContain("لا يوجد بحث");
  });

  it("searches offer_items by the RFQ item description (columns live elsewhere)", async () => {
    store["rfq_items"] = [
      { id: 5, description: "COFRIMELL JUICE DISPENSER", partNo: "CF-1" },
      { id: 6, description: "CABLE LUGS", partNo: "CL-2" },
    ];
    store[OFFER_ITEMS_TABLE] = [
      { id: 1, offerId: 10, rfqItemId: 5, price: 100 },
      { id: 2, offerId: 10, rfqItemId: 6, price: 200 },
    ];
    store[OFFERS_TABLE] = [{ id: 10, supplierId: 1 }];

    const res = await queryRecords({ table: "offer_items", search: "CABLE LUGS" });

    expect(res.rows.map((r) => r.id)).toEqual([2]);
    expect(res.rows[0].rfqItemDescription).toBe("CABLE LUGS");
  });

  it("every registry table's declared search columns actually exist", async () => {
    // The original bug was a registry naming columns that do not exist. Guard
    // the whole registry so a future table cannot reintroduce it silently.
    const { getTables } = await import("../../modules/ai-assistant/db-tools");
    const problems: string[] = [];
    for (const [name, spec] of Object.entries(getTables())) {
      const cols = (spec.table as any)[Symbol.for("drizzle:Columns")] ?? {};
      const phantom = spec.search.filter((c) => !cols[c]);
      if (phantom.length) problems.push(`${name}: ${phantom.join(", ")}`);
    }
    expect(problems).toEqual([]);
  });

  it("lists every searchable table for the prompt", () => {
    const list = tableListForPrompt();
    expect(list).toContain("offers");
    expect(list).toContain("purchase_orders");
  });
});
