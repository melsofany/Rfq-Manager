/**
 * Customer Collections Module — متابعة تحصيل مستحقات العملاء
 *
 * Tracks collection of receivables per customer PO. When a customer PO is
 * delivered, collection terms are set (start date + agreed collection days);
 * the system computes the due date and tracks the collection status across
 * recorded payment installments.
 *
 * Receivable for a PO = Σ customer_po_items.qty × unitPrice.
 * Collected = Σ customer_po_payments.amount.
 * Status:
 *   collected — collected ≥ receivable
 *   partial   — 0 < collected < receivable (and overrides due/overdue nuance)
 *   overdue   — past due date and not fully collected
 *   due_soon  — within DUE_SOON_DAYS of due date and not collected
 *   pending   — not yet due (مستحق للتحصيل)
 *
 * Routes mounted:
 *   GET    /collections                     → list (all customer POs w/ status)
 *   GET    /collections/alerts              → due-soon + overdue alerts
 *   GET    /collections/:poId               → detail (terms + payments + status)
 *   PUT    /collections/:poId               → set/update collection terms
 *   POST   /collections/:poId/payments      → record a payment installment
 *   PATCH  /collections/payments/:id        → edit a payment
 *   DELETE /collections/payments/:id        → delete a payment
 */
import { Router } from "express";
import {
  db,
  customerPosTable,
  customerPoItemsTable,
  customerPoCollectionsTable,
  customerPoPaymentsTable,
  customersTable,
  salesInvoicesTable,
  auditLogTable,
  COLLECTION_STATUS,
  DUE_SOON_DAYS,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { postJournalEntry } from "../accounts/posting";
import { ACCOUNT_CODES } from "@workspace/db";
import { cashAccountFor } from "../accounts/integration";

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

/** Add days to a YYYY-MM-DD date string. Returns the new YYYY-MM-DD. */
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const dbb = new Date(b + "T00:00:00Z").getTime();
  return Math.round((dbb - da) / 86400000);
}

/**
 * Compute the collection status for a PO given its receivable, collected, due
 * date, and the current date.
 */
function computeStatus(
  receivable: number,
  collected: number,
  dueDate: string | null,
  now: string,
): string {
  if (receivable <= 0) return COLLECTION_STATUS.pending;
  if (collected >= receivable - 1e-9) return COLLECTION_STATUS.collected;
  if (collected > 0) return COLLECTION_STATUS.partial;
  // Nothing collected yet — consider due date.
  if (!dueDate) return COLLECTION_STATUS.pending;
  const diff = daysBetween(now, dueDate); // positive = due date in future
  if (diff < 0) return COLLECTION_STATUS.overdue;
  if (diff <= DUE_SOON_DAYS) return COLLECTION_STATUS.dueSoon;
  return COLLECTION_STATUS.pending;
}

/** Sum of receivable for a customer PO (Σ qty × unitPrice). */
async function receivableFor(poId: number): Promise<number> {
  const rows = await db
    .select({ qty: customerPoItemsTable.qty, unitPrice: customerPoItemsTable.unitPrice })
    .from(customerPoItemsTable)
    .where(eq(customerPoItemsTable.customerPoId, poId));
  return rows.reduce((s, r) => {
    const q = toNum(r.qty);
    const u = toNum(r.unitPrice);
    return s + (q != null && u != null ? q * u : 0);
  }, 0);
}

/** Sum of payments recorded for a customer PO. */
async function collectedFor(poId: number): Promise<number> {
  const rows = await db
    .select({ amount: customerPoPaymentsTable.amount })
    .from(customerPoPaymentsTable)
    .where(eq(customerPoPaymentsTable.customerPoId, poId));
  return rows.reduce((s, r) => s + (toNum(r.amount) ?? 0), 0);
}

/** Load the (optional) collection terms row for a PO. */
async function loadTerms(poId: number) {
  const rows = await db
    .select()
    .from(customerPoCollectionsTable)
    .where(eq(customerPoCollectionsTable.customerPoId, poId))
    .limit(1);
  return rows[0] ?? null;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "مستحق للتحصيل",
  due_soon: "قريب الاستحقاق",
  overdue: "متأخر",
  partial: "تم التحصيل جزئياً",
  collected: "تم التحصيل بالكامل",
};

const STATUS_TONE: Record<string, string> = {
  pending: "text-muted-foreground bg-muted",
  due_soon: "text-amber-700 bg-amber-100",
  overdue: "text-red-700 bg-red-100",
  partial: "text-blue-700 bg-blue-100",
  collected: "text-emerald-700 bg-emerald-100",
};

