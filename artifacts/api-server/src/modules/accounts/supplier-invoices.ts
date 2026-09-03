/**
 * Accounts Module — فواتير ومدفوعات الموردين (AP)
 *
 * Supplier invoices record what a supplier billed for a purchase order (net
 * supply + input VAT 14% − withholding خصم تحت حساب المورد). Posting a
 * supplier invoice auto-generates the balanced journal entry:
 *   Dr  Inventory/COGS   net
 *   Dr  Input VAT        vat
 *   Cr  AP (supplier)     net + vat − withholding
 *   Cr  Withholding payable  withholding   (when withholding > 0)
 * Supplier payments settle invoices (full/partial) and post:
 *   Dr  AP (supplier)    appliedAmount
 *   Cr  Cash/Bank        paymentAmount + bankCharges
 *   Dr  Bank charges      bankCharges  (when > 0)
 *
 * Routes:
 *   GET    /accounts/supplier-invoices
 *   POST   /accounts/supplier-invoices
 *   GET    /accounts/supplier-invoices/:id
 *   PATCH  /accounts/supplier-invoices/:id
 *   POST   /accounts/supplier-invoices/:id/post
 *   POST   /accounts/supplier-invoices/:id/void
 *   GET    /accounts/supplier-payments
 *   POST   /accounts/supplier-payments
 *   GET    /accounts/supplier-payments/:id
 */
