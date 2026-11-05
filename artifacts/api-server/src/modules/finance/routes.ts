/**
 * Finance Module — الماليات (supplier payment requests)
 *
 * The workflow the operator asked for:
 *   1. on /purchase-orders a purchase order is ticked and added to finance;
 *   2. /finance lists, per supplier, what is owed and the supplier's registered
 *      bank account;
 *   3. a payment is confirmed (fully or partially) and the request is settled —
 *      a settled request can never be paid again.
 *
 * The due amount is the PO's own money: Σ qty × reference_price over the lines
 * of THAT supplier, with cancelled lines excluded (the same rule the rest of
 * the app uses — a cancelled line is not owed).
 *
 * Every route is behind `requireAuth`; the router-level guard in
 * `routes/index.ts` enforces the `finance` page permission.
 */
import { Router } from "express";
import {
  db,
  financePaymentRequestsTable,
  financePaymentsTable,
  purchaseOrderItemsTable,
  purchaseOrdersTable,
  suppliersTable,
  auditLogTable,
  FINANCE_REQUEST_STATUS,
} from "@workspace/db";
import { eq, and, inArray, desc } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { requirePermission } from "../../shared/permissions";
import { logger } from "../../shared/logger";
import { syncSupplierPayment } from "../accounts-bridge/events";

const router = Router();

/**
 * Action-permission keys (mirror of the portal catalog).
 *   select  — see the finance page, queue a PO for payment, remove a queued one;
 *   confirm — actually record money leaving the company (pay / undo a payment).
 * Split because being allowed to CHOOSE what should be paid is not the same as
 * being allowed to confirm the transfer. Admin always passes; a manager has both
 * by default; any other employee is granted them explicitly.
 */
export const FINANCE_PERM = {
  select: "finance:select",
  confirm: "finance:confirm",
} as const;

/** Statuses that still owe money. */
const OPEN_STATUS = FINANCE_REQUEST_STATUS[0]; // unpaid

// ─── helpers ────────────────────────────────────────────────────────────────

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return isFinite(n) ? n : 0;
}

