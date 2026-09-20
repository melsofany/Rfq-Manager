/**
 * Accounts Module — سجل الحركات المكتملة (completed orders registry)
 *
 * The accounting view deliberately shows an order only once it has been
 * delivered / settled — never while it is still in progress. Two sides:
 *
 *   • أوامر شراء العملاء (customer orders) — a customer PO appears once a
 *     posted sales invoice exists for it OR at least one of its lines was
 *     delivered/rejected to the customer. Selling figures come from the posted
 *     invoice (net / output VAT 14% / gross); the realized cost is the accepted
 *     supplier quantity × actual cost, so the margin is the accounting figure —
 *     not a sales-only snapshot.
 *
 *   • أوامر شراء الموردين (supplier orders) — a purchase order appears once at
 *     least one line was received (accepted / partial / rejected) or a posted
 *     supplier invoice exists. Cost + input VAT (14%, or 0 for a non-VAT
 *     supplier) come from the receipts / supplier invoice.
 *
 * Routes (behind requireAuth):
 *   GET /accounts/collected-orders → { customerOrders, supplierOrders, totals }
 */
import { Router } from "express";
import {
  db,
  customerPosTable,
  customerPoItemsTable,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
  suppliersTable,
  salesInvoicesTable,
  supplierInvoicesTable,
  poItemChargesTable,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { round2 } from "./tax";
import { numOr as toNum, trimNum as fmt, loadTaxSettings } from "./helpers";

const router = Router();

const DELIVERED_STATES = new Set(["delivered", "rejected", "cancelled"]);
const RECEIVED_STATES = new Set(["fulfilled", "partial", "rejected"]);

router.get("/accounts/collected-orders", requireAuth, async (_req, res): Promise<void> => {
  const settings = await loadTaxSettings();
  const vatRate = settings.vatRate;

  // ── Customer orders ───────────────────────────────────────────────────────
  const customerPos = await db
    .select()
    .from(customerPosTable)
    .orderBy(desc(customerPosTable.createdAt));
  const customerItems = await db.select().from(customerPoItemsTable);
  const postedSales = await db
    .select({
      id: salesInvoicesTable.id,
      invoiceNo: salesInvoicesTable.invoiceNo,
      customerPoId: salesInvoicesTable.customerPoId,
      netAmount: salesInvoicesTable.netAmount,
      vatAmount: salesInvoicesTable.vatAmount,
      grossAmount: salesInvoicesTable.grossAmount,
      status: salesInvoicesTable.status,
    })
    .from(salesInvoicesTable)
    .where(eq(salesInvoicesTable.status, "posted"));
  const supplierLines = await db.select().from(purchaseOrderItemsTable);

  const itemsByCustomerPo = new Map<number, (typeof customerItems)[number][]>();
  for (const it of customerItems) {
    if (it.customerPoId == null) continue;
    const list = itemsByCustomerPo.get(it.customerPoId) ?? [];
    list.push(it);
    itemsByCustomerPo.set(it.customerPoId, list);
  }
  const invoiceByCustomerPo = new Map<number, (typeof postedSales)[number]>();
  for (const inv of postedSales) {
    if (inv.customerPoId == null) continue;
    // newest posted invoice wins (sales invoice are list-ordered by id asc here,
    // so keep the last we see)
    invoiceByCustomerPo.set(inv.customerPoId, inv);
  }
  const costByCustomerItem = new Map<number, number>();
  for (const line of supplierLines) {
    if (line.customerPoItemId == null) continue;
    const cost = toNum(line.totalAcceptedQty) * toNum(line.finalActualCost);
    costByCustomerItem.set(
      line.customerPoItemId,
      (costByCustomerItem.get(line.customerPoItemId) ?? 0) + cost,
    );
  }

  const customerOrders = [];
  for (const po of customerPos) {
    const items = itemsByCustomerPo.get(po.id) ?? [];
    const deliveredItems = items.filter((i) => DELIVERED_STATES.has(i.deliveryStatus)).length;
    const invoice = invoiceByCustomerPo.get(po.id);
    const settled = !!invoice || deliveredItems > 0;
    if (!settled) continue; // only completed / delivered orders appear here

    const net = invoice
      ? toNum(invoice.netAmount)
      : round2(items.reduce((s, i) => s + toNum(i.qty) * toNum(i.unitPrice), 0));
    const vat = invoice ? toNum(invoice.vatAmount) : round2((net * vatRate) / 100);
    const gross = invoice ? toNum(invoice.grossAmount) : round2(net + vat);
    const cost = round2(items.reduce((s, i) => s + (costByCustomerItem.get(i.id) ?? 0), 0));
    const margin = round2(net - cost);
    customerOrders.push({
      id: po.id,
      internalPoNo: po.internalPoNo,
      customerPoNo: po.customerPoNo,
      customerName: po.customerName,
      poDate: po.poDate,
      status: po.status,
      totalItems: items.length,
      deliveredItems,
      invoiceNo: invoice?.invoiceNo ?? null,
      invoiceId: invoice?.id ?? null,
      net: fmt(net),
      vat: fmt(vat),
      gross: fmt(gross),
      cost: fmt(cost),
      margin: fmt(margin),
      marginPct: net > 0 ? fmt(round2((margin / net) * 100)) : null,
      isLoss: margin < 0,
    });
  }

  // ── Supplier orders ───────────────────────────────────────────────────────
  const supplierPos = await db
    .select()
    .from(purchaseOrdersTable)
    .orderBy(desc(purchaseOrdersTable.createdAt));
  const supplierSuppliers = await db
    .select({ id: suppliersTable.id, name: suppliersTable.name })
    .from(suppliersTable);
  const postedSupplierInvoices = await db
    .select({
      id: supplierInvoicesTable.id,
      invoiceNo: supplierInvoicesTable.invoiceNo,
      poId: supplierInvoicesTable.poId,
      netAmount: supplierInvoicesTable.netAmount,
      vatAmount: supplierInvoicesTable.vatAmount,
      hasVat: supplierInvoicesTable.hasVat,
      status: supplierInvoicesTable.status,
    })
    .from(supplierInvoicesTable)
    .where(eq(supplierInvoicesTable.status, "posted"));

  const supplierNameById = new Map(supplierSuppliers.map((s) => [s.id, s.name]));
  const supplierLinesByPo = new Map<number, (typeof supplierLines)[number][]>();
  for (const line of supplierLines) {
    const list = supplierLinesByPo.get(line.poId) ?? [];
    list.push(line);
    supplierLinesByPo.set(line.poId, list);
  }
  const supplierInvoiceByPo = new Map<number, (typeof postedSupplierInvoices)[number]>();
  for (const inv of postedSupplierInvoices) {
    if (inv.poId == null) continue;
    supplierInvoiceByPo.set(inv.poId, inv);
  }

  const supplierOrders = [];
  for (const po of supplierPos) {
    const lines = supplierLinesByPo.get(po.id) ?? [];
    const receivedItems = lines.filter((l) => RECEIVED_STATES.has(l.lineStatus)).length;
    const anyReceived = lines.some((l) => toNum(l.totalAcceptedQty) > 0);
    const invoice = supplierInvoiceByPo.get(po.id);
    if (!anyReceived && receivedItems === 0 && !invoice) continue; // not yet received

    const cost = round2(
      lines.reduce((s, l) => s + toNum(l.totalAcceptedQty) * toNum(l.finalActualCost), 0),
    );
    const invoiceNet = invoice ? toNum(invoice.netAmount) : 0;
    const invoiceVat = invoice ? toNum(invoice.vatAmount) : 0;
    const supplierNames = Array.from(
      new Set(
        lines
          .map((l) => (l.supplierId != null ? supplierNameById.get(l.supplierId) : null))
          .filter((n): n is string => !!n),
      ),
    );
    supplierOrders.push({
      id: po.id,
      internalPoNo: po.internalPoNo,
      sheetPoNo: po.sheetPoNo,
      supplierNames,
      status: po.status,
      totalItems: lines.length,
      receivedItems,
      cost: fmt(cost),
      invoiceNo: invoice?.invoiceNo ?? null,
      invoiceNet: fmt(invoiceNet),
      invoiceVat: fmt(invoiceVat),
      hasVat: invoice?.hasVat !== false,
      createdAt: po.createdAt.toISOString(),
    });
  }

  const customerTotals = customerOrders.reduce(
    (acc, o) => {
      acc.net += toNum(o.net);
      acc.vat += toNum(o.vat);
      acc.cost += toNum(o.cost);
      acc.margin += toNum(o.margin);
      return acc;
    },
    { net: 0, vat: 0, cost: 0, margin: 0 },
  );

  res.json({
    vatRate,
    customerOrders,
    supplierOrders,
    totals: {
      customerOrders: customerOrders.length,
      supplierOrders: supplierOrders.length,
      net: fmt(round2(customerTotals.net)),
      vat: fmt(round2(customerTotals.vat)),
      cost: fmt(round2(customerTotals.cost)),
      margin: fmt(round2(customerTotals.margin)),
      marginPct:
        customerTotals.net > 0
          ? fmt(round2((customerTotals.margin / customerTotals.net) * 100))
          : null,
    },
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PO line charges — تكاليف مرتبطة بأوامر الشراء (نقل/شحن/جمارك/…)
//
// Charges recorded per supplier PO line so the true landed cost of each line
// is known. Surfaced here so the accountant can see all PO-linked costs in one
// place alongside the operating expenses. Each row carries its PO + supplier
// so the accountant can trace the charge back to the order.
// ───────────────────────────────────────────────────────────────────────────
router.get("/accounts/po-charges", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: poItemChargesTable.id,
      poId: poItemChargesTable.poId,
      poItemId: poItemChargesTable.poItemId,
      chargeType: poItemChargesTable.chargeType,
      description: poItemChargesTable.description,
      amount: poItemChargesTable.amount,
      createdAt: poItemChargesTable.createdAt,
      internalPoNo: purchaseOrdersTable.internalPoNo,
      sheetPoNo: purchaseOrdersTable.sheetPoNo,
      supplierId: purchaseOrderItemsTable.supplierId,
      supplierName: suppliersTable.name,
      lineItem: purchaseOrderItemsTable.lineItem,
      partNo: purchaseOrderItemsTable.partNo,
    })
    .from(poItemChargesTable)
    .leftJoin(purchaseOrdersTable, eq(poItemChargesTable.poId, purchaseOrdersTable.id))
    .leftJoin(purchaseOrderItemsTable, eq(poItemChargesTable.poItemId, purchaseOrderItemsTable.id))
    .leftJoin(suppliersTable, eq(purchaseOrderItemsTable.supplierId, suppliersTable.id))
    .orderBy(desc(poItemChargesTable.createdAt));

  const byType = new Map<string, number>();
  let total = 0;
  const charges = rows.map((r) => {
    const amount = toNum(r.amount);
    total += amount;
    byType.set(r.chargeType, round2((byType.get(r.chargeType) ?? 0) + amount));
    return {
      id: r.id,
      poId: r.poId,
      poItemId: r.poItemId,
      internalPoNo: r.internalPoNo,
      sheetPoNo: r.sheetPoNo,
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      lineItem: r.lineItem,
      partNo: r.partNo,
      chargeType: r.chargeType,
      description: r.description,
      amount: fmt(amount),
      createdAt: r.createdAt.toISOString(),
    };
  });

  res.json({
    total: fmt(round2(total)),
    count: charges.length,
    byType: Array.from(byType.entries())
      .map(([type, amount]) => ({ type, amount: fmt(round2(amount)) }))
      .sort((a, b) => toNum(b.amount) - toNum(a.amount)),
    charges,
  });
});

export default router;