import { Router } from "express";
import {
  db,
  supplierInvoicesTable,
  supplierPaymentsTable,
  supplierPaymentApplicationsTable,
  purchaseOrdersTable,
  suppliersTable,
  auditLogTable,
  ACCOUNT_CODES,
} from "@workspace/db";
import { eq, desc, and, lte, gte, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { rateOf, vatOnNet, vatComponents, round2 } from "./tax";
import { postJournalEntry, nextEntryNo } from "./posting";

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

interface TaxSettingsLite {
  vatRate: number;
  withholdingRate: number;
}
async function loadTaxLite(): Promise<TaxSettingsLite> {
  const { taxSettingsTable } = await import("@workspace/db");
  const rows = await db.select().from(taxSettingsTable).limit(1);
  const row = rows[0];
  return {
    vatRate: rateOf(row?.vatRate, 14),
    withholdingRate: rateOf(row?.withholdingRate, 3),
  };
}

// Compute net/vat/gross/withholding for a supplier invoice. `net` is the
// VAT-exclusive supply value; VAT added on top at 14%; withholding applied to
// the net (supply value, before VAT) per Egyptian practice.
function computeInvoice(net: number, vatRate: number, whRate: number, hasVat = true) {
  // Purchases from NON-VAT suppliers (غير مُسجَّل) carry NO input VAT — the
  // full amount becomes cost, creating the VAT deficit the company must absorb。
 
  const vat = hasVat === false ? 0 : vatOnNet(net, vatRate);
  const gross = round2(net + vat);
  const withholding = round2((net * whRate) / 100);
  const balance = round2(gross - withholding); // payable to supplier
  return { net: round2(net), vat, gross, withholding, whRate, balance, hasVat };
}

// ───────────────────────────────────────────────────────────────────────────
// Supplier invoices
// ───────────────────────────────────────────────────────────────────────────
router.get("/accounts/supplier-invoices", requireAuth, async (req, res): Promise<void> => {
  const from = (req.query.from as string) || undefined;
  const to = (req.query.to as string) || undefined;
  const status = (req.query.status as string) || undefined;
  const conds = [];
  if (from) conds.push(gte(supplierInvoicesTable.invoiceDate, from));
  if (to) conds.push(lte(supplierInvoicesTable.invoiceDate, to));
  if (status) conds.push(eq(supplierInvoicesTable.status, status));
  const rows = await db
    .select()
    .from(supplierInvoicesTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(supplierInvoicesTable.invoiceDate), desc(supplierInvoicesTable.id));
  res.json(
    rows.map((r) => ({
      id: r.id,
      invoiceNo: r.invoiceNo,
      supplierInvoiceNo: r.supplierInvoiceNo,
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      poId: r.poId,
      poNo: r.poNo,
      invoiceDate: r.invoiceDate,
      dueDate: r.dueDate,
      hasVat: r.hasVat === false ? false : true,
      netAmount: formatNum(toNum(r.netAmount)),
      vatAmount: formatNum(toNum(r.vatAmount)),
      withholdingRate: formatNum(toNum(r.withholdingRate)),
      withholdingAmount: formatNum(toNum(r.withholdingAmount)),
      grossAmount: formatNum(toNum(r.grossAmount)),
      paidAmount: formatNum(toNum(r.paidAmount)),
      balance: formatNum(toNum(r.balance)),
      status: r.status,
      postedAt: r.postedAt,
      createdAt: r.createdAt,
    })),
  );
});

router.get("/accounts/supplier-invoices/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [row] = await db
    .select()
    .from(supplierInvoicesTable)
    .where(eq(supplierInvoicesTable.id, id));
  if (!row) {
    res.status(404).json({ error: "الفاتورة غير موجودة" });
    return;
  }
  const payments = await db
    .select({
      paymentNo: supplierPaymentsTable.paymentNo,
      paymentDate: supplierPaymentsTable.paymentDate,
      amount: supplierPaymentApplicationsTable.amount,
      method: supplierPaymentsTable.method,
      reference: supplierPaymentsTable.reference,
    })
    .from(supplierPaymentApplicationsTable)
    .innerJoin(supplierPaymentsTable, eq(supplierPaymentApplicationsTable.paymentId, supplierPaymentsTable.id))
    .where(eq(supplierPaymentApplicationsTable.invoiceId, id));
  res.json({
    id: row.id,
    invoiceNo: row.invoiceNo,
    supplierInvoiceNo: row.supplierInvoiceNo,
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    poId: row.poId,
    poNo: row.poNo,
    invoiceDate: row.invoiceDate,
    dueDate: row.dueDate,
    hasVat: row.hasVat === false ? false : true,
    netAmount: formatNum(toNum(row.netAmount)),
    vatAmount: formatNum(toNum(row.vatAmount)),
    withholdingRate: formatNum(toNum(row.withholdingRate)),
    withholdingAmount: formatNum(toNum(row.withholdingAmount)),
    grossAmount: formatNum(toNum(row.grossAmount)),
    paidAmount: formatNum(toNum(row.paidAmount)),
    balance: formatNum(toNum(row.balance)),
    status: row.status,
    journalEntryId: row.journalEntryId,
    notes: row.notes,
    employeeName: row.employeeName,
    reviewedByName: row.reviewedByName,
    postedAt: row.postedAt,
    createdAt: row.createdAt,
    payments: payments.map((p) => ({
      paymentNo: p.paymentNo,
      paymentDate: p.paymentDate,
      amount: formatNum(toNum(p.amount)),
      method: p.method,
      reference: p.reference,
    })),
  });
});

