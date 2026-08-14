/**
 * Accounts Module — فواتير البيع (AR)
 *
 * A sales invoice bills the customer for a customer PO/RFQ. It carries the net
 * sales value + output VAT 14%. Posting auto-generates the balanced journal:
 *   Dr  AR (customer)    net + vat
 *   Cr  Sales            net
 *   Cr  Output VAT       vat
 * and (perpetual) recognizes COGS for the accepted supplier cost:
 *   Dr  COGS              realizedCost
 *   Cr  Inventory         realizedCost
 * A branded Arabic-RTL PDF (فاتورة ضريبية) can be generated + downloaded.
 *
 * Routes:
 *   GET    /accounts/sales-invoices
 *   POST   /accounts/sales-invoices
 *   GET    /accounts/sales-invoices/:id
 *   PATCH  /accounts/sales-invoices/:id
 *   POST   /accounts/sales-invoices/:id/post
 *   POST   /accounts/sales-invoices/:id/void
 *   GET    /accounts/sales-invoices/:id/pdf     → branded PDF
 */
import { Router } from "express";
import {
  db,
  salesInvoicesTable,
  salesInvoiceItemsTable,
  customerPosTable,
  customerPoItemsTable,
  purchaseOrderItemsTable,
  poItemChargesTable,
  taxSettingsTable,
  customersTable,
  auditLogTable,
  ACCOUNT_CODES,
} from "@workspace/db";
import { eq, desc, and, lte, gte } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { rateOf, vatOnNet, round2 } from "./tax";
import { postJournalEntry, nextEntryNo } from "./posting";
import { generateSalesInvoicePdf } from "./sales-invoice-pdf";