/** Round to 4dp and drop trailing zeros, matching the rest of the app. */
function fmt(v: unknown): string {
  const n = num(v);
  return String(Number(n.toFixed(4)));
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Amount owed to ONE supplier on ONE purchase order.
 * `qty × reference_price` per line, cancelled lines excluded — a cancelled line
 * is not a debt, and counting it would overstate what the company must pay.
 */
function dueForLines(
  lines: { qty: unknown; referencePrice: unknown; lineStatus: unknown }[],
): number {
  let total = 0;
  for (const l of lines) {
    if (l.lineStatus === "cancelled") continue;
    const qty = num(l.qty);
    const price = num(l.referencePrice);
    if (qty <= 0 || price <= 0) continue;
    total += qty * price;
  }
  return round2(total);
}

type RequestRow = typeof financePaymentRequestsTable.$inferSelect;

function serialize(row: RequestRow, payments?: unknown[]) {
  const due = num(row.dueAmount);
  const paid = num(row.paidAmount);
  return {
    id: row.id,
    poId: row.poId,
    supplierId: row.supplierId,
    poNo: row.poNo,
    internalPoNo: row.internalPoNo,
    supplierName: row.supplierName,
    dueAmount: fmt(due),
    paidAmount: fmt(paid),
    remainingAmount: fmt(round2(due - paid)),
    status: row.status,
    bank: {
      bankName: row.bankName,
      bankAccountHolder: row.bankAccountHolder,
      bankAccountNumber: row.bankAccountNumber,
      iban: row.iban,
      swiftCode: row.swiftCode,
      bankBranch: row.bankBranch,
    },
    hasBankDetails: Boolean(row.bankAccountNumber || row.iban),
    notes: row.notes,
    selectedBy: row.selectedBy,
    selectedByName: row.selectedByName,
    selectedAt: row.selectedAt,
    paidAt: row.paidAt,
    payments: payments ?? [],
  };
}

function serializePayment(p: typeof financePaymentsTable.$inferSelect) {
  return {
    id: p.id,
    amount: fmt(p.amount),
    paymentDate: p.paymentDate,
    method: p.method,
    reference: p.reference,
    notes: p.notes,
    employeeName: p.employeeName,
    createdAt: p.createdAt,
  };
}

// ─── select POs for payment ─────────────────────────────────────────────────

/**
 * POST /finance/requests — add purchase orders to the finance list.
 *
 * Body: { poIds: number[] }. Each PO expands to its (po, supplier) pairs, so
 * one order covering three suppliers produces three payable rows. A pair that
 * is already queued is SKIPPED, not duplicated — that is the whole point of the
 * unique (po_id, supplier_id) index.
 */
router.post("/finance/requests", requireAuth, async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as { poIds?: unknown };
  const rawIds = Array.isArray(body.poIds) ? body.poIds : [];
  const poIds = [
    ...new Set(rawIds.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)),
  ];
  if (poIds.length === 0) {
    res.status(400).json({ error: "اختر أمر شراء واحدًا على الأقل" });
    return;
  }

  const session = req.session as { employeeId?: number; role?: string; employeeName?: string };

  // Only a DISPATCHED order is a payable: a draft has not gone to the supplier,
  // so paying it would settle something that was never ordered.
  const pos = await db
    .select({
      id: purchaseOrdersTable.id,
      status: purchaseOrdersTable.status,
      sheetPoNo: purchaseOrdersTable.sheetPoNo,
      internalPoNo: purchaseOrdersTable.internalPoNo,
    })
    .from(purchaseOrdersTable)
    .where(inArray(purchaseOrdersTable.id, poIds));

  const payablePos = pos.filter((p) => p.status !== "draft" && p.status !== "cancelled");
  const skipped: { poId: number; reason: string }[] = [];
  for (const id of poIds) {
    const po = pos.find((p) => p.id === id);
    if (!po) skipped.push({ poId: id, reason: "not_found" });
    else if (po.status === "draft") skipped.push({ poId: id, reason: "draft" });
    else if (po.status === "cancelled") skipped.push({ poId: id, reason: "cancelled" });
  }
  if (payablePos.length === 0) {
    res.status(400).json({
      error: "لا يمكن إضافة هذه الأوامر للماليات (مسودة أو ملغاة)",
      skipped,
    });
    return;
  }

  const payableIds = payablePos.map((p) => p.id);
  const lines = await db
    .select({
      poId: purchaseOrderItemsTable.poId,
      supplierId: purchaseOrderItemsTable.supplierId,
      qty: purchaseOrderItemsTable.qty,
      referencePrice: purchaseOrderItemsTable.referencePrice,
      lineStatus: purchaseOrderItemsTable.lineStatus,
    })
    .from(purchaseOrderItemsTable)
    .where(inArray(purchaseOrderItemsTable.poId, payableIds));

  // (po, supplier) → lines, so each pair gets its own due amount.
  const byPair = new Map<string, typeof lines>();
  for (const l of lines) {
    if (l.supplierId == null) continue;
    const key = `${l.poId}:${l.supplierId}`;
    const list = byPair.get(key) ?? [];
    list.push(l);
    byPair.set(key, list);
  }
  if (byPair.size === 0) {
    res.status(400).json({ error: "أوامر الشراء المختارة ليس لها موردون", skipped });
    return;
  }

  const supplierIds = [...new Set([...byPair.keys()].map((k) => Number(k.split(":")[1])))];
  const suppliers = await db
    .select()
    .from(suppliersTable)
    .where(inArray(suppliersTable.id, supplierIds));
  const supplierMap = new Map(suppliers.map((s) => [s.id, s]));
  const poMap = new Map(payablePos.map((p) => [p.id, p]));

  // Which pairs are already queued — one query, never one per pair.
  const existing = await db
    .select({
      poId: financePaymentRequestsTable.poId,
      supplierId: financePaymentRequestsTable.supplierId,
    })
    .from(financePaymentRequestsTable)
    .where(inArray(financePaymentRequestsTable.poId, payableIds));
  const existingKeys = new Set(existing.map((e) => `${e.poId}:${e.supplierId}`));

  const values = [...byPair.entries()]
    .filter(([key]) => !existingKeys.has(key))
    .map(([key, pairLines]) => {
      const [poIdStr, supplierIdStr] = key.split(":");
      const poId = Number(poIdStr);
      const supplierId = Number(supplierIdStr);
      const supplier = supplierMap.get(supplierId);
      const po = poMap.get(poId);
      return {
        poId,
        supplierId,
        poNo: po?.sheetPoNo ?? null,
        internalPoNo: po?.internalPoNo ?? null,
        supplierName: supplier?.name ?? `#${supplierId}`,
        dueAmount: String(dueForLines(pairLines)),
        status: OPEN_STATUS,
        bankName: supplier?.bankName ?? null,
        bankAccountHolder: supplier?.bankAccountHolder ?? null,
        bankAccountNumber: supplier?.bankAccountNumber ?? null,
        iban: supplier?.iban ?? null,
        swiftCode: supplier?.swiftCode ?? null,
        bankBranch: supplier?.bankBranch ?? null,
        selectedBy: session.employeeId ?? null,
        selectedByName: session.employeeName ?? null,
      };
    });

  const skippedPairs = [...byPair.keys()].filter((k) => existingKeys.has(k));
  for (const key of skippedPairs) {
    const [poId] = key.split(":");
    skipped.push({ poId: Number(poId), reason: "already_added" });
  }

  let created: RequestRow[] = [];
  if (values.length > 0) {
    created = await db.insert(financePaymentRequestsTable).values(values).returning();
    await db
      .insert(auditLogTable)
      .values(
        values.map((v) => ({
          action: "finance.request_created",
          entityType: "finance_payment_request",
          entityId: v.poId,
          description: `إضافة أمر شراء للماليات — ${v.supplierName}`,
          employeeId: session.employeeId ?? null,
        })),
      )
      .catch((err: unknown) => {
        logger.warn({ err }, "finance: audit write failed (non-fatal)");
      });
  }

  res.status(201).json({
    ok: true,
    createdCount: created.length,
    skippedCount: skippedPairs.length,
    requests: created.map((r) => serialize(r)),
    skipped,
  });
});

