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
 *   GET /accounts/vat               → VAT statement (output/input/net)  Egyptian 14%
 *   GET /accounts/withholding       → خصم تحت حساب المورد per supplier PO (3%)
 *   GET /accounts/tax-settings      → Egyptian tax identity + rates
 *   PUT /accounts/tax-settings      → update the tax identity + rates (admin/manager)
 */
import { Router } from "express";
import {
  db,
  customerPosTable,
  customerPoItemsTable,
  purchaseOrderItemsTable,
  purchaseOrdersTable,
  suppliersTable,
  customersTable,
  taxSettingsTable,
  poItemChargesTable,
  auditLogTable,
  supplierInvoicesTable,
  salesInvoicesTable,
} from "@workspace/db";
import { eq, sql, and, desc, gte, lte } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { rateOf, round2 } from "./tax";

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

/** Load the single tax_settings row (creates a sane default if absent). */
async function loadTaxSettings() {
  const rows = await db.select().from(taxSettingsTable).limit(1);
  const row = rows[0];
  return {
    id: row?.id ?? null,
    companyName: row?.companyName ?? null,
    companyTaxId: row?.companyTaxId ?? null,
    companyAddress: row?.companyAddress ?? null,
    companyPhone: row?.companyPhone ?? null,
    vatRate: rateOf(row?.vatRate, 14),
    withholdingRate: rateOf(row?.withholdingRate, 3),
    withholdingRateServices: rateOf(row?.withholdingRateServices, 5),
    withholdingRatePurchases: rateOf(row?.withholdingRatePurchases, 1),
  };
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

/**
 * Sum of charges for each supplier PO line item, keyed by poItemId. Used to
 * fold per-line charges (نقل/شحن/جمارك/…) into the realized cost so the true
 * cost of each line is known precisely.
 */
async function loadChargesByPoItem(poItemIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (!poItemIds.length) return map;
  const rows = await db
    .select({
      poItemId: poItemChargesTable.poItemId,
      amount: poItemChargesTable.amount,
    })
    .from(poItemChargesTable);
  for (const r of rows) {
    if (!poItemIds.includes(r.poItemId)) continue;
    map.set(r.poItemId, (map.get(r.poItemId) ?? 0) + (toNum(r.amount) ?? 0));
  }
  return map;
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

  const chargesMap = await loadChargesByPoItem(
    rows.map((r) => r.supplierPoItemId).filter((x): x is number => x != null),
  );

  const lines = rows.map((r) => {
    const sellQty = toNum(r.sellQty);
    const sellUnit = toNum(r.sellUnitPrice);
    const accepted = toNum(r.acceptedQty);
    const actualCost = toNum(r.finalActualCost);
    const revenue = sellQty != null && sellUnit != null ? sellQty * sellUnit : null;
    // Cost is realized on accepted qty only; null when nothing accepted yet.
    // Fold per-line PO charges (نقل/شحن/جمارك/…) into the cost.
    const lineCharges = r.supplierPoItemId != null ? (chargesMap.get(r.supplierPoItemId) ?? 0) : 0;
    const cost =
      accepted != null && actualCost != null ? accepted * actualCost + lineCharges : null;
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
      sellQty: formatNum(sellQty),
      sellUnitPrice: formatNum(sellUnit),
      deliveryStatus: r.deliveryStatus,
      supplierPoId: r.supplierPoId,
      supplierPoItemId: r.supplierPoItemId,
      acceptedQty: formatNum(accepted),
      finalActualCost: formatNum(actualCost),
      lineCharges: formatNum(lineCharges),
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
      supplierPoItemId: purchaseOrderItemsTable.id,
    })
    .from(customerPoItemsTable)
    .innerJoin(customerPosTable, eq(customerPoItemsTable.customerPoId, customerPosTable.id))
    .leftJoin(customersTable, eq(customerPosTable.customerId, customersTable.id))
    .leftJoin(
      purchaseOrderItemsTable,
      eq(purchaseOrderItemsTable.customerPoItemId, customerPoItemsTable.id),
    )
    .where(buildConditions(customerName, from, to));

  const chargesMap = await loadChargesByPoItem(
    rows.map((r) => r.supplierPoItemId).filter((x): x is number => x != null),
  );

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
    const lineCharges =
      r.supplierPoItemId != null ? (chargesMap.get(r.supplierPoItemId) ?? 0) : 0;
    const cost =
      accepted != null && actualCost != null ? accepted * actualCost + lineCharges : 0;
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

// ───────────────────────────────────────────────────────────────────────────
// VAT — ضريبة القيمة المضافة (Egyptian VAT Law No. 67 of 2016)
// ───────────────────────────────────────────────────────────────────────────
//
// Output VAT (ضريبة المبيعات) — charged to customers on customer PO lines.
// Input VAT (ضريبة المشتريات) — paid to suppliers on purchase-order items.
// A line is taxable when it carries a unit price (sales) or actual cost /
// reference price (purchases). VAT-inclusive lines are split into net + VAT
// using the configured 14% rate; VAT-exclusive lines add VAT on the net base.
// Net VAT payable = Output VAT − Input VAT (credit carried forward if < 0).

interface VatLine {
  date: string | null;
  party: string | null;
  document: string | null;
  net: number;
  vat: number;
  gross: number;
}

function dateOf(d: unknown): string | null {
  if (d == null) return null;
  const s = String(d);
  return s.slice(0, 10);
}

router.get("/accounts/vat", requireAuth, async (req, res): Promise<void> => {
  const from = (req.query.from as string) || undefined;
  const to = (req.query.to as string) || undefined;
  const settings = await loadTaxSettings();
  const vatRate = settings.vatRate;

  // ── Output VAT: posted sales invoices. ───────────────────────────────────
  // Sales invoices are VAT-exclusive by construction (net + vat computed at
  // 14% on top); this is the same figure posted to the OUTPUT_VAT ledger.
  const sellInvoices = await db
    .select({
      id: salesInvoicesTable.id,
      invoiceNo: salesInvoicesTable.invoiceNo,
      customerName: salesInvoicesTable.customerName,
      customerPoNo: salesInvoicesTable.customerPoNo,
      invoiceDate: salesInvoicesTable.invoiceDate,
      netAmount: salesInvoicesTable.netAmount,
      vatAmount: salesInvoicesTable.vatAmount,
      grossAmount: salesInvoicesTable.grossAmount,
      status: salesInvoicesTable.status,
    })
    .from(salesInvoicesTable)
    .where(eq(salesInvoicesTable.status, "posted"));

  const output: VatLine[] = [];
  let outputNet = 0;
  let outputVat = 0;
  for (const r of sellInvoices) {
    if (from && r.invoiceDate < from) continue;
    if (to && r.invoiceDate > to + " 23:59:59") continue;
    const net = toNum(r.netAmount) ?? 0;
    const vat = toNum(r.vatAmount) ?? 0;
    if (net === 0 && vat === 0) continue;
    outputNet += net;
    outputVat += vat;
    output.push({
      date: dateOf(r.invoiceDate),
      party: r.customerName ?? null,
      document: r.invoiceNo ?? r.customerPoNo,
      net,
      vat,
      gross: net + vat,
    });
  }

  // ── Input VAT: posted supplier invoices. ────────────────────────────────
  const buyInvoices = await db
    .select({
      id: supplierInvoicesTable.id,
      invoiceNo: supplierInvoicesTable.invoiceNo,
      supplierInvoiceNo: supplierInvoicesTable.supplierInvoiceNo,
      supplierName: supplierInvoicesTable.supplierName,
      poNo: supplierInvoicesTable.poNo,
      invoiceDate: supplierInvoicesTable.invoiceDate,
      netAmount: supplierInvoicesTable.netAmount,
      vatAmount: supplierInvoicesTable.vatAmount,
      grossAmount: supplierInvoicesTable.grossAmount,
      status: supplierInvoicesTable.status,
    })
    .from(supplierInvoicesTable)
    .where(eq(supplierInvoicesTable.status, "posted"));

  const input: VatLine[] = [];
  let inputNet = 0;
  let inputVat = 0;
  for (const r of buyInvoices) {
    if (from && r.invoiceDate < from) continue;
    if (to && r.invoiceDate > to + " 23:59:59") continue;
    const net = toNum(r.netAmount) ?? 0;
    const vat = toNum(r.vatAmount) ?? 0;
    if (net === 0 && vat === 0) continue;
    inputNet += net;
    inputVat += vat;
    input.push({
      date: dateOf(r.invoiceDate),
      party: r.supplierName ?? null,
      document: r.supplierInvoiceNo ?? r.invoiceNo ?? r.poNo,
      net,
      vat,
      gross: net + vat,
    });
  }

  const netVat = round2(outputVat - inputVat);

  res.json({
    vatRate,
    from: from ?? null,
    to: to ?? null,
    output: { net: round2(outputNet), vat: round2(outputVat) },
    input: { net: round2(inputNet), vat: round2(inputVat) },
    netVat,
    payable: netVat > 0 ? netVat : 0,
    credit: netVat < 0 ? Math.abs(netVat) : 0,
    outputLines: output.map((l) => ({
      ...l,
      net: round2(l.net),
      vat: round2(l.vat),
      gross: round2(l.gross),
    })),
    inputLines: input.map((l) => ({
      ...l,
      net: round2(l.net),
      vat: round2(l.vat),
      gross: round2(l.gross),
    })),
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Withholding tax — خصم تحت حساب المورد
// ───────────────────────────────────────────────────────────────────────────
//
// Applied per supplier purchase order: the company withholds a percentage of
// each PO's net value and remits it to the Egyptian Tax Authority on behalf of
// the supplier. Defaults: 3% general (services), 1% purchases, 5% professional
// fees. The general `withholdingRate` (3%) is applied unless a PO is flagged
// otherwise. The supplier receives (net − withholding).

interface WithholdingLine {
  poId: number;
  internalPoNo: string;
  sheetPoNo: string;
  supplierName: string | null;
  poDate: string | null;
  status: string;
  netValue: number;
  rate: number;
  withholding: number;
  payableToSupplier: number;
}

router.get("/accounts/withholding", requireAuth, async (req, res): Promise<void> => {
  const from = (req.query.from as string) || undefined;
  const to = (req.query.to as string) || undefined;
  const settings = await loadTaxSettings();

  // Withholding is sourced from posted supplier invoices — each carries the
  // netValue, withholdingRate and withholdingAmount computed at create/post
  // time (the same amounts posted to the WITHHOLDING_PAYABLE ledger account).
  const buyInvoices = await db
    .select({
      id: supplierInvoicesTable.id,
      invoiceNo: supplierInvoicesTable.invoiceNo,
      supplierInvoiceNo: supplierInvoicesTable.supplierInvoiceNo,
      supplierName: supplierInvoicesTable.supplierName,
      poNo: supplierInvoicesTable.poNo,
      invoiceDate: supplierInvoicesTable.invoiceDate,
      netAmount: supplierInvoicesTable.netAmount,
      withholdingRate: supplierInvoicesTable.withholdingRate,
      withholdingAmount: supplierInvoicesTable.withholdingAmount,
      grossAmount: supplierInvoicesTable.grossAmount,
      status: supplierInvoicesTable.status,
    })
    .from(supplierInvoicesTable)
    .where(eq(supplierInvoicesTable.status, "posted"));

  const lines: WithholdingLine[] = [];
  let totalNet = 0;
  let totalWithholding = 0;
  let totalPayable = 0;
  for (const r of buyInvoices) {
    if (from && r.invoiceDate < from) continue;
    if (to && r.invoiceDate > to + " 23:59:59") continue;
    const netValue = toNum(r.netAmount) ?? 0;
    const rate = toNum(r.withholdingRate) ?? settings.withholdingRate;
    const withholding = toNum(r.withholdingAmount) ?? round2((netValue * rate) / 100);
    const payableToSupplier = round2(netValue - withholding);
    if (netValue === 0 && withholding === 0) continue;
    totalNet = round2(totalNet + netValue);
    totalWithholding = round2(totalWithholding + withholding);
    totalPayable = round2(totalPayable + payableToSupplier);
    lines.push({
      poId: r.id,
      internalPoNo: r.invoiceNo,
      sheetPoNo: r.supplierInvoiceNo ?? r.poNo ?? "",
      supplierName: r.supplierName ?? null,
      poDate: dateOf(r.invoiceDate),
      status: r.status,
      netValue,
      rate,
      withholding,
      payableToSupplier,
    });
  }

  // newest first (mirrors the old PO-based order)
  lines.sort((a, b) => (b.poDate ?? "").localeCompare(a.poDate ?? ""));

  res.json({
    withholdingRate: settings.withholdingRate,
    withholdingRateServices: settings.withholdingRateServices,
    withholdingRatePurchases: settings.withholdingRatePurchases,
    from: from ?? null,
    to: to ?? null,
    totalNet,
    totalWithholding,
    totalPayable,
    lines,
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Tax settings — إعدادات الضرائب المصرية
// ───────────────────────────────────────────────────────────────────────────

router.get("/accounts/tax-settings", requireAuth, async (_req, res): Promise<void> => {
  res.json(await loadTaxSettings());
});

router.put("/accounts/tax-settings", requireRole("admin", "manager"), async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as {
    companyName?: string | null;
    companyTaxId?: string | null;
    companyAddress?: string | null;
    companyPhone?: string | null;
    vatRate?: string | number | null;
    withholdingRate?: string | number | null;
    withholdingRateServices?: string | number | null;
    withholdingRatePurchases?: string | number | null;
  };
  const session = req.session as { employeeId?: number; role?: string };
  const settings = await loadTaxSettings();

  const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

  const next = {
    companyName: body.companyName ?? settings.companyName,
    companyTaxId: body.companyTaxId ?? settings.companyTaxId,
    companyAddress: body.companyAddress ?? settings.companyAddress,
    companyPhone: body.companyPhone ?? settings.companyPhone,
    vatRate: rateOf(body.vatRate != null ? String(body.vatRate) : null, settings.vatRate),
    withholdingRate: rateOf(
      body.withholdingRate != null ? String(body.withholdingRate) : null,
      settings.withholdingRate,
    ),
    withholdingRateServices: rateOf(
      body.withholdingRateServices != null ? String(body.withholdingRateServices) : null,
      settings.withholdingRateServices,
    ),
    withholdingRatePurchases: rateOf(
      body.withholdingRatePurchases != null ? String(body.withholdingRatePurchases) : null,
      settings.withholdingRatePurchases,
    ),
  };

  if (settings.id == null) {
    const [inserted] = await db
      .insert(taxSettingsTable)
      .values({
        companyName: next.companyName,
        companyTaxId: next.companyTaxId,
        companyAddress: next.companyAddress,
        companyPhone: next.companyPhone,
        vatRate: String(next.vatRate),
        withholdingRate: String(next.withholdingRate),
        withholdingRateServices: String(next.withholdingRateServices),
        withholdingRatePurchases: String(next.withholdingRatePurchases),
      })
      .returning();
    await db
      .insert(auditLogTable)
      .values({
        action: "tax_settings.update",
        entityType: "tax_settings",
        entityId: inserted.id,
        employeeId: session.employeeId,
        description: "تحديث إعدادات الضرائب المصرية",
      });
    res.json({ ...next, id: inserted.id });
  } else {
    await db
      .update(taxSettingsTable)
      .set({
        companyName: strOrNull(next.companyName),
        companyTaxId: strOrNull(next.companyTaxId),
        companyAddress: strOrNull(next.companyAddress),
        companyPhone: strOrNull(next.companyPhone),
        vatRate: String(next.vatRate),
        withholdingRate: String(next.withholdingRate),
        withholdingRateServices: String(next.withholdingRateServices),
        withholdingRatePurchases: String(next.withholdingRatePurchases),
      })
      .where(eq(taxSettingsTable.id, settings.id));
    await db
      .insert(auditLogTable)
      .values({
        action: "tax_settings.update",
        entityType: "tax_settings",
        entityId: settings.id,
        employeeId: session.employeeId,
        description: "تحديث إعدادات الضرائب المصرية",
      });
    res.json({ ...next, id: settings.id });
  }
});
