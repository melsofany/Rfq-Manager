/**
 * Integration test for GET /analytics/rfq-kpis against a REAL Postgres.
 *
 * The unit test mocks db.execute, so it can't catch SQL mistakes (wrong column
 * names, type errors, bad joins). This test runs the actual statement.
 *
 * It only runs when TEST_DATABASE_URL points at a DISPOSABLE database — it drops
 * and recreates the tables it uses. Skipped otherwise (e.g. in CI without a DB).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../shared/permissions", () => ({
  guardFor: () => (_req: any, _res: any, next: any) => next(),
}));

const TEST_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("GET /api/analytics/rfq-kpis (real Postgres)", () => {
  let app: express.Express;
  let dbRef: any;
  let sqlRef: any;

  const DDL = `
    DROP TABLE IF EXISTS offer_items, rfq_items, rfq, purchase_orders,
      customer_po_items, customer_pos, customer_rfq_items, customer_rfqs CASCADE;
    CREATE TABLE customer_rfqs (id serial PRIMARY KEY, customer_id int, customer_name text,
      entry_date text, expiry_date text);
    CREATE TABLE customer_rfq_items (id serial PRIMARY KEY, customer_rfq_id int, line_item text,
      unit_price numeric, is_cancelled boolean NOT NULL DEFAULT false);
    CREATE TABLE customer_pos (id serial PRIMARY KEY, status text, po_date text);
    CREATE TABLE customer_po_items (id serial PRIMARY KEY, customer_po_id int,
      customer_rfq_item_id int, delivery_status text NOT NULL DEFAULT 'pending');
    CREATE TABLE rfq (id serial PRIMARY KEY, created_at timestamptz NOT NULL);
    CREATE TABLE rfq_items (id serial PRIMARY KEY, customer_rfq_item_id int);
    CREATE TABLE offer_items (id serial PRIMARY KEY, rfq_item_id int, is_approved boolean NOT NULL);
    CREATE TABLE purchase_orders (id serial PRIMARY KEY, status text, created_at timestamptz NOT NULL);
  `;

  const FIXTURE = `
    INSERT INTO customer_rfqs (id, customer_id, customer_name, entry_date, expiry_date) VALUES
      (1, 1, NULL, '2026-11-02', '2099-01-01'),
      (2, 1, NULL, '2026-10-05', '2099-01-01'),
      (3, NULL, 'Acme', '2026-03-10', '2000-01-01'),
      (4, 1, NULL, 'not-a-date', 'not-a-date');
    INSERT INTO customer_rfq_items (id, customer_rfq_id, line_item, unit_price, is_cancelled) VALUES
      (1, 1, 'A1', 100, false),
      (2, 1, 'A2', NULL, false),
      (3, 2, 'A1', NULL, false),
      (4, 3, 'B1', 50, true),
      (5, 4, 'C1', NULL, false);
    INSERT INTO customer_pos (id, status, po_date) VALUES
      (1, 'sent', '2026-11-10'),
      (2, 'draft', '2026-11-11');
    INSERT INTO customer_po_items (customer_po_id, customer_rfq_item_id, delivery_status) VALUES
      (1, 1, 'pending'),
      (2, 3, 'pending');
    INSERT INTO rfq (created_at) VALUES ('2026-11-05T10:00:00Z'), ('2026-10-20T10:00:00Z');
    INSERT INTO purchase_orders (status, created_at) VALUES
      ('sent', '2026-11-06T10:00:00Z'), ('draft', '2026-11-07T10:00:00Z');
    INSERT INTO rfq_items (id, customer_rfq_item_id) VALUES (1, 1);
    INSERT INTO offer_items (rfq_item_id, is_approved) VALUES (1, true);
  `;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    const dbMod = await import("@workspace/db");
    const drizzle = await import("drizzle-orm");
    dbRef = dbMod.db;
    sqlRef = drizzle.sql;
    await dbRef.execute(sqlRef.raw(DDL));
    await dbRef.execute(sqlRef.raw(FIXTURE));
    const { default: router } = await import("../../modules/reports/rfq-kpis");
    app = express();
    app.use("/api", router);
  });

  afterAll(async () => {
    if (dbRef)
      await dbRef.execute(
        sqlRef.raw(
          "DROP TABLE IF EXISTS offer_items, rfq_items, rfq, purchase_orders, customer_po_items, customer_pos, customer_rfq_items, customer_rfqs CASCADE",
        ),
      );
  });

  it("returns the expected figures for the fixture data", async () => {
    const res = await request(app).get("/api/analytics/rfq-kpis?year=2026&month=11");
    expect(res.status).toBe(200);
    expect(res.body.yearly).toEqual({
      totalItems: 3, // cancelled + undated items excluded
      rfqCount: 3, // undated RFQ excluded
      customerPoCount: 1, // draft PO excluded
      pricedItems: 1,
      pricingRate: 33.33,
      poWinRate: 100,
    });
    expect(res.body.monthly).toEqual({
      rfqCount: 1,
      firstSeenItems: 1, // customer 1 + "a1" was first seen in October
      itemsToPrice: 2,
      supplierRfqCount: 1,
      supplierPoCount: 1,
      supplierPoRate: 100,
      openCustomerRequests: 2, // two distinct RFQs, same expiry date
      openCustomerItems: 2,
      itemsWithSupplierPrice: 1,
      supplierPriceRate: 50,
    });
  });

  it("returns 200 even though one row has a non-ISO date", async () => {
    const res = await request(app).get("/api/analytics/rfq-kpis?year=2026&month=10");
    expect(res.status).toBe(200);
    expect(res.body.monthly.itemsToPrice).toBe(1);
  });
});
