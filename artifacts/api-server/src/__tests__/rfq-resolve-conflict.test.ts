import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  category: { id: 7, kind: "functional", isActive: true } as
    { id: number; kind: string; isActive: boolean } | undefined,
  updatedRows: [] as Array<{ id: number; customerRfqId: number | null }>,
  setArgs: [] as unknown[],
  whereCalls: 0,
}));

vi.mock("@workspace/db", () => {
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: async () => (state.category ? [state.category] : []),
      }),
    }),
  });
  const update = () => ({
    set: (vals: unknown) => {
      state.setArgs.push(vals);
      return {
        where: () => ({
          returning: async () => state.updatedRows,
        }),
      };
    },
  });
  return {
    db: { select, update },
    customerRfqItemsTable: {
      id: "id",
      customerRfqId: "customerRfqId",
      isCancelled: "isCancelled",
    },
    itemCategoriesTable: { id: "id", kind: "kind", isActive: "isActive" },
  };
});
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (a: unknown, b: unknown) => [a, b],
  inArray: (a: unknown, b: unknown) => [a, b],
  isNull: (a: unknown) => a,
}));
vi.mock("../modules/rfq/classification-memory", () => ({
  rememberClassification: vi.fn(async () => null),
}));
vi.mock("../modules/rfq/customer-assignment", () => ({
  ensureCustomerAssignmentsSafe: vi.fn(async () => null),
}));

import { resolveConflictItems } from "../modules/rfq/review-groups";

describe("resolveConflictItems", () => {
  beforeEach(() => {
    state.category = { id: 7, kind: "functional", isActive: true };
    state.updatedRows = [];
    state.setArgs = [];
  });

  it("rejects a category that is not an active functional one", async () => {
    state.category = { id: 7, kind: "brand", isActive: true };
    const r = await resolveConflictItems({ itemIds: [1], categoryId: 7, decidedBy: 1 });
    expect(r).toEqual({ error: "اختر تصنيفًا وظيفيًا نشطًا", status: 400 });
  });

  it("assigns the category to every item of the group and counts the RFQs touched", async () => {
    state.updatedRows = [
      { id: 1, customerRfqId: 10 },
      { id: 2, customerRfqId: 10 },
      { id: 3, customerRfqId: 11 },
    ];
    const r = await resolveConflictItems({ itemIds: [1, 2, 3, 3], categoryId: 7, decidedBy: 1 });
    expect(r).toEqual({ assigned: 3, affectedRfqs: 2 });
    expect(state.setArgs[0]).toMatchObject({ categoryId: 7, suggestedCategoryId: null });
  });

  it("does nothing for an empty selection", async () => {
    const r = await resolveConflictItems({ itemIds: [], categoryId: 7, decidedBy: 1 });
    expect(r).toEqual({ assigned: 0, affectedRfqs: 0 });
    expect(state.setArgs).toHaveLength(0);
  });
});