router.post("/accounts/supplier-invoices", requireRole("accountant", "manager", "admin"), async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as {
    supplierInvoiceNo?: string | null;
    supplierId?: number | null;
    supplierName: string;
    poId?: number | null;
    invoiceDate: string;
    dueDate?: string | null;
    netAmount: number | string;
    hasVat?: boolean;
    withholdingRate?: number | string | null;
    applyWithholding?: boolean;
    notes?: string | null;
  };
  if (!body.supplierName || !body.invoiceDate || toNum(body.netAmount) == null) {
    res.status(400).json({ error: "اسم المورد وتاريخ الفاتورة وصافي القيمة مطلوبة" });
    return;
  }
  const session = req.session as { employeeId?: number; role?: string; employeeName?: string };
  const settings = await loadTaxLite();
  const net = toNum(body.netAmount)!;
  const whRate = body.applyWithholding === false ? 0 : rateOf(body.withholdingRate != null ? String(body.withholdingRate) : null, settings.withholdingRate);
  // Auto-derive VAT treatment from the linked supplier record (غير مُسجَّل suppliers
  // have invoice_has_vat=false — their invoices carry NO input VAT。 When no
  // supplier is linked the caller must pass hasVat explicitly.
  let hasVat = body.hasVat === undefined ? true : body.hasVat === false ? false : true;
  if (body.hasVat === undefined && body.supplierId) {

    const [sup] = await db
      .select({ invoiceHasVat: suppliersTable.invoiceHasVat })
      .from(suppliersTable)
      .where(eq(suppliersTable.id, body.supplierId))
      .limit(1);
    if (sup && sup.invoiceHasVat === false) hasVat = false;
  }
  const c = computeInvoice(net, settings.vatRate, whRate, hasVat);

  const year = parseInt(body.invoiceDate.slice(0, 4), 10) || new Date().getFullYear();
  const invoiceNo = await nextEntryNo("SI", year);
  let poNo: string | null = null;
  if (body.poId) {
    const [po] = await db
      .select({ no: purchaseOrdersTable.internalPoNo })
      .from(purchaseOrdersTable)
      .where(eq(purchaseOrdersTable.id, body.poId));
    poNo = po?.no ?? null;
  }

  const [row] = await db
    .insert(supplierInvoicesTable)
    .values({
      invoiceNo,
      supplierInvoiceNo: body.supplierInvoiceNo ?? null,
      supplierId: body.supplierId ?? null,
      supplierName: body.supplierName,
      poId: body.poId ?? null,
      poNo,
      invoiceDate: body.invoiceDate,
      dueDate: body.dueDate ?? null,
      netAmount: String(c.net),
      vatAmount: String(c.vat),
      hasVat: c.hasVat,
      withholdingRate: String(c.whRate),
      withholdingAmount: String(c.withholding),
      grossAmount: String(c.gross),
      balance: String(c.balance),
      status: "draft",
      notes: body.notes ?? null,
      employeeId: session.employeeId,
      employeeName: session.employeeName ?? null,
    })
    .returning();
  await db.insert(auditLogTable).values({
    action: "supplier_invoice.create",
    entityType: "supplier_invoices",
    entityId: row!.id,
    employeeId: session.employeeId,
    description: `إنشاء فاتورة مورد ${invoiceNo} — ${body.supplierName}`,
  });
  res.json({ id: row!.id, invoiceNo });
});

router.patch("/accounts/supplier-invoices/:id", requireRole("accountant", "manager", "admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [existing] = await db
    .select()
    .from(supplierInvoicesTable)
    .where(eq(supplierInvoicesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "الفاتورة غير موجودة" });
    return;
  }
  if (existing.status !== "draft") {
    res.status(400).json({ error: "لا يمكن تعديل فاتورة مُرحَّلة — استخدم الإلغاء" });
    return;
  }
  const body = (req.body ?? {}) as {
    supplierInvoiceNo?: string | null;
    supplierId?: number | null;
    supplierName?: string;
    poId?: number | null;
    invoiceDate?: string;
    dueDate?: string | null;
    netAmount?: number | string;
    hasVat?: boolean;
    withholdingRate?: number | string | null;
    applyWithholding?: boolean;
    notes?: string | null;
  };
  const settings = await loadTaxLite();
  const net = body.netAmount != null ? toNum(body.netAmount)! : toNum(existing.netAmount)!;
  const whRate =
    body.applyWithholding === false
      ? 0
      : body.withholdingRate != null
        ? rateOf(String(body.withholdingRate), settings.withholdingRate)
        : rateOf(existing.withholdingRate, settings.withholdingRate);
  const hasVat = body.hasVat === undefined ? (existing.hasVat === false ? false : true) : body.hasVat === false ? false : true;
  const c = computeInvoice(net, settings.vatRate, whRate, hasVat);
  let poNo = existing.poNo;
  if (body.poId !== undefined) {
    if (body.poId) {
      const [po] = await db
        .select({ no: purchaseOrdersTable.internalPoNo })
        .from(purchaseOrdersTable)
        .where(eq(purchaseOrdersTable.id, body.poId));
      poNo = po?.no ?? null;
    } else {
      poNo = null;
    }
  }
  await db
    .update(supplierInvoicesTable)
    .set({
      supplierInvoiceNo: body.supplierInvoiceNo ?? existing.supplierInvoiceNo,
      supplierId: body.supplierId ?? existing.supplierId,
      supplierName: body.supplierName ?? existing.supplierName,
      poId: body.poId ?? existing.poId,
      poNo,
      invoiceDate: body.invoiceDate ?? existing.invoiceDate,
      dueDate: body.dueDate ?? existing.dueDate,
      netAmount: String(c.net),
      vatAmount: String(c.vat),
      hasVat: c.hasVat,
      withholdingRate: String(c.whRate),
      withholdingAmount: String(c.withholding),
      grossAmount: String(c.gross),
      balance: String(c.balance),
      notes: body.notes ?? existing.notes,
    })
    .where(eq(supplierInvoicesTable.id, id));
  res.json({ id, updated: true });
});