// ─── list ───────────────────────────────────────────────────────────────────

/** GET /finance/requests?status=&supplierId= — the finance list. */
router.get("/finance/requests", requireAuth, async (req, res): Promise<void> => {
  const status = (req.query.status as string) || undefined;
  const supplierId = req.query.supplierId ? Number(req.query.supplierId) : undefined;

  const conds = [];
  if (status && (FINANCE_REQUEST_STATUS as readonly string[]).includes(status)) {
    conds.push(eq(financePaymentRequestsTable.status, status));
  }
  if (supplierId && Number.isInteger(supplierId)) {
    conds.push(eq(financePaymentRequestsTable.supplierId, supplierId));
  }

  const rows = await db
    .select()
    .from(financePaymentRequestsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(financePaymentRequestsTable.selectedAt));

  // One query for every payment on the page — the list is not an N+1.
  const requestIds = rows.map((r) => r.id);
  const payments =
    requestIds.length > 0
      ? await db
          .select()
          .from(financePaymentsTable)
          .where(inArray(financePaymentsTable.requestId, requestIds))
          .orderBy(desc(financePaymentsTable.paymentDate))
      : [];
  const byRequest = new Map<number, (typeof financePaymentsTable.$inferSelect)[]>();
  for (const p of payments) {
    const list = byRequest.get(p.requestId) ?? [];
    list.push(p);
    byRequest.set(p.requestId, list);
  }

  res.json(rows.map((r) => serialize(r, (byRequest.get(r.id) ?? []).map(serializePayment))));
});

/** GET /finance/summary — headline figures for the page header. */
router.get("/finance/summary", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      status: financePaymentRequestsTable.status,
      due: financePaymentRequestsTable.dueAmount,
      paid: financePaymentRequestsTable.paidAmount,
    })
    .from(financePaymentRequestsTable);

  let totalDue = 0;
  let totalPaid = 0;
  let openCount = 0;
  let paidCount = 0;
  for (const r of rows) {
    totalDue += num(r.due);
    totalPaid += num(r.paid);
    if (r.status === "paid") paidCount += 1;
    else openCount += 1;
  }
  res.json({
    totalDue: fmt(round2(totalDue)),
    totalPaid: fmt(round2(totalPaid)),
    remaining: fmt(round2(totalDue - totalPaid)),
    openCount,
    paidCount,
    count: rows.length,
  });
});

