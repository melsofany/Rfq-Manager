/**
 * DB-computed item aggregates.
 *
 * The incident these guard: the operator asked for every item supplied to
 * customers in 2025–2026 and received a PDF with **15 items** while the table
 * held 1,971 rows and 570 distinct descriptions. The assistant had no tool that
 * grouped the table, so the model read a page of rows and summarised them in
 * prose. These tests pin the two properties that make that impossible:
 *
 *  1. The aggregate reads EVERY contributing row and returns EVERY product.
 *  2. Products are folded by identity (description variants merge; different
 *     articles never merge), which is what «بدون تكرار» actually asks for.
 *
 * The canonicalisation assertions fail against a naive
 * `group by lower(description)` implementation, verified by reverting it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
vi.mock("@workspace/db", () => ({
  getPool: () => ({ query: queryMock }),
}));

// The module logs its computed counts; keep the output clean.
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  canonicalDescription,
  clusterLabel,
  isProductLevelTotal,
  aggregateCustomerPoItems,
} from "../../modules/ai-assistant/sql-registry";

beforeEach(() => {
  queryMock.mockReset();
});

/** A grouped row as the driver returns it (NUMERIC comes back as a string). */
function row(description: string, partNo: string, uom: string, qty: number, occurrences = 1) {
  return { description, part_no: partNo, uom, total_qty: qty, occurrences };
}

describe("canonicalDescription — product identity", () => {
  it("folds case, punctuation and spacing so one product is one key", () => {
    const a = canonicalDescription("CABLE 2X2.5 MM");
    const b = canonicalDescription("cable  2x2.5, mm");
    expect(a).toBe(b);
  });

  it("ignores a leading ERP line-item code so coded and uncoded rows merge", () => {
    // Live shape: the same article is printed with the ERP code on one order and
    // by description alone on the next. Grouping on the raw text splits it.
    const coded = canonicalDescription("1531.032.GENRAL.7538 CIRCUIT BREAKER 30A");
    const plain = canonicalDescription("CIRCUIT BREAKER 30A");
    expect(coded).toBe(plain);
  });

  it("ignores a stray leading number on an otherwise textual description", () => {
    expect(canonicalDescription("41 10HP SIEMENS MOTOR")).toBe(
      canonicalDescription("10HP SIEMENS MOTOR"),
    );
  });

  it("keeps a size that is part of the product name", () => {
    // `50 MM` and `70 MM` are different articles — folding them would invent a
    // product the operator never ordered.
    expect(canonicalDescription("CABLE 50 MM")).not.toBe(canonicalDescription("CABLE 70 MM"));
  });

  it("fold together Arabic spelling variants", () => {
    expect(canonicalDescription("شركة الأمل للتوريدات")).toBe(
      canonicalDescription("شركه الامل للتوريدات"),
    );
  });
});

describe("clusterLabel — what the operator reads", () => {
  it("reduces a long specification to its identifying token", () => {
    expect(clusterLabel("FAN COIL UNIT TMAX 30MM 220V 50HZ")).toBe("fan");
  });

  it("falls back to the raw description when nothing usable remains", () => {
    expect(clusterLabel("1234")).toBe("1234");
  });
});

describe("isProductLevelTotal — flag, never drop", () => {
  it("flags a total far above the median as a category-like line", () => {
    expect(isProductLevelTotal(5000, [5, 6, 7, 8, 9])).toBe(true);
  });

  it("does not flag a total in line with its peers", () => {
    expect(isProductLevelTotal(12, [5, 6, 7, 8, 9])).toBe(false);
  });
});

/**
 * The central guarantee: everything that went in comes out.
 */
