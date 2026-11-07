import { describe, it, expect, vi } from "vitest";

const H = vi.hoisted(() => ({ rows: [] as any[] }));

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => H.rows),
      })),
    })),
  },
  financePaymentRequestsTable: {
    poId: "poId",
    supplierId: "supplierId",
    status: "status",
  },
}));

import { paymentStatusByPair } from "../../modules/field-ops/payment-status";

describe("paymentStatusByPair", () => {
  it("defaults every pair to unpaid before any rows are read", async () => {
    H.rows = [];
    const m = await paymentStatusByPair([
      { poId: 1, supplierId: 10 },
      { poId: 1, supplierId: 20 },
    ]);
    expect(m.get("1:10")).toBe("unpaid");
    expect(m.get("1:20")).toBe("unpaid");
  });

  it("maps the finance row status onto its exact (po, supplier) pair", async () => {
    H.rows = [
      { poId: 1, supplierId: 10, status: "paid" },
      { poId: 1, supplierId: 20, status: "partial" },
    ];
    const m = await paymentStatusByPair([
      { poId: 1, supplierId: 10 },
      { poId: 1, supplierId: 20 },
    ]);
    expect(m.get("1:10")).toBe("paid");
    expect(m.get("1:20")).toBe("partial");
  });

  it("keeps a pair unpaid when no finance row exists for it", async () => {
    H.rows = [{ poId: 1, supplierId: 10, status: "paid" }];
    const m = await paymentStatusByPair([
      { poId: 1, supplierId: 10 },
      { poId: 1, supplierId: 20 },
    ]);
    expect(m.get("1:10")).toBe("paid");
    expect(m.get("1:20")).toBe("unpaid");
  });

  it("ignores rows for POs that were never requested", async () => {
    H.rows = [{ poId: 999, supplierId: 10, status: "paid" }];
    const m = await paymentStatusByPair([{ poId: 1, supplierId: 10 }]);
    expect(m.get("1:10")).toBe("unpaid");
  });

  it("returns an empty map for an empty request", async () => {
    H.rows = [{ poId: 1, supplierId: 10, status: "paid" }];
    const m = await paymentStatusByPair([]);
    expect(m.size).toBe(0);
  });
});
