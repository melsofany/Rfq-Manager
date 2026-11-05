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
  financePaymentAllocationsTable,
  financeBulkPaymentsTable,
  financeSupplierStatementsTable,
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
import { insertWithDocNo } from "../accounts/doc-numbering";
import { generatePaymentOrderPdf } from "./payment-order-pdf";
import { generateSupplierStatementPdf } from "./supplier-statement-pdf";
import { allocateFifo, remainingOf, totalOutstanding } from "./allocation";

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

function serializePayment(
  p: typeof financePaymentsTable.$inferSelect,
  bulk?: { id: number; paymentNo: string } | null,
) {
  return {
    id: p.id,
    // A bulk payment's rows carry no number of their own — the transfer is ONE
    // document — so they report the document's number. Without this the history
    // would show "—" for money that demonstrably moved.
    paymentNo: p.paymentNo ?? bulk?.paymentNo ?? null,
    bulkPaymentId: bulk?.id ?? null,
    isBulk: Boolean(bulk),
    amount: fmt(p.amount),
    paymentDate: p.paymentDate,
    method: p.method,
    reference: p.reference,
    notes: p.notes,
    employeeName: p.employeeName,
    createdAt: p.createdAt,
  };
}

/**
 * Map each payment to the bulk document it belongs to (if any).
 *
 * Resolved in ONE query for a whole page — a per-payment lookup would make the
 * finance list an N+1 the moment a supplier had a few bulk transfers.
 */