// GET /collections — list all customer POs with collection status.
router.get("/collections", requireAuth, async (req, res): Promise<void> => {
  const statusFilter = (req.query.status as string) || undefined;
  const customerName = (req.query.customerName as string) || undefined;

  const pos = await db
    .select({
      id: customerPosTable.id,
      internalPoNo: customerPosTable.internalPoNo,
      customerPoNo: customerPosTable.customerPoNo,
      customerId: customerPosTable.customerId,
      customerName: customerPosTable.customerName,
      storedCustomerName: customersTable.name,
      poDate: customerPosTable.poDate,
      status: customerPosTable.status,
      createdAt: customerPosTable.createdAt,
    })
    .from(customerPosTable)
    .leftJoin(customersTable, eq(customerPosTable.customerId, customersTable.id))
    .orderBy(desc(customerPosTable.createdAt));

  // Batch-load receivables, payments, and terms.
  const now = today();
  const out: any[] = [];
  for (const p of pos) {
    const name = p.customerName ?? p.storedCustomerName ?? null;
    if (customerName && !(name ?? "").toLowerCase().includes(customerName.toLowerCase())) {
      continue;
    }
    const receivable = await receivableFor(p.id);
    const collected = await collectedFor(p.id);
    const terms = await loadTerms(p.id);
    const dueDate = terms?.dueDate ?? null;
    const status = computeStatus(receivable, collected, dueDate, now);
    if (statusFilter && status !== statusFilter) continue;
    out.push({
      customerPoId: p.id,
      internalPoNo: p.internalPoNo,
      customerPoNo: p.customerPoNo,
      customerName: name,
      poDate: p.poDate,
      poStatus: p.status,
      receivable: formatNum(receivable),
      collected: formatNum(collected),
      remaining: formatNum(Math.max(0, receivable - collected)),
      collectionStartDate: terms?.collectionStartDate ?? null,
      collectionDays: terms?.collectionDays ?? null,
      dueDate,
      status,
      statusLabel: STATUS_LABEL[status],
      statusTone: STATUS_TONE[status],
    });
  }

  res.json(out);
});

// GET /collections/alerts — due-soon + overdue POs.
router.get("/collections/alerts", requireAuth, async (_req, res): Promise<void> => {
  const pos = await db
    .select({
      id: customerPosTable.id,
      internalPoNo: customerPosTable.internalPoNo,
      customerPoNo: customerPosTable.customerPoNo,
      customerId: customerPosTable.customerId,
      customerName: customerPosTable.customerName,
      storedCustomerName: customersTable.name,
    })
    .from(customerPosTable)
    .leftJoin(customersTable, eq(customerPosTable.customerId, customersTable.id))
    .orderBy(desc(customerPosTable.createdAt));

  const now = today();
  const dueSoon: any[] = [];
  const overdue: any[] = [];
  for (const p of pos) {
    const receivable = await receivableFor(p.id);
    const collected = await collectedFor(p.id);
    const terms = await loadTerms(p.id);
    const dueDate = terms?.dueDate ?? null;
    const status = computeStatus(receivable, collected, dueDate, now);
    if (status === COLLECTION_STATUS.dueSoon) {
      dueSoon.push({
        customerPoId: p.id,
        internalPoNo: p.internalPoNo,
        customerPoNo: p.customerPoNo,
        customerName: p.customerName ?? p.storedCustomerName ?? null,
        receivable: formatNum(receivable),
        remaining: formatNum(Math.max(0, receivable - collected)),
        dueDate,
      });
    } else if (status === COLLECTION_STATUS.overdue) {
      overdue.push({
        customerPoId: p.id,
        internalPoNo: p.internalPoNo,
        customerPoNo: p.customerPoNo,
        customerName: p.customerName ?? p.storedCustomerName ?? null,
        receivable: formatNum(receivable),
        remaining: formatNum(Math.max(0, receivable - collected)),
        dueDate,
        daysLate: dueDate ? Math.abs(daysBetween(now, dueDate)) : null,
      });
    }
  }

  res.json({
    dueSoonCount: dueSoon.length,
    overdueCount: overdue.length,
    dueSoon,
    overdue,
  });
});