const router = Router();

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function formatNum(n: number | null): string | null {
  if (n == null) return null;
  const s = String(Math.round(n * 10000) / 10000);
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

async function loadTaxSettings() {
  const rows = await db.select().from(taxSettingsTable).limit(1);
  const row = rows[0];
  return {
    vatRate: rateOf(row?.vatRate, 14),
    companyName: row?.companyName ?? null,
    companyTaxId: row?.companyTaxId ?? null,
    companyAddress: row?.companyAddress ?? null,
    companyPhone: row?.companyPhone ?? null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// List
// ───────────────────────────────────────────────────────────────────────────
router.get("/accounts/sales-invoices", requireAuth, async (req, res): Promise<void> => {
  const from = (req.query.from as string) || undefined;
  const to = (req.query.to as string) || undefined;
  const status = (req.query.status as string) || undefined;
  const conds = [];
  if (from) conds.push(gte(salesInvoicesTable.invoiceDate, from));
  if (to) conds.push(lte(salesInvoicesTable.invoiceDate, to));
  if (status) conds.push(eq(salesInvoicesTable.status, status));
  const rows = await db
    .select()
    .from(salesInvoicesTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(salesInvoicesTable.invoiceDate), desc(salesInvoicesTable.id));
  res.json(
    rows.map((r) => ({
      id: r.id,
      invoiceNo: r.invoiceNo,
      customerPoId: r.customerPoId,
      customerPoNo: r.customerPoNo,
      customerId: r.customerId,
      customerName: r.customerName,
      invoiceDate: r.invoiceDate,
      dueDate: r.dueDate,
      netAmount: formatNum(toNum(r.netAmount)),
      vatAmount: formatNum(toNum(r.vatAmount)),
      grossAmount: formatNum(toNum(r.grossAmount)),
      cogsAmount: formatNum(toNum(r.cogsAmount)),
      collectedAmount: formatNum(toNum(r.collectedAmount)),
      balance: formatNum(toNum(r.balance)),
      status: r.status,
      postedAt: r.postedAt,
      createdAt: r.createdAt,
    })),
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Detail (with line items + linked PO)
// ───────────────────────────────────────────────────────────────────────────
router.get("/accounts/sales-invoices/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [row] = await db
    .select()
    .from(salesInvoicesTable)
    .where(eq(salesInvoicesTable.id, id));
  if (!row) {
    res.status(404).json({ error: "الفاتورة غير موجودة" });
    return;
  }
  const items = await db
    .select()
    .from(salesInvoiceItemsTable)
    .where(eq(salesInvoiceItemsTable.invoiceId, id))
    .orderBy(salesInvoiceItemsTable.id);
  res.json({
    id: row.id,
    invoiceNo: row.invoiceNo,
    customerPoId: row.customerPoId,
    customerPoNo: row.customerPoNo,
    customerRfqId: row.customerRfqId,
    customerId: row.customerId,
    customerName: row.customerName,
    invoiceDate: row.invoiceDate,
    dueDate: row.dueDate,
    netAmount: formatNum(toNum(row.netAmount)),
    vatAmount: formatNum(toNum(row.vatAmount)),
    grossAmount: formatNum(toNum(row.grossAmount)),
    cogsAmount: formatNum(toNum(row.cogsAmount)),
    collectedAmount: formatNum(toNum(row.collectedAmount)),
    balance: formatNum(toNum(row.balance)),
    status: row.status,
    journalEntryId: row.journalEntryId,
    notes: row.notes,
    employeeName: row.employeeName,
    reviewedByName: row.reviewedByName,
    postedAt: row.postedAt,
    createdAt: row.createdAt,
    items: items.map((it) => ({
      id: it.id,
      customerPoItemId: it.customerPoItemId,
      lineItem: it.lineItem,
      partNo: it.partNo,
      description: it.description,
      uom: it.uom,
      qty: formatNum(toNum(it.qty)),
      unitPrice: formatNum(toNum(it.unitPrice)),
      total: formatNum(toNum(it.total)),
    })),
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Create (optionally auto-filled from a customer PO)
// ───────────────────────────────────────────────────────────────────────────
// When customerPoId is provided and items omitted, the invoice auto-fills
// from the customer PO's priced items (qty × unitPrice).
router.post("/accounts/sales-invoices", requireRole("accountant", "manager", "admin"), async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as {
    customerPoId?: number | null;
    customerRfqId?: number | null;
    customerId?: number | null;
    customerName?: string;
    invoiceDate: string;
    dueDate?: string | null;
    notes?: string | null;
    items?: Array<{
      customerPoItemId?: number | null;
      lineItem?: string | null;
      partNo?: string | null;
      description: string;
      uom?: string | null;
      qty?: number | string;
      unitPrice?: number | string;
    }>;
  };
  if (!body.invoiceDate) {
    res.status(400).json({ error: "تاريخ الفاتورة مطلوب" });
    return;
  }
  const session = req.session as { employeeId?: number; role?: string; employeeName?: string };
  const settings = await loadTaxSettings();

  let customerName = body.customerName ?? null;
  let customerPoNo: string | null = null;
  let customerId = body.customerId ?? null;

  let items = body.items ?? [];
  if (body.customerPoId) {
    const [po] = await db
      .select({ no: customerPosTable.customerPoNo, customerId: customerPosTable.customerId, name: customerPosTable.customerName })
      .from(customerPosTable)
      .where(eq(customerPosTable.id, body.customerPoId));
    customerPoNo = po?.no ?? null;
    if (po) {
      customerId = po.customerId ?? customerId;
      customerName = po.name ?? customerName;
    }
    if (items.length === 0) {
      const poItems = await db
        .select()
        .from(customerPoItemsTable)
        .where(eq(customerPoItemsTable.customerPoId, body.customerPoId));
      items = poItems
        .filter((it) => toNum(it.unitPrice) != null && toNum(it.qty) != null)
        .map((it) => ({
          customerPoItemId: it.id,
          lineItem: it.lineItem,
          partNo: it.partNo,
          description: it.description ?? "(بند أمر شراء)",
          uom: it.uom,
          qty: toNum(it.qty) ?? 0,
          unitPrice: toNum(it.unitPrice) ?? 0,
        }));
    }
  }
  if (!customerName) {
    res.status(400).json({ error: "اسم العميل مطلوب" });
    return;
  }

  const lineItems = items.map((it) => {
    const qty = toNum(it.qty) ?? 0;
    const price = toNum(it.unitPrice) ?? 0;
    return { ...it, qty, price, total: round2(qty * price) };
  });
  const net = round2(lineItems.reduce((s, it) => s + it.total, 0));
  const vat = vatOnNet(net, settings.vatRate);
  const gross = round2(net + vat);

  const year = parseInt(body.invoiceDate.slice(0, 4), 10) || new Date().getFullYear();
  const invoiceNo = await nextEntryNo("INV", year);

  const [row] = await db
    .insert(salesInvoicesTable)
    .values({
      invoiceNo,
      customerPoId: body.customerPoId ?? null,
      customerPoNo,
      customerRfqId: body.customerRfqId ?? null,
      customerId: customerId,
      customerName,
      invoiceDate: body.invoiceDate,
      dueDate: body.dueDate ?? null,
      netAmount: String(net),
      vatAmount: String(vat),
      grossAmount: String(gross),
      cogsAmount: "0",
      balance: String(gross),
      status: "draft",
      notes: body.notes ?? null,
      employeeId: session.employeeId,
      employeeName: session.employeeName ?? null,
    })
    .returning();

  if (lineItems.length) {
    await db.insert(salesInvoiceItemsTable).values(
      lineItems.map((it) => ({
        invoiceId: row!.id,
        customerPoItemId: it.customerPoItemId ?? null,
        lineItem: it.lineItem ?? null,
        partNo: it.partNo ?? null,
        description: it.description,
        uom: it.uom ?? null,
        qty: String(it.qty),
        unitPrice: String(it.price),
        total: String(it.total),
      })),
    );
  }
  await db.insert(auditLogTable).values({
    action: "sales_invoice.create",
    entityType: "sales_invoices",
    entityId: row!.id,
    employeeId: session.employeeId,
    description: `إنشاء فاتورة بيع ${invoiceNo} — ${customerName}`,
  });
  res.json({ id: row!.id, invoiceNo });
});

// ───────────────────────────────────────────────────────────────────────────
// Edit (draft only)
// ───────────────────────────────────────────────────────────────────────────
router.patch("/accounts/sales-invoices/:id", requireRole("accountant", "manager", "admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [existing] = await db
    .select()
    .from(salesInvoicesTable)
    .where(eq(salesInvoicesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "الفاتورة غير موجودة" });
    return;
  }
  if (existing.status !== "draft") {
    res.status(400).json({ error: "لا يمكن تعديل فاتورة مُرحَّلة — استخدم الإلغاء" });
    return;
  }
  const body = (req.body ?? {}) as {
    customerName?: string;
    customerId?: number | null;
    invoiceDate?: string;
    dueDate?: string | null;
    notes?: string | null;
    items?: Array<{
      customerPoItemId?: number | null;
      lineItem?: string | null;
      partNo?: string | null;
      description: string;
      uom?: string | null;
      qty?: number | string;
      unitPrice?: number | string;
    }>;
  };
  const settings = await loadTaxSettings();

  if (Array.isArray(body.items)) {
    await db.delete(salesInvoiceItemsTable).where(eq(salesInvoiceItemsTable.invoiceId, id));
    const lineItems = body.items.map((it) => {
      const qty = toNum(it.qty) ?? 0;
      const price = toNum(it.unitPrice) ?? 0;
      return { ...it, qty, price, total: round2(qty * price) };
    });
    if (lineItems.length) {
      await db.insert(salesInvoiceItemsTable).values(
        lineItems.map((it) => ({
          invoiceId: id,
          customerPoItemId: it.customerPoItemId ?? null,
          lineItem: it.lineItem ?? null,
          partNo: it.partNo ?? null,
          description: it.description,
          uom: it.uom ?? null,
          qty: String(it.qty),
          unitPrice: String(it.price),
          total: String(it.total),
        })),
      );
    }
    const net = round2(lineItems.reduce((s, it) => s + it.total, 0));
    const vat = vatOnNet(net, settings.vatRate);
    const gross = round2(net + vat);
    await db
      .update(salesInvoicesTable)
      .set({
        netAmount: String(net),
        vatAmount: String(vat),
        grossAmount: String(gross),
        balance: String(gross - (toNum(existing.collectedAmount) ?? 0)),
      })
      .where(eq(salesInvoicesTable.id, id));
  }
  const patch: Record<string, unknown> = {};
  if (body.customerName != null) patch.customerName = body.customerName;
  if (body.customerId !== undefined) patch.customerId = body.customerId;
  if (body.invoiceDate) patch.invoiceDate = body.invoiceDate;
  if (body.dueDate !== undefined) patch.dueDate = body.dueDate;
  if (body.notes !== undefined) patch.notes = body.notes;
  if (Object.keys(patch).length) {
    await db.update(salesInvoicesTable).set(patch).where(eq(salesInvoicesTable.id, id));
  }
  res.json({ id, updated: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Post — immutable + journal + COGS recognition
// ───────────────────────────────────────────────────────────────────────────
router.post("/accounts/sales-invoices/:id/post", requireRole("accountant", "manager", "admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [inv] = await db
    .select()
    .from(salesInvoicesTable)
    .where(eq(salesInvoicesTable.id, id));
  if (!inv) {
    res.status(404).json({ error: "الفاتورة غير موجودة" });
    return;
  }
  if (inv.status !== "draft") {
    res.status(400).json({ error: "الفاتورة ليست مسودة" });
    return;
  }
  const session = req.session as { employeeId?: number; role?: string; employeeName?: string };
  const settings = await loadTaxSettings();
  const net = toNum(inv.netAmount)!;
  const vat = toNum(inv.vatAmount)!;
  const gross = toNum(inv.grossAmount)!;
  const party = { partyType: "customer" as const, partyId: inv.customerId, partyName: inv.customerName };

  // Compute COGS from the linked customer PO items' realized supplier cost.
  let cogs = 0;
  if (inv.customerPoId) {
    const poItems = await db
      .select({
        cpoItemId: customerPoItemsTable.id,
        acceptedQty: purchaseOrderItemsTable.totalAcceptedQty,
        actualCost: purchaseOrderItemsTable.finalActualCost,
        poItemId: purchaseOrderItemsTable.id,
      })
      .from(customerPoItemsTable)
      .leftJoin(purchaseOrderItemsTable, eq(purchaseOrderItemsTable.customerPoItemId, customerPoItemsTable.id))
      .where(eq(customerPoItemsTable.customerPoId, inv.customerPoId));
    const poItemIds = poItems.map((r) => r.poItemId).filter((x): x is number => x != null);
    const chargesMap = new Map<number, number>();
    if (poItemIds.length) {
      const charges = await db
        .select({ poItemId: poItemChargesTable.poItemId, amount: poItemChargesTable.amount })
        .from(poItemChargesTable);
      for (const c of charges) {
        if (poItemIds.includes(c.poItemId)) chargesMap.set(c.poItemId, (chargesMap.get(c.poItemId) ?? 0) + (toNum(c.amount) ?? 0));
      }
    }
    for (const r of poItems) {
      const accepted = toNum(r.acceptedQty);
      const cost = toNum(r.actualCost);
      const lineCharges = r.poItemId != null ? chargesMap.get(r.poItemId) ?? 0 : 0;
      if (accepted != null && cost != null) cogs += accepted * cost + lineCharges;
    }
    cogs = round2(cogs);
  }

  const lines: import("./posting").JournalLineInput[] = [
    { accountCode: ACCOUNT_CODES.AR, description: `ذمم العملاء — ${inv.invoiceNo}`, debit: gross, ...party },
    { accountCode: ACCOUNT_CODES.SALES, description: "إيرادات المبيعات", credit: net, ...party },
    { accountCode: ACCOUNT_CODES.OUTPUT_VAT, description: "ض.ق.م. المخرجات", credit: vat, ...party },
  ];
  if (cogs > 0) {
    lines.push(
      { accountCode: ACCOUNT_CODES.COGS, description: "تكلفة البضاعة المباعة", debit: cogs },
      { accountCode: ACCOUNT_CODES.INVENTORY, description: "إخراج مخزون", credit: cogs },
    );
  }
  const entryId = await postJournalEntry({
    entryDate: inv.invoiceDate,
    description: `فاتورة بيع ${inv.invoiceNo} — ${inv.customerName}`,
    source: "sales_invoice",
    sourceRefId: inv.id,
    employeeId: session.employeeId,
    employeeName: session.employeeName,
    lines,
  });
  await db
    .update(salesInvoicesTable)
    .set({ status: "posted", postedAt: new Date(), journalEntryId: entryId, cogsAmount: String(cogs) })
    .where(eq(salesInvoicesTable.id, id));
  await db.insert(auditLogTable).values({
    action: "sales_invoice.post",
    entityType: "sales_invoices",
    entityId: id,
    employeeId: session.employeeId,
    description: `ترحيل فاتورة بيع ${inv.invoiceNo}`,
  });
  res.json({ id, posted: true, journalEntryId: entryId, cogs: formatNum(cogs) });
});

router.post("/accounts/sales-invoices/:id/void", requireRole("admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [inv] = await db
    .select()
    .from(salesInvoicesTable)
    .where(eq(salesInvoicesTable.id, id));
  if (!inv) {
    res.status(404).json({ error: "الفاتورة غير موجودة" });
    return;
  }
  const session = req.session as { employeeId?: number; role?: string };
  if (inv.journalEntryId) {
    const { journalEntriesTable } = await import("@workspace/db");
    await db
      .update(journalEntriesTable)
      .set({ status: "void" })
      .where(eq(journalEntriesTable.id, inv.journalEntryId));
  }
  await db
    .update(salesInvoicesTable)
    .set({ status: "void", balance: "0" })
    .where(eq(salesInvoicesTable.id, id));
  await db.insert(auditLogTable).values({
    action: "sales_invoice.void",
    entityType: "sales_invoices",
    entityId: id,
    employeeId: session.employeeId,
    description: `إلغاء فاتورة بيع ${inv.invoiceNo}`,
  });
  res.json({ id, voided: true });
});

// ───────────────────────────────────────────────────────────────────────────
// PDF
// ───────────────────────────────────────────────────────────────────────────
router.get("/accounts/sales-invoices/:id/pdf", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [inv] = await db
    .select()
    .from(salesInvoicesTable)
    .where(eq(salesInvoicesTable.id, id));
  if (!inv) {
    res.status(404).json({ error: "الفاتورة غير موجودة" });
    return;
  }
  const settings = await loadTaxSettings();
  const items = await db
    .select()
    .from(salesInvoiceItemsTable)
    .where(eq(salesInvoiceItemsTable.invoiceId, id))
    .orderBy(salesInvoiceItemsTable.id);
  const pdfBuffer = await generateSalesInvoicePdf({
    invoiceNo: inv.invoiceNo,
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate,
    customerName: inv.customerName,
    customerPoNo: inv.customerPoNo,
    items: items.map((it) => ({
      lineItem: it.lineItem,
      partNo: it.partNo,
      description: it.description,
      qty: it.qty,
      uom: it.uom,
      unitPrice: it.unitPrice,
      total: it.total,
    })),
    netAmount: toNum(inv.netAmount) ?? 0,
    vatAmount: toNum(inv.vatAmount) ?? 0,
    vatRate: settings.vatRate,
    grossAmount: toNum(inv.grossAmount) ?? 0,
    companyName: settings.companyName,
    companyTaxId: settings.companyTaxId,
    companyAddress: settings.companyAddress,
    companyPhone: settings.companyPhone,
    notes: inv.notes,
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${inv.invoiceNo}.pdf"`);
  res.send(pdfBuffer);
});

export default router;