async function loadBulkNumbers(
  payments: (typeof financePaymentsTable.$inferSelect)[],
): Promise<Map<number, { id: number; paymentNo: string }>> {
  const out = new Map<number, { id: number; paymentNo: string }>();
  const ids = payments.map((p) => p.id);
  if (ids.length === 0) return out;

  const allocs = await db
    .select({
      paymentId: financePaymentAllocationsTable.paymentId,
      bulkPaymentId: financePaymentAllocationsTable.bulkPaymentId,
    })
    .from(financePaymentAllocationsTable)
    .where(inArray(financePaymentAllocationsTable.paymentId, ids));
  if (allocs.length === 0) return out;

  const bulkIds = [...new Set(allocs.map((a) => a.bulkPaymentId))];
  const bulks = await db
    .select({
      id: financeBulkPaymentsTable.id,
      paymentNo: financeBulkPaymentsTable.paymentNo,
    })
    .from(financeBulkPaymentsTable)
    .where(inArray(financeBulkPaymentsTable.id, bulkIds));
  const byBulkId = new Map(bulks.map((b) => [b.id, b]));

  for (const a of allocs) {
    if (a.paymentId == null) continue;
    const bulk = byBulkId.get(a.bulkPaymentId);
    if (bulk) out.set(a.paymentId, bulk);
  }
  return out;
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

  const bulkByPayment = await loadBulkNumbers(payments);
  res.json(
    rows.map((r) =>
      serialize(
        r,
        (byRequest.get(r.id) ?? []).map((p) => serializePayment(p, bulkByPayment.get(p.id))),
      ),
    ),
  );
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
  const bulkByPayment = await loadBulkNumbers(payments);
  res.json(
    serialize(
      row,
      payments.map((p) => serializePayment(p, bulkByPayment.get(p.id))),
    ),
  );
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

    // The payment gets a real document number (`PAY-YYYY-NNNNNN`) so the printed
    // أمر دفع handed to the bank traces back to this row. Allocation goes through
    // `insertWithDocNo`, which serializes the series behind an advisory lock —
    // two operators confirming at the same moment must never share a number.
    const { docNo: paymentNo, row: payment } = await insertWithDocNo(
      "PAY",
      body.paymentDate,
      async (no, tx) => {
        const [row] = await tx
          .insert(financePaymentsTable)
          .values({
            requestId: id,
            paymentNo: no,
            amount: String(amount),
            paymentDate: body.paymentDate as string,
            method: body.method as string,
            reference: body.reference ?? null,
            notes: body.notes ?? null,
            employeeId: session.employeeId ?? null,
            employeeName: session.employeeName ?? null,
          })
          .returning();
        return row;
      },
    );

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

    res.status(201).json({
      ok: true,
      settled,
      paymentNo,
      payment: serializePayment(payment),
      request: serialize(updated ?? row),
    });
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

    // A bulk payment is ONE bank transfer, so its rows are not independent
    // facts: removing one would leave a printed document claiming to have
    // cleared an order it no longer did. The whole document is removed instead.
    const [allocation] = await db
      .select({ bulkPaymentId: financePaymentAllocationsTable.bulkPaymentId })
      .from(financePaymentAllocationsTable)
      .where(eq(financePaymentAllocationsTable.paymentId, id));
    if (allocation) {
      res.status(400).json({
        error: "هذا السداد جزء من أمر دفع إجمالي — احذف أمر الدفع كاملًا",
        bulkPaymentId: allocation.bulkPaymentId,
      });
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

// ─── payment order PDF (أمر دفع) ────────────────────────────────────────────

/**
 * GET /finance/payments/:id/pdf — the printable payment order.
 *
 * A payment order is an instruction to pay an AMOUNT against a purchase order,
 * so it carries no line items: the purchase-order number, the amount (and its
 * Arabic words, which is what catches a mistyped digit on a signed document),
 * the supplier's bank account, and the أعدّه / راجعه / اعتمده signature block.
 * The order's own total / already-paid / remaining make a PARTIAL payment
 * legible as such rather than looking like the whole debt.
 */
router.get("/finance/payments/:id/pdf", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [payment] = await db
    .select()
    .from(financePaymentsTable)
    .where(eq(financePaymentsTable.id, id));
  if (!payment) {
    res.status(404).json({ error: "السداد غير موجود" });
    return;
  }
  const [request] = await db
    .select()
    .from(financePaymentRequestsTable)
    .where(eq(financePaymentRequestsTable.id, payment.requestId));
  if (!request) {
    res.status(404).json({ error: "طلب السداد غير موجود" });
    return;
  }

  const amount = num(payment.amount);
  const paidBefore = round2(num(request.paidAmount) - amount);

  try {
    const pdf = await generatePaymentOrderPdf({
      paymentNo: payment.paymentNo ?? `PAY-${payment.id}`,
      paymentDate: payment.paymentDate,
      supplierName: request.supplierName,
      internalPoNo: request.internalPoNo,
      sheetPoNo: request.poNo,
      bank: {
        bankName: request.bankName,
        bankAccountHolder: request.bankAccountHolder,
        bankAccountNumber: request.bankAccountNumber,
        iban: request.iban,
        swiftCode: request.swiftCode,
        bankBranch: request.bankBranch,
      },
      amount,
      poTotal: num(request.dueAmount),
      paidBefore: paidBefore > 0 ? paidBefore : 0,
      remainingAfter: round2(num(request.dueAmount) - num(request.paidAmount)),
      method: payment.method,
      reference: payment.reference,
      notes: payment.notes,
      preparedBy: payment.employeeName,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="payment-order-${payment.paymentNo ?? payment.id}.pdf"`,
    );
    res.send(pdf);
  } catch (err) {
    logger.error({ err, paymentId: id }, "finance: payment order PDF failed");
    res.status(500).json({ error: "تعذّر توليد أمر الدفع" });
  }
});

// ─── supplier statement (كشف حساب مورد) ─────────────────────────────────────

// ─── bulk payment (سداد إجمالي للمورد) ──────────────────────────────────────

/**
 * The supplier's payable orders, OLDEST FIRST, with their remaining balance.
 *
 * Cancelled and already-settled rows are dropped here rather than filtered by
 * each caller: every consumer of this list (the preview, the FIFO split, the
 * ceiling check) must agree on what "open" means, and two copies of that rule
 * is how a preview and a payment end up disagreeing.
 */
async function loadOpenOrders(supplierId: number) {
  const rows = await db
    .select()
    .from(financePaymentRequestsTable)
    .where(eq(financePaymentRequestsTable.supplierId, supplierId))
    .orderBy(financePaymentRequestsTable.selectedAt);
  return rows
    .filter((r) => remainingOf(r) > 0)
    .sort((a, b) => {
      const d = new Date(a.selectedAt).getTime() - new Date(b.selectedAt).getTime();
      return d !== 0 ? d : a.id - b.id;
    });
}

/** The open requests of one supplier, newest first, with their totals. */
async function loadSupplierStatement(supplierId: number) {
  const rows = await db
    .select()
    .from(financePaymentRequestsTable)
    .where(eq(financePaymentRequestsTable.supplierId, supplierId))
    .orderBy(desc(financePaymentRequestsTable.selectedAt));

  const totalDue = round2(rows.reduce((s, r) => s + num(r.dueAmount), 0));
  const totalPaid = round2(rows.reduce((s, r) => s + num(r.paidAmount), 0));
  const remaining = round2(totalDue - totalPaid);
  return { rows, totalDue, totalPaid, remaining };
}

/**
 * GET /finance/suppliers/:supplierId/statement — the statement DATA.
 *
 * Derived from the supplier's requests at read time and never stored: the
 * statement is a view of what is owed right now, not a financial record.
 */
router.get(
  "/finance/suppliers/:supplierId/statement",
  requireAuth,
  async (req, res): Promise<void> => {
    const supplierId = Number(req.params.supplierId);
    const [supplier] = await db
      .select()
      .from(suppliersTable)
      .where(eq(suppliersTable.id, supplierId));
    if (!supplier) {
      res.status(404).json({ error: "المورد غير موجود" });
      return;
    }
    const { rows, totalDue, totalPaid, remaining } = await loadSupplierStatement(supplierId);
    res.json({
      supplier: {
        id: supplier.id,
        name: supplier.name,
        bank: {
          bankName: supplier.bankName,
          bankAccountHolder: supplier.bankAccountHolder,
          bankAccountNumber: supplier.bankAccountNumber,
          iban: supplier.iban,
          swiftCode: supplier.swiftCode,
          bankBranch: supplier.bankBranch,
        },
        hasBankDetails: Boolean(supplier.bankAccountNumber || supplier.iban),
      },
      rows: rows.map((r) => ({
        id: r.id,
        internalPoNo: r.internalPoNo,
        sheetPoNo: r.poNo,
        selectedAt: r.selectedAt,
        dueAmount: fmt(r.dueAmount),
        paidAmount: fmt(r.paidAmount),
        remainingAmount: fmt(num(r.dueAmount) - num(r.paidAmount)),
        status: r.status,
      })),
      totals: { due: fmt(totalDue), paid: fmt(totalPaid), remaining: fmt(remaining) },
      poCount: rows.length,
    });
  },
);

/**
 * GET /finance/suppliers/:supplierId/open-orders — what a bulk payment would
 * settle, and in what order.
 *
 * The dialog shows this BEFORE the operator commits, so the FIFO split is
 * visible up front rather than discovered on the printed document. `allocated`
 * is the split for the whole outstanding balance; the dialog recomputes it live
 * for whatever total the operator types.
 */
router.get(
  "/finance/suppliers/:supplierId/open-orders",
  requireAuth,
  async (req, res): Promise<void> => {
    const supplierId = Number(req.params.supplierId);
    if (!Number.isInteger(supplierId) || supplierId <= 0) {
      res.status(400).json({ error: "رقم المورد غير صحيح" });
      return;
    }
    const orders = await loadOpenOrders(supplierId);
    res.json({
      supplierId,
      supplierName: orders[0]?.supplierName ?? null,
      orders: orders.map((o) => ({
        requestId: o.id,
        internalPoNo: o.internalPoNo,
        poNo: o.poNo,
        dueAmount: fmt(o.dueAmount),
        paidAmount: fmt(o.paidAmount),
        remainingAmount: fmt(remainingOf(o)),
        selectedAt: o.selectedAt,
      })),
      totalOutstanding: fmt(totalOutstanding(orders)),
      allocated: allocateFifo(orders, totalOutstanding(orders)).map((a) => ({
        requestId: a.requestId,
        amount: fmt(a.amount),
      })),
    });
  },
);

/**
 * POST /finance/suppliers/:supplierId/bulk-payment — settle SEVERAL orders with
 * ONE transfer.
 *
 * The operator types one total; the FIFO split decides how much each open order
 * receives. What comes out is ONE document — one `PAY-…` number, one amount, one
 * transfer reference — carrying a breakdown of which order got what, because a
 * bank transfer is one instruction however many invoices it clears.
 *
 * The per-order rows are still written (`finance_payments`), so the existing
 * status recomputation, the payment history and the Odoo sync keep working
 * unchanged. The document and its allocations are what make them one payment.
 *
 * Refused when the total exceeds what is outstanding: allocating "as much as
 * possible" would silently turn a mistaken amount into a real transfer.
 */
router.post(
  "/finance/suppliers/:supplierId/bulk-payment",
  requireAuth,
  requirePermission(FINANCE_PERM.confirm),
  async (req, res): Promise<void> => {
    const supplierId = Number(req.params.supplierId);
    if (!Number.isInteger(supplierId) || supplierId <= 0) {
      res.status(400).json({ error: "رقم المورد غير صحيح" });
      return;
    }
    const body = (req.body ?? {}) as {
      amount?: unknown;
      paymentDate?: string;
      method?: string;
      reference?: string | null;
      notes?: string | null;
    };
    const amount = round2(num(body.amount));
    if (!(amount > 0)) {
      res.status(400).json({ error: "أدخل مبلغًا صحيحًا أكبر من صفر" });
      return;
    }
    if (!body.paymentDate || !body.method) {
      res.status(400).json({ error: "تاريخ السداد وطريقة السداد مطلوبان" });
      return;
    }
    const session = req.session as { employeeId?: number; role?: string; employeeName?: string };

    const orders = await loadOpenOrders(supplierId);
    if (orders.length === 0) {
      res.status(400).json({ error: "لا توجد أوامر توريد مستحقة لهذا المورد" });
      return;
    }
    const outstanding = totalOutstanding(orders);
    if (amount > outstanding + 0.0001) {
      res.status(400).json({
        error: `المبلغ أكبر من إجمالي المستحق — المتبقي ${fmt(outstanding)}`,
        totalOutstanding: fmt(outstanding),
      });
      return;
    }

    const allocations = allocateFifo(orders, amount);
    if (allocations.length === 0) {
      res.status(400).json({ error: "تعذّر توزيع المبلغ على الأوامر" });
      return;
    }
    const byId = new Map(orders.map((o) => [o.id, o]));

    const { docNo: paymentNo, row: result } = await insertWithDocNo(
      "PAY",
      body.paymentDate,
      async (no, tx) => {
        const [bulkRow] = await tx
          .insert(financeBulkPaymentsTable)
          .values({
            paymentNo: no,
            supplierId,
            supplierName: byId.get(allocations[0].requestId)?.supplierName ?? "",
            amount: String(amount),
            paymentDate: body.paymentDate as string,
            method: body.method as string,
            reference: body.reference ?? null,
            notes: body.notes ?? null,
            orderCount: allocations.length,
            employeeId: session.employeeId ?? null,
            employeeName: session.employeeName ?? null,
          })
          .returning();

        // The created rows are collected HERE, inside the transaction that
        // created them. Re-reading them afterwards by number is impossible now
        // that the number lives only on the document, and re-reading by
        // request would also pick up unrelated earlier payments.
        const paymentIds: number[] = [];

        for (const a of allocations) {
          const order = byId.get(a.requestId);
          if (!order) continue;
          // One `finance_payments` row per order keeps the per-order ledger,
          // the status recomputation and the Odoo sync unchanged.
          //
          // `paymentNo` is deliberately NULL here: `finance_payments` holds a
          // UNIQUE index on it, and a bulk transfer is ONE document, so several
          // rows sharing `PAY-…` would violate it. The number lives on
          // `finance_bulk_payments` and each row reaches it through its
          // allocation, which is what keeps "one transfer, one number" true.
          const [paymentRow] = await tx
            .insert(financePaymentsTable)
            .values({
              requestId: a.requestId,
              paymentNo: null,
              amount: String(a.amount),
              paymentDate: body.paymentDate as string,
              method: body.method as string,
              reference: body.reference ?? null,
              notes: body.notes ?? null,
              employeeId: session.employeeId ?? null,
              employeeName: session.employeeName ?? null,
            })
            .returning();

          await tx.insert(financePaymentAllocationsTable).values({
            bulkPaymentId: bulkRow.id,
            requestId: a.requestId,
            paymentId: paymentRow.id,
            amount: String(a.amount),
          });
          paymentIds.push(paymentRow.id);

          const paid = round2(num(order.paidAmount) + a.amount);
          const settled = paid >= num(order.dueAmount) - 0.0001;
          await tx
            .update(financePaymentRequestsTable)
            .set({
              paidAmount: String(paid),
              status: settled ? FINANCE_REQUEST_STATUS[2] : FINANCE_REQUEST_STATUS[1],
              paidAt: settled ? new Date() : null,
              updatedAt: new Date(),
            })
            .where(eq(financePaymentRequestsTable.id, a.requestId));
        }
        return { bulkRow, paymentIds };
      },
    );

    const { bulkRow: bulk, paymentIds } = result;

    await db
      .insert(auditLogTable)
      .values({
        action: "finance.bulk_paid",
        entityType: "finance_bulk_payment",
        entityId: bulk.id,
        description: `سداد إجمالي ${fmt(amount)} للمورد ${bulk.supplierName} يغطي ${allocations.length} أمر توريد`,
        employeeId: session.employeeId ?? null,
      })
      .catch((err: unknown) => {
        logger.warn({ err }, "finance: audit write failed (non-fatal)");
      });

    // Best-effort, exactly like a single payment: the money has already moved,
    // so a sync hiccup must not roll the document back. Each per-order payment
    // syncs on its own, which is what the Odoo bridge expects.
    for (const paymentId of paymentIds) {
      syncSupplierPayment(paymentId).catch((err: unknown) => {
        logger.warn({ err, paymentId }, "finance: supplier payment sync failed");
      });
    }

    const updated = await loadOpenOrders(supplierId);
    res.status(201).json({
      ok: true,
      paymentNo,
      bulkPaymentId: bulk.id,
      amount: fmt(amount),
      orderCount: allocations.length,
      allocations: allocations.map((a) => ({
        requestId: a.requestId,
        internalPoNo: byId.get(a.requestId)?.internalPoNo ?? null,
        poNo: byId.get(a.requestId)?.poNo ?? null,
        amount: fmt(a.amount),
      })),
      totalOutstanding: fmt(totalOutstanding(updated)),
    });
  },
);

/**
 * GET /finance/bulk-payments/:id/pdf — the ONE document for a bulk transfer.
 *
 * Carries the breakdown table, because a single instruction settling several
 * orders is only auditable if it says which order received how much and the
 * lines add up to the transfer.
 */
router.get("/finance/bulk-payments/:id/pdf", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [bulk] = await db
    .select()
    .from(financeBulkPaymentsTable)
    .where(eq(financeBulkPaymentsTable.id, id));
  if (!bulk) {
    res.status(404).json({ error: "أمر الدفع الإجمالي غير موجود" });
    return;
  }
  const [supplier] = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.id, bulk.supplierId));

  const allocs = await db
    .select()
    .from(financePaymentAllocationsTable)
    .where(eq(financePaymentAllocationsTable.bulkPaymentId, id));

  const requestIds = allocs.map((a) => a.requestId);
  const requestRows =
    requestIds.length > 0
      ? await db
          .select()
          .from(financePaymentRequestsTable)
          .where(inArray(financePaymentRequestsTable.id, requestIds))
      : [];
  const byId = new Map(requestRows.map((r) => [r.id, r]));

  // FIFO order, so the printed breakdown matches the order the money was
  // applied in — an operator re-deriving the split must reach the same answer.
  const allocations = allocs
    .slice()
    .sort((a, b) => {
      const ra = byId.get(a.requestId);
      const rb = byId.get(b.requestId);
      const d = new Date(ra?.selectedAt ?? 0).getTime() - new Date(rb?.selectedAt ?? 0).getTime();
      return d !== 0 ? d : a.requestId - b.requestId;
    })
    .map((a) => ({
      internalPoNo: byId.get(a.requestId)?.internalPoNo ?? null,
      sheetPoNo: byId.get(a.requestId)?.poNo ?? null,
      amount: num(a.amount),
    }));

  const outstanding = await loadOpenOrders(bulk.supplierId);

  try {
    const pdf = await generatePaymentOrderPdf({
      paymentNo: bulk.paymentNo,
      paymentDate: bulk.paymentDate,
      supplierName: bulk.supplierName,
      bank: {
        bankName: supplier?.bankName,
        bankAccountHolder: supplier?.bankAccountHolder,
        bankAccountNumber: supplier?.bankAccountNumber,
        iban: supplier?.iban,
        swiftCode: supplier?.swiftCode,
        bankBranch: supplier?.bankBranch,
      },
      amount: num(bulk.amount),
      allocations,
      totalOutstandingAfter: totalOutstanding(outstanding),
      method: bulk.method,
      reference: bulk.reference,
      notes: bulk.notes,
      preparedBy: bulk.employeeName,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="payment-${bulk.paymentNo}.pdf"`);
    res.send(pdf);
  } catch (err) {
    logger.error({ err, bulkPaymentId: id }, "finance: bulk payment order PDF failed");
    res.status(500).json({ error: "تعذّر توليد أمر الدفع" });
  }
});

/**
 * DELETE /finance/bulk-payments/:id — undo a mistaken bulk transfer.
 *
 * Removes the document, its allocation lines and every per-order payment it
 * created, then recomputes each affected order's status. Reversing the
 * ALLOCATIONS rather than re-deriving the balances is what keeps the books
 * consistent: each order loses exactly the amount the document gave it, so an
 * order that was already partially paid beforehand returns to that exact state.
 */
router.delete(
  "/finance/bulk-payments/:id",
  requireAuth,
  requirePermission(FINANCE_PERM.confirm),
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    const session = req.session as { employeeId?: number; role?: string; employeeName?: string };

    const [bulk] = await db
      .select()
      .from(financeBulkPaymentsTable)
      .where(eq(financeBulkPaymentsTable.id, id));
    if (!bulk) {
      res.status(404).json({ error: "أمر الدفع الإجمالي غير موجود" });
      return;
    }

    const allocs = await db
      .select()
      .from(financePaymentAllocationsTable)
      .where(eq(financePaymentAllocationsTable.bulkPaymentId, id));

    // Every order that lost money to this document, so each is recomputed.
    const affectedRequestIds = [...new Set(allocs.map((a) => a.requestId))];
    const paymentIds = allocs.map((a) => a.paymentId).filter((v): v is number => v != null);

    // The per-order payments are deleted first: the allocations reference them,
    // and the recomputation below must not count a row that is going away.
    if (paymentIds.length > 0) {
      await db.delete(financePaymentsTable).where(inArray(financePaymentsTable.id, paymentIds));
    }
    await db
      .delete(financePaymentAllocationsTable)
      .where(eq(financePaymentAllocationsTable.bulkPaymentId, id));
    await db.delete(financeBulkPaymentsTable).where(eq(financeBulkPaymentsTable.id, id));

    // Recompute each order from the payments that REMAIN — the same rule the
    // single-payment delete uses, so both paths agree on what "paid" means.
    for (const requestId of affectedRequestIds) {
      const [row] = await db
        .select()
        .from(financePaymentRequestsTable)
        .where(eq(financePaymentRequestsTable.id, requestId));
      if (!row) continue;

      const remaining = await db
        .select({ amount: financePaymentsTable.amount })
        .from(financePaymentsTable)
        .where(eq(financePaymentsTable.requestId, requestId));
      const paid = round2(remaining.reduce((s, p) => s + num(p.amount), 0));
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
        .where(eq(financePaymentRequestsTable.id, requestId));
    }

    await db
      .insert(auditLogTable)
      .values({
        action: "finance.bulk_payment_deleted",
        entityType: "finance_bulk_payment",
        entityId: id,
        description: `حذف أمر دفع إجمالي ${bulk.paymentNo} للمورد ${bulk.supplierName} (${affectedRequestIds.length} أمر)`,
        employeeId: session.employeeId ?? null,
      })
      .catch((err: unknown) => {
        logger.warn({ err }, "finance: audit write failed (non-fatal)");
      });

    res.json({ ok: true, paymentNo: bulk.paymentNo, ordersReversed: affectedRequestIds.length });
  },
);

/**
 * GET /finance/suppliers/:supplierId/statement.pdf — the printable statement.
 *
 * Printing records a `finance_supplier_statements` row so the document handed
 * to the supplier has a reference number (`STM-YYYY-NNNNNN`). That register is
 * a document log only — the figures themselves are always re-derived.
 */
router.get(
  "/finance/suppliers/:supplierId/statement.pdf",
  requireAuth,
  async (req, res): Promise<void> => {
    const supplierId = Number(req.params.supplierId);
    const session = req.session as { employeeId?: number; employeeName?: string };
    const [supplier] = await db
      .select()
      .from(suppliersTable)
      .where(eq(suppliersTable.id, supplierId));
    if (!supplier) {
      res.status(404).json({ error: "المورد غير موجود" });
      return;
    }
    const { rows, totalDue, totalPaid, remaining } = await loadSupplierStatement(supplierId);
    const nowIso = new Date().toISOString();

    // A number is allocated even for an empty statement: the operator may need
    // to print a "nothing outstanding" statement, and a document without a
    // reference is not filable.
    let statementNo = "";
    try {
      const { docNo } = await insertWithDocNo("STM", nowIso, async (no, tx) => {
        await tx.insert(financeSupplierStatementsTable).values({
          statementNo: no,
          supplierId,
          supplierName: supplier.name,
          totalDue: String(totalDue),
          totalPaid: String(totalPaid),
          remaining: String(remaining),
          poCount: rows.length,
          generatedBy: session.employeeId ?? null,
          generatedByName: session.employeeName ?? null,
        });
        return no;
      });
      statementNo = docNo;
    } catch (err) {
      // The statement itself is derived data; a failed register write must not
      // withhold the document. Fall back to an unregistered reference.
      logger.warn({ err, supplierId }, "finance: statement register write failed");
      statementNo = `STM-${nowIso.slice(0, 4)}-${supplierId}`;
    }

    try {
      const pdf = await generateSupplierStatementPdf({
        statementNo,
        generatedAt: nowIso,
        supplierName: supplier.name,
        bank: {
          bankName: supplier.bankName,
          bankAccountHolder: supplier.bankAccountHolder,
          bankAccountNumber: supplier.bankAccountNumber,
          iban: supplier.iban,
          swiftCode: supplier.swiftCode,
          bankBranch: supplier.bankBranch,
        },
        rows: rows.map((r) => ({
          internalPoNo: r.internalPoNo,
          sheetPoNo: r.poNo,
          selectedAt: r.selectedAt ? new Date(r.selectedAt).toISOString() : null,
          dueAmount: num(r.dueAmount),
          paidAmount: num(r.paidAmount),
          remainingAmount: round2(num(r.dueAmount) - num(r.paidAmount)),
          status: r.status,
        })),
        totals: { due: totalDue, paid: totalPaid, remaining },
        preparedBy: session.employeeName ?? null,
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="statement-${statementNo}.pdf"`);
      res.send(pdf);
    } catch (err) {
      logger.error({ err, supplierId }, "finance: supplier statement PDF failed");
      res.status(500).json({ error: "تعذّر توليد كشف الحساب" });
    }
  },
);

export default router;
