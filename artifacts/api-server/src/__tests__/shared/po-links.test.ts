/**
 * The PO-line link ladder is the single rule several modules share to decide
 * which customer-PO line a supplier line fulfils. These tests pin the rungs so
 * a change cannot silently start mis-attributing cost, receipts or delivery.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { customerPosTbl, customerPoItemsTbl, purchaseOrdersTbl, state } = vi.hoisted(() => ({
  customerPosTbl: "customerPos",
  customerPoItemsTbl: "customerPoItems",
  purchaseOrdersTbl: "purchaseOrders",
  state: {
    customerPoRows: [] as any[],
    customerPoItemRows: [] as any[],
    purchaseOrderRows: [] as any[],
  },
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((t: any) => {
        let rows: any[] = [];
        if (t === customerPosTbl) rows = state.customerPoRows;
        else if (t === customerPoItemsTbl) rows = state.customerPoItemRows;
        else if (t === purchaseOrdersTbl) rows = state.purchaseOrderRows;
        return { then: (r: any) => Promise.resolve(rows).then(r) };
      }),
    })),
  },
  customerPosTable: customerPosTbl,
  customerPoItemsTable: customerPoItemsTbl,
  purchaseOrdersTable: purchaseOrdersTbl,
}));

import { matchCustomerPoItem, resolveCustomerPoLinks } from "../../shared/po-links";

beforeEach(() => {
  state.customerPoRows = [];
  state.customerPoItemRows = [];
  state.purchaseOrderRows = [];
});

describe("matchCustomerPoItem", () => {
  const lines = [
    { id: 11, lineItem: "1", partNo: "ABC-1", description: "مسمار" },
    { id: 12, lineItem: "2", partNo: "ABC-2", description: "صامولة" },
  ];

  it("prefers lineItem over partNo and description", () => {
    const r = matchCustomerPoItem({ lineItem: "2", partNo: "ABC-1", description: "مسمار" }, lines);
    expect(r.customerPoItemId).toBe(12);
    expect(r.basis).toBe("number_lineItem");
    expect(r.unambiguous).toBe(true);
  });

  it("falls back to partNo when no lineItem matches", () => {
    const r = matchCustomerPoItem({ lineItem: "9", partNo: "ABC-1", description: null }, lines);
    expect(r.customerPoItemId).toBe(11);
    expect(r.basis).toBe("number_partNo");
  });

  it("falls back to description as the last resort", () => {
    const r = matchCustomerPoItem({ lineItem: null, partNo: null, description: "صامولة" }, lines);
    expect(r.customerPoItemId).toBe(12);
    expect(r.basis).toBe("number_description");
  });

  it("flags an ambiguous match so a caller will not persist it", () => {
    const dupes = [
      { id: 11, lineItem: "1", partNo: "ABC-1", description: null },
      { id: 12, lineItem: "1", partNo: "ABC-1", description: null },
    ];
    const r = matchCustomerPoItem({ lineItem: "1", partNo: null, description: null }, dupes);
    expect(r.customerPoItemId).not.toBeNull();
    expect(r.unambiguous).toBe(false);
  });

  it("returns no match when nothing identifies the line", () => {
    const r = matchCustomerPoItem({ lineItem: "", partNo: null, description: "" }, lines);
    expect(r.customerPoItemId).toBeNull();
    expect(r.basis).toBeNull();
  });
});

describe("resolveCustomerPoLinks", () => {
  beforeEach(() => {
    state.customerPoRows = [{ id: 1, customerPoNo: "C-100" }];
    state.customerPoItemRows = [
      { id: 11, customerPoId: 1, lineItem: "1", partNo: "ABC-1", description: null },
      { id: 12, customerPoId: 1, lineItem: "2", partNo: "ABC-2", description: null },
    ];
    state.purchaseOrderRows = [{ id: 5, sheetPoNo: "C-100" }];
  });

  it("keeps an existing FK and does not re-derive it", () => {
    const lines = [
      {
        id: 101,
        poId: 5,
        customerPoItemId: 12,
        lineItem: "1",
        partNo: null,
        description: null,
      },
    ];
    return resolveCustomerPoLinks(lines).then(({ linkByLineId }) => {
      expect(linkByLineId.get(101)).toEqual({
        customerPoItemId: 12,
        basis: "fk",
        unambiguous: true,
      });
    });
  });

  it("resolves an unlinked line through the PO numbers", async () => {
    const lines = [
      {
        id: 101,
        poId: 5,
        customerPoItemId: null,
        lineItem: "2",
        partNo: "ABC-2",
        description: null,
      },
    ];
    const { linkByLineId, resolvedByLineId } = await resolveCustomerPoLinks(lines);
    expect(linkByLineId.get(101)?.customerPoItemId).toBe(12);
    expect(resolvedByLineId.get(101)).toBe(12);
  });

  it("leaves a line unresolved when its PO number matches no customer PO", async () => {
    state.purchaseOrderRows = [{ id: 5, sheetPoNo: "OTHER" }];
    const lines = [
      { id: 101, poId: 5, customerPoItemId: null, lineItem: "1", partNo: null, description: null },
    ];
    const { linkByLineId, resolvedByLineId } = await resolveCustomerPoLinks(lines);
    expect(linkByLineId.get(101)?.customerPoItemId).toBeNull();
    expect(resolvedByLineId.size).toBe(0);
  });
});