// Post → immutable + generates the balanced journal entry.
router.post("/accounts/supplier-invoices/:id/post", requireRole("accountant", "manager", "admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [inv] = await db
    .select()
    .from(supplierInvoicesTable)
    .where(eq(supplierInvoicesTable.id, id));
  if (!inv) {
    res.status(404).json({ error: "الفاتورة غير موجودة" });
    return;
  }
  if (inv.status !== "draft") {
    res.status(400).json({ error: "الفاتورة ليست مسودة" });
    return;
  }
  const session = req.session as { employeeId?: number; role?: string; employeeName?: string };
  const net = toNum(inv.netAmount)!;
  const vat = toNum(inv.vatAmount)!;
  const wh = toNum(inv.withholdingAmount)!;
  const gross = toNum(inv.grossAmount)!;
  const payable = round2(gross - wh);
  const hasVat = inv.hasVat === false ? false : true;
  const party = { partyType: "supplier" as const, partyId: inv.supplierId, partyName: inv.supplierName };

  const entryId = await postJournalEntry({
    entryDate: inv.invoiceDate,
    description: `فاتورة مورد ${inv.invoiceNo} — ${inv.supplierName}`,
    source: "supplier_invoice",
    sourceRefId: inv.id,
    employeeId: session.employeeId,
    employeeName: session.employeeName,
    lines: [
      { accountCode: ACCOUNT_CODES.INVENTORY, description: `صافي قيمة التوريد — ${inv.invoiceNo}`, debit: hasVat ? net : round2(net + vat), ...party },
      // No deductible input VAT for purchases from non-VAT suppliers (غير مُسجَّل)
      ...(hasVat && vat > 0
        ? [{ accountCode: ACCOUNT_CODES.INPUT_VAT, description: "ض.ق.م. المدخلات", debit: vat, ...party }]
        : []),
      { accountCode: ACCOUNT_CODES.AP, description: "ذمم الموردين", credit: payable, ...party },
      ...(wh > 0
        ? [{ accountCode: ACCOUNT_CODES.WITHHOLDING_PAYABLE, description: "الخصم تحت حساب الضريبة", credit: wh, ...party }]
        : []),
    ],
  });
  await db
    .update(supplierInvoicesTable)
    .set({ status: "posted", postedAt: new Date(), journalEntryId: entryId })
    .where(eq(supplierInvoicesTable.id, id));
  await db.insert(auditLogTable).values({
    action: "supplier_invoice.post",
    entityType: "supplier_invoices",
    entityId: id,
    employeeId: session.employeeId,
    description: `ترحيل فاتورة مورد ${inv.invoiceNo}`,
  });
  res.json({ id, posted: true, journalEntryId: entryId });
});

