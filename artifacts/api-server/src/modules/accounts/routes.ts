/**
 * Accounts Module — الحسابات والهامش المحقق
 *
 * Computes the realized margin per customer PO line by joining the selling
 * price (customer_po_items.unitPrice) with the actual cost from the supplier
 * (purchase_order_items.finalActualCost, linked via customerPoItemId). Lines
 * where the actual cost exceeds the selling price are flagged as loss-making
 * (بنود خاسرة). Also aggregates to summary totals.
 *
 * Routes mounted:
 *   GET /accounts/margins           → per-line realized margins (filterable)
 *   GET /accounts/margins/summary   → aggregated totals + loss-making count
 */
import { Router } from "express";
import {
  db,
  customerPosTable,
  customerPoItemsTable,
  purchaseOrderItemsTable,
  customersTable,
} from "@workspace/db";
import { eq, sql, and, desc, gte, lte } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";

const router = Router();

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function formatNum(n: number | null): string | null {
  if (n == null) return null;
  const s = String(Math.round(n * 10000) / 10000);
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

function buildConditions(customerName?: string, from?: string, to?: string) {
  const conditions = [];
  if (customerName) {
    conditions.push(
      sql`coalesce(${customerPosTable.customerName}, ${customersTable.name}) ilike ${
        "%" + customerName + "%"
      }`,
    );
  }
  if (from) conditions.push(gte(customerPosTable.createdAt, new Date(from)));
  if (to) conditions.push(lte(customerPosTable.createdAt, new Date(to + " 23:59:59")));
  return conditions.length ? and(...conditions) : undefined;
}

// GET /accounts/margins — per-line realized margins.
//
// realizedRevenue = customer_po_items.qty × customer_po_items.unitPrice
// realizedCost    = Σ purchase_order_items.acceptedQty × finalActualCost
//                   (qty actually accepted from the supplier, not ordered)
// realizedMargin  = realizedRevenue − realizedCost
router.get("/accounts/margins", requireAuth, async (req, res): Promise<void> => {
  const customerName = (req.query.customerName as string) || undefined;
  const from = (req.query.from as string) || undefined;
  const to = (req.query.to as string) || undefined;
  const onlyLoss = req.query.onlyLoss === "true";

  const rows = await db
    .select({
      customerPoId: customerPosTable.id,
      internalPoNo: customerPosTable.internalPoNo,
      customerPoNo: customerPosTable.customerPoNo,
      customerId: customerPosTable.customerId,
      customerName: customerPosTable.customerName,
      storedCustomerName: customersTable.name,
      poDate: customerPosTable.poDate,
      poStatus: customerPosTable.status,
      customerPoItemId: customerPoItemsTable.id,
      lineItem: customerPoItemsTable.lineItem,
      partNo: customerPoItemsTable.partNo,
      description: customerPoItemsTable.description,
      uom: customerPoItemsTable.uom,
      sellQty: customerPoItemsTable.qty,
      sellUnitPrice: customerPoItemsTable.unitPrice,
      deliveryStatus: customerPoItemsTable.deliveryStatus,
      supplierPoId: purchaseOrderItemsTable.poId,
      supplierPoItemId: purchaseOrderItemsTable.id,
      acceptedQty: purchaseOrderItemsTable.totalAcceptedQty,
      finalActualCost: purchaseOrderItemsTable.finalActualCost,
      supplierLineStatus: purchaseOrderItemsTable.lineStatus,
    })
    .from(customerPoItemsTable)
    .innerJoin(customerPosTable, eq(customerPoItemsTable.customerPoId, customerPosTable.id))
    .leftJoin(customersTable, eq(customerPosTable.customerId, customersTable.id))
    .leftJoin(
      purchaseOrderItemsTable,
      eq(purchaseOrderItemsTable.customerPoItemId, customerPoItemsTable.id),
    )
    .where(buildConditions(customerName, from, to))
    .orderBy(desc(customerPosTable.createdAt));

  const lines = rows.map((r) => {
    const sellQty = toNum(r.sellQty);
    const sellUnit = toNum(r.sellUnitPrice);
    const accepted = toNum(r.acceptedQty);
    const actualCost = toNum(r.finalActualCost);
    const revenue = sellQty != null && sellUnit != null ? sellQty * sellUnit : null;
    // Cost is realized on accepted qty only; null when nothing accepted yet.
    const cost = accepted != null && actualCost != null ? accepted * actualCost : null;
    const margin = revenue != null && cost != null ? revenue - cost : null;
    const marginPct =
      revenue != null && cost != null && revenue !== 0 ? (margin! / revenue) * 100 : null;
    const isLoss = margin != null && margin < 0;
    return {
      customerPoId: r.customerPoId,
      internalPoNo: r.internalPoNo,
      customerPoNo: r.customerPoNo,
      customerName: r.customerName ?? r.storedCustomerName ?? null,
      poDate: r.poDate,
      poStatus: r.poStatus,
      customerPoItemId: r.customerPoItemId,
      lineItem: r.lineItem,
      partNo: r.partNo,
      description: r.description,
      uom: r.uom,
      sellQty: r.sellQty,
      sellUnitPrice: r.sellUnitPrice,
      deliveryStatus: r.deliveryStatus,
      supplierPoId: r.supplierPoId,
      supplierPoItemId: r.supplierPoItemId,
      acceptedQty: r.acceptedQty,
      finalActualCost: r.finalActualCost,
      supplierLineStatus: r.supplierLineStatus,
      revenue: formatNum(revenue),
      cost: formatNum(cost),
      margin: formatNum(margin),
      marginPct: formatNum(marginPct),
      isLoss,
    };
  });

  res.json(onlyLoss ? lines.filter((l) => l.isLoss) : lines);
});

// GET /accounts/margins/summary — aggregated totals across all margin lines.
router.get("/accounts/margins/summary", requireAuth, async (req, res): Promise<void> => {
  const customerName = (req.query.customerName as string) || undefined;
  const from = (req.query.from as string) || undefined;
  const to = (req.query.to as string) || undefined;

  const rows = await db
    .select({
      sellQty: customerPoItemsTable.qty,
      sellUnitPrice: customerPoItemsTable.unitPrice,
      acceptedQty: purchaseOrderItemsTable.totalAcceptedQty,
      finalActualCost: purchaseOrderItemsTable.finalActualCost,
    })
    .from(customerPoItemsTable)
    .innerJoin(customerPosTable, eq(customerPoItemsTable.customerPoId, customerPosTable.id))
    .leftJoin(customersTable, eq(customerPosTable.customerId, customersTable.id))
    .leftJoin(
      purchaseOrderItemsTable,
      eq(purchaseOrderItemsTable.customerPoItemId, customerPoItemsTable.id),
    )
    .where(buildConditions(customerName, from, to));

  let totalRevenue = 0;
  let totalCost = 0;
  let lossLines = 0;
  const lineCount = rows.length;
  let pricedLines = 0;

  for (const r of rows) {
    const sellQty = toNum(r.sellQty);
    const sellUnit = toNum(r.sellUnitPrice);
    const accepted = toNum(r.acceptedQty);
    const actualCost = toNum(r.finalActualCost);
    const revenue = sellQty != null && sellUnit != null ? sellQty * sellUnit : 0;
    const cost = accepted != null && actualCost != null ? accepted * actualCost : 0;
    if (cost > 0) pricedLines++;
    totalRevenue += revenue;
    totalCost += cost;
    if (revenue > 0 && cost > 0 && revenue - cost < 0) lossLines++;
  }

  const totalMargin = totalRevenue - totalCost;
  const marginPct = totalRevenue !== 0 ? (totalMargin / totalRevenue) * 100 : 0;

  res.json({
    lineCount,
    pricedLines,
    lossLines,
    totalRevenue: formatNum(totalRevenue),
    totalCost: formatNum(totalCost),
    totalMargin: formatNum(totalMargin),
    marginPct: formatNum(marginPct),
  });
});

export default router;