// GET /collections/:poId — detail (terms + payments + computed status).
router.get("/collections/:poId", requireAuth, async (req, res): Promise<void> => {
  const poId = parseInt(String(req.params.poId), 10);
  if (!isFinite(poId)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const [po] = await db
    .select({
      id: customerPosTable.id,
      internalPoNo: customerPosTable.internalPoNo,
      customerPoNo: customerPosTable.customerPoNo,
      customerId: customerPosTable.customerId,
      customerName: customerPosTable.customerName,
      storedCustomerName: customersTable.name,
      poDate: customerPosTable.poDate,
      status: customerPosTable.status,
    })
    .from(customerPosTable)
    .leftJoin(customersTable, eq(customerPosTable.customerId, customersTable.id))
    .where(eq(customerPosTable.id, poId));
  if (!po) {
    res.status(404).json({ error: "أمر شراء العميل غير موجود" });
    return;
  }

  const receivable = await receivableFor(poId);
  const payments = await db
    .select()
    .from(customerPoPaymentsTable)
    .where(eq(customerPoPaymentsTable.customerPoId, poId))
    .orderBy(desc(customerPoPaymentsTable.paymentDate));
  const collected = payments.reduce((s, p) => s + (toNum(p.amount) ?? 0), 0);
  const terms = await loadTerms(poId);
  const now = today();
  const status = computeStatus(receivable, collected, terms?.dueDate ?? null, now);

  res.json({
    customerPoId: po.id,
    internalPoNo: po.internalPoNo,
    customerPoNo: po.customerPoNo,
    customerName: po.customerName ?? po.storedCustomerName ?? null,
    poDate: po.poDate,
    poStatus: po.status,
    receivable: formatNum(receivable),
    collected: formatNum(collected),
    remaining: formatNum(Math.max(0, receivable - collected)),
    terms: terms
      ? {
          id: terms.id,
          collectionStartDate: terms.collectionStartDate,
          collectionDays: terms.collectionDays,
          dueDate: terms.dueDate,
          notes: terms.notes,
        }
      : null,
    status,
    statusLabel: STATUS_LABEL[status],
    statusTone: STATUS_TONE[status],
    payments: payments.map((p) => ({
      id: p.id,
      paymentDate: p.paymentDate,
      amount: formatNum(toNum(p.amount)),
      method: p.method,
      reference: p.reference,
      notes: p.notes,
      employeeName: p.employeeName,
      createdAt: p.createdAt.toISOString(),
    })),
  });
});

// PUT /collections/:poId — set/update collection terms (start date + days).
router.put("/collections/:poId", requireAuth, async (req, res): Promise<void> => {
  const poId = parseInt(String(req.params.poId), 10);
  if (!isFinite(poId)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const [po] = await db
    .select({ id: customerPosTable.id })
    .from(customerPosTable)
    .where(eq(customerPosTable.id, poId));
  if (!po) {
    res.status(404).json({ error: "أمر شراء العميل غير موجود" });
    return;
  }

  const body = req.body ?? {};
  const startDate =
    typeof body.collectionStartDate === "string" && body.collectionStartDate.trim()
      ? body.collectionStartDate.trim()
      : today();
  const days = Number(body.collectionDays);
  const collectionDays = isFinite(days) && days > 0 ? Math.floor(days) : 30;
  const dueDate = addDays(startDate, collectionDays);
  const notes = typeof body.notes === "string" ? body.notes : null;

  const existing = await loadTerms(poId);
  if (existing) {
    await db
      .update(customerPoCollectionsTable)
      .set({ collectionStartDate: startDate, collectionDays, dueDate, notes })
      .where(eq(customerPoCollectionsTable.id, existing.id));
  } else {
    await db.insert(customerPoCollectionsTable).values({
      customerPoId: poId,
      collectionStartDate: startDate,
      collectionDays,
      dueDate,
      notes,
    });
  }

  await db.insert(auditLogTable).values({
    action: "collection.terms",
    entityType: "customer_po",
    entityId: poId,
    employeeId: req.session.employeeId,
    description: `Set collection terms for customer PO ${poId}: ${collectionDays} days, due ${dueDate}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.json({ ok: true, dueDate, collectionDays, collectionStartDate: startDate });
});

// POST /collections/:poId/payments — record a payment installment.
router.post("/collections/:poId/payments", requireAuth, async (req, res): Promise<void> => {
  const poId = parseInt(String(req.params.poId), 10);
  if (!isFinite(poId)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const [po] = await db
    .select({ id: customerPosTable.id })
    .from(customerPosTable)
    .where(eq(customerPosTable.id, poId));
  if (!po) {
    res.status(404).json({ error: "أمر شراء العميل غير موجود" });
    return;
  }

  const body = req.body ?? {};
  const paymentDate =
    typeof body.paymentDate === "string" && body.paymentDate.trim()
      ? body.paymentDate.trim()
      : today();
  const amount = toNum(body.amount);
  if (amount == null || amount <= 0) {
    res.status(400).json({ error: "قيمة الدفعة غير صالحة" });
    return;
  }

  const method = typeof body.method === "string" ? body.method : null;
  const session = req.session as { employeeId?: number; employeeName?: string };
  const [row] = await db
    .insert(customerPoPaymentsTable)
    .values({
      customerPoId: poId,
      paymentDate,
      amount: String(amount),
      method,
      reference: typeof body.reference === "string" ? body.reference : null,
      notes: typeof body.notes === "string" ? body.notes : null,
      employeeId: session.employeeId ?? null,
      employeeName: session.employeeName ?? null,
    })
    .returning({ id: customerPoPaymentsTable.id });

  // ── Ledger integration ──────────────────────────────────────────────────
  // 1. Post a journal entry: debit cash/bank, credit accounts receivable.
  // 2. Apply the payment to the linked posted sales invoices (oldest-first),
  //    reducing their balance / increasing collectedAmount so AR reconciles.
  const cashAccount =
    (typeof body.cashAccountCode === "string" && body.cashAccountCode.trim() ? body.cashAccountCode.trim() : null) ||
    cashAccountFor(method);
  let customerName: string | null = null;
  let remaining = amount;
  const invoices = await db
    .select({
      id: salesInvoicesTable.id,
      invoiceNo: salesInvoicesTable.invoiceNo,
      balance: salesInvoicesTable.balance,
      customerName: salesInvoicesTable.customerName,
    })
    .from(salesInvoicesTable)
    .where(eq(salesInvoicesTable.customerPoId, poId));
  // oldest-first by id
  invoices.sort((a, b) => a.id - b.id);
  for (const inv of invoices) {
    if (remaining <= 0) break;
    const bal = toNum(inv.balance) ?? 0;
    if (bal <= 0) continue;
    customerName = inv.customerName;
    const applied = Math.min(remaining, bal);
    const newBalance = round2(bal - applied);
    const settled = newBalance <= 0.001;
    await db
      .update(salesInvoicesTable)
      .set(settled ? { balance: String(newBalance), status: "paid" } : { balance: String(newBalance) })
      .where(eq(salesInvoicesTable.id, inv.id));
    remaining = round2(remaining - applied);
  }
  if (!customerName) {
    const [poRow] = await db
      .select({ name: customerPosTable.customerName })
      .from(customerPosTable)
      .where(eq(customerPosTable.id, poId));
    customerName = poRow?.name ?? null;
  }

  try {
    await postJournalEntry({
      entryDate: paymentDate,
      description: `تحصيل من العميل — ${customerName ?? `PO ${poId}`}`,
      source: "customer_collection",
      sourceRefId: row.id,
      employeeId: session.employeeId,
      employeeName: session.employeeName,
      lines: [
        { accountCode: cashAccount, description: "إيداع تحصيل", debit: amount, partyType: "customer", partyName: customerName },
        { accountCode: ACCOUNT_CODES.AR, description: "تحصيل ذمم عملاء", credit: amount, partyType: "customer", partyName: customerName },
      ],
    });
  } catch (err) {
    req.log?.error?.({ err }, "collection journal posting failed");
  }

  await db.insert(auditLogTable).values({
    action: "collection.payment",
    entityType: "customer_po",
    entityId: poId,
    employeeId: session.employeeId,
    description: `Recorded payment ${amount} for customer PO ${poId}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.status(201).json({ id: row.id, ok: true });
});

// PATCH /collections/payments/:id — edit a payment.
router.patch("/collections/payments/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!isFinite(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const [existing] = await db
    .select()
    .from(customerPoPaymentsTable)
    .where(eq(customerPoPaymentsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "الدفعة غير موجودة" });
    return;
  }
  const body = req.body ?? {};
  const amount = toNum(body.amount);
  const paymentDate =
    typeof body.paymentDate === "string" && body.paymentDate.trim()
      ? body.paymentDate.trim()
      : existing.paymentDate;

  await db
    .update(customerPoPaymentsTable)
    .set({
      paymentDate,
      amount: amount != null && amount > 0 ? String(amount) : existing.amount,
      method: typeof body.method === "string" ? body.method : existing.method,
      reference: typeof body.reference === "string" ? body.reference : existing.reference,
      notes: typeof body.notes === "string" ? body.notes : existing.notes,
    })
    .where(eq(customerPoPaymentsTable.id, id));

  await db.insert(auditLogTable).values({
    action: "collection.payment.updated",
    entityType: "customer_po",
    entityId: existing.customerPoId,
    employeeId: req.session.employeeId,
    description: `Updated payment ${id} for customer PO ${existing.customerPoId}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });
  res.json({ ok: true });
});

// DELETE /collections/payments/:id — delete a payment.
router.delete("/collections/payments/:id", requireRole("admin", "manager"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!isFinite(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const [existing] = await db
    .select()
    .from(customerPoPaymentsTable)
    .where(eq(customerPoPaymentsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "الدفعة غير موجودة" });
    return;
  }
  await db.delete(customerPoPaymentsTable).where(eq(customerPoPaymentsTable.id, id));
  await db.insert(auditLogTable).values({
    action: "collection.payment.deleted",
    entityType: "customer_po",
    entityId: existing.customerPoId,
    employeeId: req.session.employeeId,
    description: `Deleted payment ${id} for customer PO ${existing.customerPoId}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });
  res.json({ ok: true });
});

export { computeStatus, STATUS_LABEL, STATUS_TONE };
export default router;