/** GET /finance/requests/:id — one request with its payment history. */
router.get("/finance/requests/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [row] = await db
    .select()
    .from(financePaymentRequestsTable)
    .where(eq(financePaymentRequestsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "طلب السداد غير موجود" });
    return;
  }
  const payments = await db
    .select()
    .from(financePaymentsTable)
    .where(eq(financePaymentsTable.requestId, id))
    .orderBy(desc(financePaymentsTable.paymentDate));
  res.json(serialize(row, payments.map(serializePayment)));
});

// ─── pay ────────────────────────────────────────────────────────────────────

/**
 * POST /finance/requests/:id/payments — confirm a payment (full or partial).
 *
 * Rejects:
 *   • a request already settled (`paid`) — the double-payment guard;
 *   • an amount above what is still owed — overpayment would silently create a
 *     credit the operator never intended;
 *   • a non-positive amount.
 *
 * `status` is RECOMPUTED from the payments after every write, never taken from
 * the request body: the row's status is derived state.
 */
router.post(
  "/finance/requests/:id/payments",
  requireAuth,
  requirePermission(FINANCE_PERM.confirm),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as {
      amount?: unknown;
      paymentDate?: string;
      method?: string;
      reference?: string | null;
      notes?: string | null;
    };

    const amount = num(body.amount);
    if (!(amount > 0)) {
      res.status(400).json({ error: "أدخل مبلغًا صحيحًا أكبر من صفر" });
      return;
    }
    if (!body.paymentDate || !body.method) {
      res.status(400).json({ error: "تاريخ السداد وطريقة السداد مطلوبان" });
      return;
    }

    const session = req.session as { employeeId?: number; role?: string; employeeName?: string };

    const [row] = await db
      .select()
      .from(financePaymentRequestsTable)
      .where(eq(financePaymentRequestsTable.id, id));
    if (!row) {
      res.status(404).json({ error: "طلب السداد غير موجود" });
      return;
    }
    if (row.status === "paid") {
      res.status(400).json({ error: "تم سداد أمر الشراء بالكامل — لا يمكن السداد مرة أخرى" });
      return;
    }

    const due = num(row.dueAmount);
    const alreadyPaid = num(row.paidAmount);
    const remaining = round2(due - alreadyPaid);
    if (amount > remaining + 0.0001) {
      res.status(400).json({
        error: `المبلغ أكبر من المستحق — المتبقي ${fmt(remaining)}`,
        remainingAmount: fmt(remaining),
      });
      return;
    }

    const paid = round2(alreadyPaid + amount);
    const settled = paid >= due - 0.0001;
    const nextStatus = settled ? FINANCE_REQUEST_STATUS[2] : FINANCE_REQUEST_STATUS[1];

    const [payment] = await db
      .insert(financePaymentsTable)
      .values({
        requestId: id,
        amount: String(amount),
        paymentDate: body.paymentDate,
        method: body.method,
        reference: body.reference ?? null,
        notes: body.notes ?? null,
        employeeId: session.employeeId ?? null,
      })
      .returning();

    await db
      .update(financePaymentRequestsTable)
      .set({
        paidAmount: String(paid),
        status: nextStatus,
        paidAt: settled ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(financePaymentRequestsTable.id, id));

    await db
      .insert(auditLogTable)
      .values({
        action: settled ? "finance.paid" : "finance.partial_payment",
        entityType: "finance_payment_request",
        entityId: id,
        description: `سداد ${fmt(amount)} للمورد ${row.supplierName} — أمر الشراء ${row.internalPoNo ?? row.poId}`,
        employeeId: session.employeeId ?? null,
      })
      .catch((err: unknown) => {
        logger.warn({ err }, "finance: audit write failed (non-fatal)");
      });

    // The Odoo sync is best-effort by design: a payment already happened, so an
    // accounting-engine hiccup must not roll it back. A failure is recorded and
    // surfaces on the sync-status screen.
    syncSupplierPayment(payment.id).catch((err: unknown) => {
      logger.warn({ err, paymentId: payment.id }, "finance: supplier payment sync failed");
    });

    const [updated] = await db
      .select()
      .from(financePaymentRequestsTable)
      .where(eq(financePaymentRequestsTable.id, id));

    res.status(201).json({ ok: true, settled, request: serialize(updated ?? row) });
  },
);

// ─── undo a payment ─────────────────────────────────────────────────────────

/**
 * DELETE /finance/payments/:id — remove a mistaken payment.
 *
 * Allowed only while the request is not settled: once fully paid the payment is
 * a closed financial fact. Removing one recomputes the request's status, so a
 * request never claims more paid than its payments sum to.
 */