describe("aggregateCustomerPoItems — completeness", () => {
  it("returns every product in the result, not a sample", async () => {
    // 400 distinct products, as the real table has ~570 in this window.
    const rows = Array.from({ length: 400 }, (_, i) =>
      row(`ITEM ${String(i).padStart(4, "0")} PUMP`, `P${i}`, "PC", 1 + i),
    );
    queryMock.mockResolvedValue({ rows });

    const result = await aggregateCustomerPoItems({ fromDate: "2025-01-01" });

    // A capped tool returns ~20 here; the whole point is that it does not.
    expect(result.rows).toHaveLength(400);
    expect(result.truncated).toBe(false);
    expect(result.sourceRows).toBe(400);
  });

  it("counts the rows that went into the grouping so a sample cannot read as a total", async () => {
    queryMock.mockResolvedValue({
      rows: [row("A", "1", "PC", 5, 10), row("B", "2", "PC", 3, 4)],
    });
    const result = await aggregateCustomerPoItems({});
    // 14 lines produced 2 products — both numbers travel, so the answer can say
    // "2 products from 14 order lines" instead of guessing.
    expect(result.sourceRows).toBe(14);
    expect(result.rows).toHaveLength(2);
  });

  it("merges the same product written differently and sums its quantity", async () => {
    queryMock.mockResolvedValue({
      rows: [
        row("WATER FILTER 10 INCH", "F1", "PC", 100),
        row("water filter 10 inch", "", "PC", 50),
      ],
    });
    const result = await aggregateCustomerPoItems({});
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].totalQty).toBe(150);
    expect(result.rows[0].occurrences).toBe(2);
    // Two distinct written forms, folded into one product.
    expect(result.rows[0].variants).toBe(2);
  });

  it("merges the same product written with an ERP code and without one", async () => {
    // The live shape that splits a product in two: one order prints the ERP
    // line-item code ahead of the description, the next prints prose alone.
    // Folding punctuation alone does NOT merge these — only the code-stripping
    // rule does, which is why this goes through the real aggregation path rather
    // than asserting on canonicalDescription in isolation.
    queryMock.mockResolvedValue({
      rows: [
        row("1531.032.GENRAL.7538 CIRCUIT BREAKER 30A", "1531.032.GENRAL.7538", "PC", 40),
        row("CIRCUIT BREAKER 30A", "", "PC", 60),
      ],
    });
    const result = await aggregateCustomerPoItems({});
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].totalQty).toBe(100);
    expect(result.rows[0].occurrences).toBe(2);
  });

  it("never merges two different articles that share a family word", async () => {
    queryMock.mockResolvedValue({
      rows: [row("CABLE 50 MM", "A", "M", 10), row("CABLE 70 MM", "B", "M", 20)],
    });
    const result = await aggregateCustomerPoItems({});
    expect(result.rows).toHaveLength(2);
  });

  it("excludes accounting lines (VAT) that are not stock", async () => {
    queryMock.mockResolvedValue({
      rows: [
        row("VALUE ADDED TAX LOCAL", "0600.000.GENRAL.0005", "", 9999),
        row("REAL PUMP", "P1", "PC", 3),
      ],
    });
    const result = await aggregateCustomerPoItems({});
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].description).toBe("REAL PUMP");
    expect(result.droppedNonProduct).toBe(1);
  });

  it("reports the quantity filter it applied instead of silently trimming", async () => {
    queryMock.mockResolvedValue({
      rows: [row("BIG", "1", "PC", 500), row("TINY", "2", "PC", 1)],
    });
    const result = await aggregateCustomerPoItems({ minQty: 10 });
    expect(result.rows).toHaveLength(1);
    expect(result.droppedByMinQty).toBe(1);
    // The filter is echoed so the answer must disclose it.
    expect(result.appliedFilters.minQty).toBe(10);
  });

  it("sorts by total quantity so the report leads with the biggest items", async () => {
    queryMock.mockResolvedValue({
      rows: [row("SMALL", "1", "PC", 5), row("BIG", "2", "PC", 500)],
    });
    const result = await aggregateCustomerPoItems({});
    expect(result.rows.map((r) => r.description)).toEqual(["BIG", "SMALL"]);
  });

  it("marks a product identified only by prose as uncertain", async () => {
    queryMock.mockResolvedValue({
      rows: [row("PUMP WITHOUT CODE", "", "PC", 5), row("PUMP WITH CODE", "P9", "PC", 4)],
    });
    const result = await aggregateCustomerPoItems({});
    const byDesc = Object.fromEntries(result.rows.map((r) => [r.description, r.identityUncertain]));
    expect(byDesc["PUMP WITHOUT CODE"]).toBe(true);
    expect(byDesc["PUMP WITH CODE"]).toBe(false);
  });

  it("excludes detached (removed-from-PO) rows by default", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await aggregateCustomerPoItems({ fromDate: "2025-01-01" });
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain("i.customer_po_id is not null");
  });

  it("passes the date window as bound parameters, never interpolated", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await aggregateCustomerPoItems({ fromDate: "2025-01-01", toDate: "2027-01-01" });
    const [sql, params] = queryMock.mock.calls[0];
    expect(params).toEqual(["2025-01-01", "2027-01-01"]);
    // The dates must NOT be spliced into the statement text.
    expect(sql).not.toContain("2025-01-01");
    expect(sql).toContain("$1");
    expect(sql).toContain("$2");
  });

  it("collapses what looks like a category total into a flagged line, not a deletion", async () => {
    // Many ordinary small items plus one huge line — the real shape of the data
    // (a handful of category-like rows over hundreds of single articles).
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row(`ITEM ${i} PUMP`, `P${i}`, "PC", 10 + i)),
      row("WATER FILTERS", "4", "PC", 4000),
    ];
    queryMock.mockResolvedValue({ rows });
    const result = await aggregateCustomerPoItems({});
    const big = result.rows.find((r) => r.description === "WATER FILTERS");
    // Kept, and flagged — dropping it would hide a real total from the operator.
    expect(big).toBeDefined();
    expect(big?.productLevel).toBe(true);
    // The ordinary items are not flagged.
    expect(result.rows.filter((r) => r.productLevel)).toHaveLength(1);
  });
});
