import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../shared/permissions", () => ({
  guardFor: () => (_req: any, _res: any, next: any) => next(),
}));

const executeMock = vi.fn();
vi.mock("@workspace/db", () => ({
  db: { execute: (...args: any[]) => executeMock(...args) },
}));

import rfqKpisRouter from "../../modules/reports/rfq-kpis";

function buildApp() {
  const app = express();
  app.use("/api", rfqKpisRouter);
  return app;
}

const fixtureRow = {
  items_year: "200",
  rfq_year: "40",
  customer_po_year: "12",
  priced_year: "50",
  won_year: "10",
  rfq_month: "5",
  first_seen_month: "30",
  items_month: "60",
  open_items_now: "7",
  open_requests_now: "3",
  supplier_rfq_month: "8",
  supplier_po_month: "4",
  supplier_priced_month: "15",
  customer_po_month: "3",
  priced_month: "20",
  won_month: "5",
};

describe("GET /api/analytics/rfq-kpis", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue({ rows: [fixtureRow] });
  });

  it("computes yearly rates from the aggregate row", async () => {
    const res = await request(buildApp()).get("/api/analytics/rfq-kpis?year=2026&month=11");
    expect(res.status).toBe(200);
    expect(res.body.yearly).toEqual({
      totalItems: 200,
      rfqCount: 40,
      customerPoCount: 12,
      pricedItems: 50,
      pricingRate: 25, // 50 / 200
      poWinRate: 20, // 10 / 50
    });
  });

  it("computes monthly figures and supplier rates", async () => {
    const res = await request(buildApp()).get("/api/analytics/rfq-kpis?year=2026&month=11");
    expect(res.body.monthly).toEqual({
      totalItems: 60,
      rfqCount: 5,
      customerPoCount: 3,
      pricedItems: 20,
      pricingRate: 33.33, // 20 / 60
      poWinRate: 25, // 5 / 20
      firstSeenItems: 30,
      itemsToPrice: 60,
      supplierRfqCount: 8,
      supplierPoCount: 4,
      supplierPoRate: 50, // 4 / 8
      openCustomerRequests: 3,
      openCustomerItems: 7,
      itemsWithSupplierPrice: 15,
      supplierPriceRate: 25, // 15 / 60
    });
  });

  it("returns definitions for every card", async () => {
    const res = await request(buildApp()).get("/api/analytics/rfq-kpis?year=2026&month=11");
    expect(res.body.definitions.pricingRate).toContain("البنود المسعّرة");
    expect(res.body.definitions.poWinRate).toContain("أمر شراء");
  });

  it("returns zero rates when the denominators are zero (no division by zero)", async () => {
    executeMock.mockResolvedValue({
      rows: [
        {
          ...fixtureRow,
          items_year: "0",
          priced_year: "0",
          items_month: "0",
          supplier_rfq_month: "0",
        },
      ],
    });
    const res = await request(buildApp()).get("/api/analytics/rfq-kpis?year=2026&month=11");
    expect(res.body.yearly.pricingRate).toBe(0);
    expect(res.body.yearly.poWinRate).toBe(0);
    expect(res.body.monthly.supplierPoRate).toBe(0);
    expect(res.body.monthly.supplierPriceRate).toBe(0);
  });

  it("rejects an invalid month", async () => {
    const res = await request(buildApp()).get("/api/analytics/rfq-kpis?year=2026&month=13");
    expect(res.status).toBe(400);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid year", async () => {
    const res = await request(buildApp()).get("/api/analytics/rfq-kpis?year=abc&month=11");
    expect(res.status).toBe(400);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