router.delete(
  "/finance/payments/:id",
  requireAuth,
  requirePermission(FINANCE_PERM.confirm),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    const session = req.session as { employeeId?: number; role?: string; employeeName?: string };

    const [payment] = await db
      .select()
      .from(financePaymentsTable)
      .where(eq(financePaymentsTable.id, id));
    if (!payment) {
      res.status(404).json({ error: "السداد غير موجود" });
      return;
    }
    const [row] = await db
      .select()
      .from(financePaymentRequestsTable)
      .where(eq(financePaymentRequestsTable.id, payment.requestId));
    if (!row) {
      res.status(404).json({ error: "طلب السداد غير موجود" });
      return;
    }
    if (row.status === "paid") {
      res.status(400).json({ error: "أمر الشراء مسدَّد بالكامل — لا يمكن حذف سداد" });
      return;
    }

    await db.delete(financePaymentsTable).where(eq(financePaymentsTable.id, id));

    const remainingPayments = await db
      .select({ amount: financePaymentsTable.amount })
      .from(financePaymentsTable)
      .where(eq(financePaymentsTable.requestId, row.id));
    const paid = round2(remainingPayments.reduce((s, p) => s + num(p.amount), 0));
    const nextStatus =
      paid <= 0
        ? FINANCE_REQUEST_STATUS[0]
        : paid >= num(row.dueAmount) - 0.0001
          ? FINANCE_REQUEST_STATUS[2]
          : FINANCE_REQUEST_STATUS[1];

    await db
      .update(financePaymentRequestsTable)
      .set({
        paidAmount: String(paid),
        status: nextStatus,
        paidAt: nextStatus === FINANCE_REQUEST_STATUS[2] ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(financePaymentRequestsTable.id, row.id));

    await db
      .insert(auditLogTable)
      .values({
        action: "finance.payment_deleted",
        entityType: "finance_payment_request",
        entityId: row.id,
        description: `حذف سداد ${fmt(payment.amount)} للمورد ${row.supplierName}`,
        employeeId: session.employeeId ?? null,
      })
      .catch((err: unknown) => {
        logger.warn({ err }, "finance: audit write failed (non-fatal)");
      });

    const [updated] = await db
      .select()
      .from(financePaymentRequestsTable)
      .where(eq(financePaymentRequestsTable.id, row.id));
    res.json({ ok: true, request: serialize(updated ?? row) });
  },
);

// ─── remove a request from the list ─────────────────────────────────────────

/** DELETE /finance/requests/:id — only while nothing has been paid. */
router.delete("/finance/requests/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [row] = await db
    .select()
    .from(financePaymentRequestsTable)
    .where(eq(financePaymentRequestsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "طلب السداد غير موجود" });
    return;
  }
  if (num(row.paidAmount) > 0) {
    res.status(400).json({ error: "لا يمكن حذف طلب تم سداد جزء منه — احذف السداد أولًا" });
    return;
  }
  await db.delete(financePaymentRequestsTable).where(eq(financePaymentRequestsTable.id, id));
  res.json({ ok: true });
});

// ─── which POs are already queued (for the PO list) ─────────────────────────

/** GET /finance/po-status?poIds=1,2,3 — queued/settled flags per PO. */
router.get("/finance/po-status", requireAuth, async (req, res): Promise<void> => {
  const raw = ((req.query.poIds as string) || "").split(",").map((s) => Number(s.trim()));
  const poIds = [...new Set(raw.filter((n) => Number.isInteger(n) && n > 0))];
  if (poIds.length === 0) {
    res.json({});
    return;
  }
  const rows = await db
    .select({
      poId: financePaymentRequestsTable.poId,
      status: financePaymentRequestsTable.status,
    })
    .from(financePaymentRequestsTable)
    .where(inArray(financePaymentRequestsTable.poId, poIds));

  const out: Record<number, { queued: boolean; settled: boolean; statuses: string[] }> = {};
  for (const poId of poIds) out[poId] = { queued: false, settled: false, statuses: [] };
  for (const r of rows) {
    const entry = out[r.poId];
    if (!entry) continue;
    entry.queued = true;
    entry.statuses.push(r.status);
    if (r.status === "paid") entry.settled = true;
  }
  res.json(out);
});

export default router;