router.post("/accounts/supplier-invoices/:id/void", requireRole("admin"), async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [inv] = await db
    .select()
    .from(supplierInvoicesTable)
    .where(eq(supplierInvoicesTable.id, id));
  if (!inv) {
    res.status(404).json({ error: "الفاتورة غير موجودة" });
    return;
  }
  const session = req.session as { employeeId?: number; role?: string };
  // void the linked journal entry too
  if (inv.journalEntryId) {
    const { journalEntriesTable } = await import("@workspace/db");
    await db
      .update(journalEntriesTable)
      .set({ status: "void" })
      .where(eq(journalEntriesTable.id, inv.journalEntryId));
  }
  await db
    .update(supplierInvoicesTable)
    .set({ status: "void", balance: "0" })
    .where(eq(supplierInvoicesTable.id, id));
  await db.insert(auditLogTable).values({
    action: "supplier_invoice.void",
    entityType: "supplier_invoices",
    entityId: id,
    employeeId: session.employeeId,
    description: `إلغاء فاتورة مورد ${inv.invoiceNo}`,
  });
  res.json({ id, voided: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Supplier payments
// ───────────────────────────────────────────────────────────────────────────
router.get("/accounts/supplier-payments", requireAuth, async (req, res): Promise<void> => {
  const from = (req.query.from as string) || undefined;
  const to = (req.query.to as string) || undefined;
  const conds = [];
  if (from) conds.push(gte(supplierPaymentsTable.paymentDate, from));
  if (to) conds.push(lte(supplierPaymentsTable.paymentDate, to));
  const rows = await db
    .select()
    .from(supplierPaymentsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(supplierPaymentsTable.paymentDate), desc(supplierPaymentsTable.id));
  res.json(
    rows.map((r) => ({
      id: r.id,
      paymentNo: r.paymentNo,
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      poId: r.poId,
      poNo: r.poNo,
      paymentDate: r.paymentDate,
      method: r.method,
      reference: r.reference,
      amount: formatNum(toNum(r.amount)),
      bankCharges: formatNum(toNum(r.bankCharges)),
      cashAccountCode: r.cashAccountCode,
      status: r.status,
      notes: r.notes,
      employeeName: r.employeeName,
      createdAt: r.createdAt,
    })),
  );
});

router.get("/accounts/supplier-payments/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [row] = await db
    .select()
    .from(supplierPaymentsTable)
    .where(eq(supplierPaymentsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "السند غير موجود" });
    return;
  }
  const applications = await db
    .select({
      invoiceId: supplierPaymentApplicationsTable.invoiceId,
      amount: supplierPaymentApplicationsTable.amount,
      invoiceNo: supplierInvoicesTable.invoiceNo,
    })
    .from(supplierPaymentApplicationsTable)
    .leftJoin(supplierInvoicesTable, eq(supplierPaymentApplicationsTable.invoiceId, supplierInvoicesTable.id))
    .where(eq(supplierPaymentApplicationsTable.paymentId, id));
  res.json({
    ...row,
    amount: formatNum(toNum(row.amount)),
    bankCharges: formatNum(toNum(row.bankCharges)),
    applications: applications.map((a) => ({
      invoiceId: a.invoiceId,
      invoiceNo: a.invoiceNo,
      amount: formatNum(toNum(a.amount)),
    })),
  });
});

// Create a supplier payment. `applications` = [{invoiceId, amount}]. If omitted
// and a single posted invoice is open, the whole amount applies to it.
router.post("/accounts/supplier-payments", requireRole("accountant", "manager", "admin"), async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as {
    supplierId?: number | null;
    supplierName: string;
    poId?: number | null;
    paymentDate: string;
    method: string;
    reference?: string | null;
    amount: number | string;
    bankCharges?: number | string | null;
    cashAccountCode?: string;
    notes?: string | null;
    applications?: Array<{ invoiceId: number; amount: number | string }>;
  };
  if (!body.supplierName || !body.paymentDate || !body.method || toNum(body.amount) == null) {
    res.status(400).json({ error: "اسم المورد والتاريخ وطريقة الدفع والمبلغ مطلوبة" });
    return;
  }
  const session = req.session as { employeeId?: number; role?: string; employeeName?: string };
  const amount = toNum(body.amount)!;
  const bankCharges = toNum(body.bankCharges) ?? 0;
  const cashAccount = body.cashAccountCode || ACCOUNT_CODES.BANK;
  const party = { partyType: "supplier" as const, partyId: body.supplierId, partyName: body.supplierName };

  const year = parseInt(body.paymentDate.slice(0, 4), 10) || new Date().getFullYear();
  const paymentNo = await nextEntryNo("SP", year);
  let poNo: string | null = null;
  if (body.poId) {
    const [po] = await db
      .select({ no: purchaseOrdersTable.internalPoNo })
      .from(purchaseOrdersTable)
      .where(eq(purchaseOrdersTable.id, body.poId));
    poNo = po?.no ?? null;
  }

  const entryId = await postJournalEntry({
    entryDate: body.paymentDate,
    description: `سند صرف للمورد ${body.supplierName}`,
    source: "supplier_payment",
    employeeId: session.employeeId,
    employeeName: session.employeeName,
    lines: [
      { accountCode: ACCOUNT_CODES.AP, description: "سداد ذمم مورد", debit: amount, ...party },
      ...(bankCharges > 0
        ? [{ accountCode: ACCOUNT_CODES.BANK_CHARGES, description: "مصاريف بنكية", debit: bankCharges, ...party }]
        : []),
      {
        accountCode: cashAccount,
        description: "صرف نقدي/بنكي",
        credit: round2(amount + bankCharges),
        ...party,
      },
    ],
  });

  const [row] = await db
    .insert(supplierPaymentsTable)
    .values({
      paymentNo,
      supplierId: body.supplierId ?? null,
      supplierName: body.supplierName,
      poId: body.poId ?? null,
      poNo,
      paymentDate: body.paymentDate,
      method: body.method,
      reference: body.reference ?? null,
      amount: String(amount),
      bankCharges: String(bankCharges),
      cashAccountCode: cashAccount,
      status: "posted",
      journalEntryId: entryId,
      notes: body.notes ?? null,
      employeeId: session.employeeId,
      employeeName: session.employeeName ?? null,
    })
    .returning();

  // Apply to invoices
  const apps = body.applications ?? [];
  const appliedTotal = round2(apps.reduce((s, a) => s + (toNum(a.amount) ?? 0), 0));
  if (apps.length === 0 && appliedTotal === 0) {
    // no explicit application — leave open; the accountant allocates later.
  } else if (Math.abs(appliedTotal - amount) > 0.01) {
    res.status(400).json({ error: `مجموع التطبيقات (${appliedTotal}) لا يساوي مبلغ السند (${amount})` });
    return;
  }
  for (const a of apps) {
    const am = toNum(a.amount)!;
    await db.insert(supplierPaymentApplicationsTable).values({ paymentId: row!.id, invoiceId: a.invoiceId, amount: String(am) });
    const [inv] = await db
      .select({ paid: supplierInvoicesTable.paidAmount, balance: supplierInvoicesTable.balance, status: supplierInvoicesTable.status })
      .from(supplierInvoicesTable)
      .where(eq(supplierInvoicesTable.id, a.invoiceId));
    if (inv) {
      const newPaid = round2((toNum(inv.paid) ?? 0) + am);
      const newBalance = round2((toNum(inv.balance) ?? 0) - am);
      await db
        .update(supplierInvoicesTable)
        .set({
          paidAmount: String(newPaid),
          balance: String(newBalance),
          status: newBalance <= 0.01 && inv.status === "posted" ? "paid" : inv.status,
        })
        .where(eq(supplierInvoicesTable.id, a.invoiceId));
    }
  }

  await db.insert(auditLogTable).values({
    action: "supplier_payment.create",
    entityType: "supplier_payments",
    entityId: row!.id,
    employeeId: session.employeeId,
    description: `سند صرف ${paymentNo} — ${body.supplierName}`,
  });
  res.json({ id: row!.id, paymentNo, journalEntryId: entryId });
});

export default router;
