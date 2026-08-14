/**
 * Operating Expenses Module — مصروفات الشركة التشغيلية والعامة
 *
 * Tracks company operating expenses not tied to a specific PO (rent, hosting,
 * utilities, maintenance, admin, …). Each expense carries a date, category,
 * amount, notes, and optional file attachments (receipts/invoices).
 *
 * Routes mounted:
 *   GET    /expenses            → list (filterable by category + date range)
 *   POST   /expenses            → create
 *   GET    /expenses/summary    → totals by category + period
 *   GET    /expenses/:id        → detail (with attachments)
 *   PATCH  /expenses/:id        → update
 *   DELETE /expenses/:id        → delete
 *   POST   /expenses/:id/attachments        → upload an attachment
 *   GET    /expenses/:id/attachments         → list attachments
 *   GET    /expenses/attachments/:id/download → download an attachment
 *   DELETE /expenses/attachments/:id        → delete an attachment
 */
import { Router } from "express";
import multer from "multer";
import {
  db,
  operatingExpensesTable,
  expenseAttachmentsTable,
  auditLogTable,
} from "@workspace/db";
import { eq, and, gte, lte, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";
import type { Request } from "express";
import { postJournalEntry } from "../accounts/posting";
import { expenseAccountFor, cashAccountFor } from "../accounts/integration";

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (
      /^(application\/pdf|image\/|application\/vnd\.(ms-excel|openxmlformats)|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|application\/octet-stream)/.test(
        file.mimetype,
      )
    ) {
      cb(null, true);
    } else {
      cb(new Error("نوع الملف غير مدعوم"));
    }
  },
});

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// GET /expenses — list (filter by category, from, to).
router.get("/expenses", requireAuth, async (req, res): Promise<void> => {
  const category = (req.query.category as string) || undefined;
  const from = (req.query.from as string) || undefined;
  const to = (req.query.to as string) || undefined;

  const conditions = [];
  if (category) conditions.push(eq(operatingExpensesTable.category, category));
  if (from) conditions.push(gte(operatingExpensesTable.expenseDate, from));
  if (to) conditions.push(lte(operatingExpensesTable.expenseDate, to));

  const rows = await db
    .select()
    .from(operatingExpensesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(operatingExpensesTable.expenseDate));

  res.json(
    rows.map((r) => ({
      id: r.id,
      category: r.category,
      description: r.description,
      expenseDate: r.expenseDate,
      amount: formatNum(toNum(r.amount)),
      notes: r.notes,
      employeeName: r.employeeName,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

// GET /expenses/summary — totals by category + grand total.
router.get("/expenses/summary", requireAuth, async (req, res): Promise<void> => {
  const from = (req.query.from as string) || undefined;
  const to = (req.query.to as string) || undefined;

  const conditions = [];
  if (from) conditions.push(gte(operatingExpensesTable.expenseDate, from));
  if (to) conditions.push(lte(operatingExpensesTable.expenseDate, to));

  const rows = await db
    .select({
      category: operatingExpensesTable.category,
      total: sql<number>`sum(${operatingExpensesTable.amount})`,
      count: sql<number>`count(*)`,
    })
    .from(operatingExpensesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(operatingExpensesTable.category);

  const byCategory = rows.map((r) => ({
    category: r.category,
    total: formatNum(toNum(r.total)),
    count: Number(r.count),
  }));
  const grandTotal = byCategory.reduce((s, c) => s + (toNum(c.total) ?? 0), 0);

  res.json({
    from: from ?? null,
    to: to ?? null,
    grandTotal: formatNum(grandTotal),
    categoryCount: byCategory.length,
    byCategory,
  });
});

// GET /expenses/:id — detail with attachments.
router.get("/expenses/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!isFinite(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const [row] = await db
    .select()
    .from(operatingExpensesTable)
    .where(eq(operatingExpensesTable.id, id));
  if (!row) {
    res.status(404).json({ error: "المصروف غير موجود" });
    return;
  }
  const atts = await db
    .select({
      id: expenseAttachmentsTable.id,
      originalName: expenseAttachmentsTable.originalName,
      mimeType: expenseAttachmentsTable.mimeType,
      size: expenseAttachmentsTable.size,
      createdAt: expenseAttachmentsTable.createdAt,
    })
    .from(expenseAttachmentsTable)
    .where(eq(expenseAttachmentsTable.expenseId, id));

  res.json({
    id: row.id,
    category: row.category,
    description: row.description,
    expenseDate: row.expenseDate,
    amount: formatNum(toNum(row.amount)),
    notes: row.notes,
    employeeName: row.employeeName,
    createdAt: row.createdAt.toISOString(),
    attachments: atts.map((a) => ({
      ...a,
      sizeLabel: formatSize(a.size),
      createdAt: a.createdAt.toISOString(),
      downloadUrl: `/api/expenses/attachments/${a.id}/download`,
    })),
  });
});

interface ExpenseInput {
  category?: string;
  description?: string | null;
  expenseDate?: string;
  amount?: string | number;
  notes?: string | null;
  paymentMethod?: string | null;
  cashAccountCode?: string | null;
}

async function validateExpense(body: ExpenseInput): Promise<{
  ok: boolean;
  error?: string;
  values?: {
    category: string;
    description: string | null;
    expenseDate: string;
    amount: string;
    notes: string | null;
    paymentMethod: string | null;
    cashAccountCode: string | null;
  };
}> {
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const expenseDate = typeof body.expenseDate === "string" ? body.expenseDate.trim() : "";
  const amount = toNum(body.amount);
  if (!category) return { ok: false, error: "نوع المصروف مطلوب" };
  if (!expenseDate) return { ok: false, error: "تاريخ المصروف مطلوب" };
  if (amount == null || amount <= 0) return { ok: false, error: "قيمة المصروف غير صالحة" };
  const paymentMethod = typeof body.paymentMethod === "string" && body.paymentMethod.trim() ? body.paymentMethod.trim() : null;
  const cashAccountCode = typeof body.cashAccountCode === "string" && body.cashAccountCode.trim() ? body.cashAccountCode.trim() : null;
  return {
    ok: true,
    values: {
      category,
      description: body.description ?? null,
      expenseDate,
      amount: String(amount),
      notes: body.notes ?? null,
      paymentMethod,
      cashAccountCode,
    },
  };
}

// POST /expenses — create. Also posts a balanced journal entry (expense
// account debit / cash-or-bank credit) so operating expenses reach the
// income statement + trial balance.
router.post("/expenses", requireAuth, async (req, res): Promise<void> => {
  const v = await validateExpense(req.body ?? {});
  if (!v.ok || !v.values) {
    res.status(400).json({ error: v.error });
    return;
  }
  const session = req.session as { employeeId?: number; employeeName?: string };
  const [row] = await db
    .insert(operatingExpensesTable)
    .values({
      category: v.values.category,
      description: v.values.description,
      expenseDate: v.values.expenseDate,
      amount: v.values.amount,
      notes: v.values.notes,
      employeeId: session.employeeId ?? null,
      employeeName: session.employeeName ?? null,
    })
    .returning({ id: operatingExpensesTable.id });

  // Post to the double-entry ledger.
  const amount = Number(v.values.amount);
  const cashAccount =
    v.values.cashAccountCode || cashAccountFor(v.values.paymentMethod);
  const expenseAccount = expenseAccountFor(v.values.category);
  try {
    await postJournalEntry({
      entryDate: v.values.expenseDate,
      description: `مصروف تشغيلي — ${v.values.category}${v.values.description ? ` (${v.values.description})` : ""}`,
      source: "operating_expense",
      sourceRefId: row.id,
      employeeId: session.employeeId,
      employeeName: session.employeeName,
      lines: [
        { accountCode: expenseAccount, description: v.values.category, debit: amount },
        { accountCode: cashAccount, description: "سداد مصروف", credit: amount },
      ],
    });
  } catch (err) {
    req.log?.error?.({ err }, "expense journal posting failed");
  }

  await db.insert(auditLogTable).values({
    action: "expense.create",
    entityType: "operating_expense",
    entityId: row.id,
    employeeId: session.employeeId,
    description: `Created operating expense (${v.values.category}) ${v.values.amount}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.status(201).json({ id: row.id, ok: true });
});

// PATCH /expenses/:id — update.
router.patch("/expenses/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!isFinite(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const [existing] = await db
    .select()
    .from(operatingExpensesTable)
    .where(eq(operatingExpensesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "المصروف غير موجود" });
    return;
  }
  const v = await validateExpense(req.body ?? {});
  if (!v.ok || !v.values) {
    res.status(400).json({ error: v.error });
    return;
  }
  await db
    .update(operatingExpensesTable)
    .set(v.values)
    .where(eq(operatingExpensesTable.id, id));

  await db.insert(auditLogTable).values({
    action: "expense.update",
    entityType: "operating_expense",
    entityId: id,
    employeeId: req.session.employeeId,
    description: `Updated operating expense ${id}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });
  res.json({ ok: true });
});

// DELETE /expenses/:id — delete (cascade removes attachments).
router.delete("/expenses/:id", requireRole("admin", "manager"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!isFinite(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const [existing] = await db
    .select()
    .from(operatingExpensesTable)
    .where(eq(operatingExpensesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "المصروف غير موجود" });
    return;
  }
  await db.delete(operatingExpensesTable).where(eq(operatingExpensesTable.id, id));
  await db.insert(auditLogTable).values({
    action: "expense.delete",
    entityType: "operating_expense",
    entityId: id,
    employeeId: req.session.employeeId,
    description: `Deleted operating expense ${id}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });
  res.json({ ok: true });
});

// ── Attachments ─────────────────────────────────────────────────────────────

// GET /expenses/:id/attachments — list.
router.get("/expenses/:id/attachments", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!isFinite(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const rows = await db
    .select({
      id: expenseAttachmentsTable.id,
      originalName: expenseAttachmentsTable.originalName,
      mimeType: expenseAttachmentsTable.mimeType,
      size: expenseAttachmentsTable.size,
      createdAt: expenseAttachmentsTable.createdAt,
    })
    .from(expenseAttachmentsTable)
    .where(eq(expenseAttachmentsTable.expenseId, id));
  res.json(
    rows.map((a) => ({
      ...a,
      sizeLabel: formatSize(a.size),
      createdAt: a.createdAt.toISOString(),
      downloadUrl: `/api/expenses/attachments/${a.id}/download`,
    })),
  );
});

// POST /expenses/:id/attachments — upload (one file).
router.post(
  "/expenses/:id/attachments",
  requireAuth,
  upload.single("file"),
  async (req: Request & { session?: { employeeId?: number } }, res): Promise<void> => {
    const id = parseInt(String(req.params.id), 10);
    if (!isFinite(id)) {
      res.status(400).json({ error: "معرّف غير صالح" });
      return;
    }
    const [existing] = await db
      .select({ id: operatingExpensesTable.id })
      .from(operatingExpensesTable)
      .where(eq(operatingExpensesTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "المصروف غير موجود" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "لم يتم اختيار ملف" });
      return;
    }
    const [att] = await db
      .insert(expenseAttachmentsTable)
      .values({
        expenseId: id,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        content: req.file.buffer.toString("base64"),
      })
      .returning({
        id: expenseAttachmentsTable.id,
        originalName: expenseAttachmentsTable.originalName,
        mimeType: expenseAttachmentsTable.mimeType,
        size: expenseAttachmentsTable.size,
        createdAt: expenseAttachmentsTable.createdAt,
      });
    res.status(201).json({
      ...att,
      sizeLabel: formatSize(att.size),
      createdAt: att.createdAt.toISOString(),
      downloadUrl: `/api/expenses/attachments/${att.id}/download`,
    });
  },
);

// GET /expenses/attachments/:id/download — serve file.
router.get("/expenses/attachments/:id/download", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!isFinite(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const [att] = await db
    .select()
    .from(expenseAttachmentsTable)
    .where(eq(expenseAttachmentsTable.id, id));
  if (!att) {
    res.status(404).json({ error: "الملف غير موجود" });
    return;
  }
  const buf = Buffer.from(att.content, "base64");
  res.setHeader("Content-Type", att.mimeType || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(att.originalName)}`,
  );
  res.setHeader("Content-Length", buf.length);
  res.send(buf);
});

// DELETE /expenses/attachments/:id — delete attachment.
router.delete("/expenses/attachments/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!isFinite(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  await db.delete(expenseAttachmentsTable).where(eq(expenseAttachmentsTable.id, id));
  res.status(204).send();
});

export default router;
