/**
 * The review centre's working routes: dashboard, workflow, OCR comparison,
 * information requests, category verdicts, audit trail and reports.
 *
 * Split from `index.ts` (the queue/detail/approve surface) because that file
 * predates this work and its docblock explains the raw-SQL decision; keeping the
 * two concerns in one 1500-line file would bury both.
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../../middlewares/auth";
import { logger } from "../../shared/logger";
import {
  ACTION_FOR_TARGET,
  ACTION_LABELS,
  AWAITING_SUPPLIER_STATUSES,
  DECIDED_STATUSES,
  OPEN_STATUSES,
  REVIEW_STATUS,
  REVIEW_STATUS_LABELS,
  actionsFor,
  canPerform,
  canTransition,
  normalizeStatus,
  requiresReason,
  requiresRequestDetail,
  reviewRoleOf,
  type ReviewStatus,
} from "./workflow";
import { recordReviewEvent, loadAuditTrail, REVIEW_EVENT } from "./audit";
import { buildBrandEvidence, buildComparison, type DocumentExtraction } from "./ocr";
import { readApplicationDocuments, docLabel } from "./documents";

const router = Router();

/** The reviewer identity from the session — the audit trail depends on it. */
interface Actor {
  employeeId: number | null;
  employeeName: string | null;
  role: string;
}

function actorOf(req: Parameters<typeof requireAuth>[0]): Actor {
  const session = (req as unknown as { session?: Record<string, unknown> }).session ?? {};
  return {
    employeeId: typeof session.employeeId === "number" ? session.employeeId : null,
    employeeName: typeof session.employeeName === "string" ? session.employeeName : null,
    role: typeof session.role === "string" ? session.role : "",
  };
}

/** The review role, honouring an explicit permission grant over the job role. */
function roleOf(
  req: Parameters<typeof requireAuth>[0],
  permissions?: Record<string, boolean> | null,
) {
  return reviewRoleOf(actorOf(req).role, permissions);
}

/** Load the reviewer's permission map so an explicit grant is honoured. */
async function permissionsOf(
  req: Parameters<typeof requireAuth>[0],
): Promise<Record<string, boolean>> {
  const { employeeId } = actorOf(req);
  if (!employeeId) return {};
  try {
    const { rows } = await pool.query<{ permissions: Record<string, boolean> | null }>(
      `SELECT permissions FROM employees WHERE id = $1`,
      [employeeId],
    );
    return rows[0]?.permissions ?? {};
  } catch {
    // A failed lookup must not silently GRANT: an empty map falls back to the
    // role default, which is the conservative reading.
    return {};
  }
}

interface ApplicationLite {
  id: number;
  reference: string;
  status: string;
  name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  commercial_register: string | null;
  tax_registration: string | null;
  trade_categories: string[] | null;
  other_trade_category: string | null;
  item_category_ids: number[] | null;
  supplied_items: string[] | null;
  brand_names: string[] | null;
  assigned_employee_id: number | null;
  assigned_at: Date | null;
  submitted_at: Date | null;
  first_reviewed_at: Date | null;
  decided_at: Date | null;
  decided_by: number | null;
  due_at: Date | null;
  priority: string | null;
  review_notes: string | null;
  decision_reason: string | null;
  verification: Record<string, string> | null;
  category_verification: Record<string, string> | null;
  info_request: Record<string, unknown> | null;
  supplier_id: number | null;
  created_at: Date;
  updated_at: Date | null;
}

const LITE_COLUMNS = `id, reference, status, name, contact_person, email, phone, address,
  commercial_register, tax_registration, trade_categories, other_trade_category,
  item_category_ids, supplied_items, brand_names, assigned_employee_id, assigned_at,
  submitted_at, first_reviewed_at, decided_at, decided_by, due_at, priority,
  review_notes, decision_reason, verification, category_verification, info_request,
  supplier_id, created_at, updated_at`;

async function loadApplication(id: number): Promise<ApplicationLite | null> {
  const { rows } = await pool.query<ApplicationLite>(
    `SELECT ${LITE_COLUMNS} FROM supplier_applications WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ─── Dashboard ─────────────────────────────────────────────────────────────

/**
 * GET /supplier-review/dashboard
 *
 * Ten indicators the operator listed, computed from the rows themselves.
 *
 * «متأخر» is derived, not stored: a request is late when it is still open and
 * its due date (or, with no explicit due date, the review SLA from submission)
 * has passed. A stored flag would be wrong the moment the clock moves and
 * nothing runs to update it.
 */
router.get("/supplier-review/dashboard", requireAuth, async (req, res): Promise<void> => {
  const from = String(req.query.from ?? "").trim();
  const to = String(req.query.to ?? "").trim();
  const employee = parseId(req.query.employeeId);
  const province = String(req.query.province ?? "").trim();
  const slaDays = Math.max(1, Number(req.query.slaDays ?? 5) || 5);

  const where: string[] = [];
  const params: unknown[] = [];
  if (from) {
    params.push(from);
    where.push(`created_at >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`created_at < ($${params.length}::date + interval '1 day')`);
  }
  if (employee) {
    params.push(employee);
    where.push(`assigned_employee_id = $${params.length}`);
  }
  if (province) {
    params.push(`%${province}%`);
    where.push(`address ILIKE $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { rows } = await pool.query<{
    id: number;
    status: string;
    assigned_employee_id: number | null;
    created_at: Date;
    submitted_at: Date | null;
    first_reviewed_at: Date | null;
    decided_at: Date | null;
    due_at: Date | null;
    supplier_id: number | null;
  }>(
    `SELECT id, status, assigned_employee_id, created_at, submitted_at,
            first_reviewed_at, decided_at, due_at, supplier_id
       FROM supplier_applications ${whereSql}`,
    params,
  );

  const now = Date.now();
  const buckets: Record<string, number> = {};
  let late = 0;
  let reviewMsTotal = 0;
  let reviewSamples = 0;
  let decided = 0;
  let approved = 0;
  let awaitingSupplier = 0;

  for (const row of rows) {
    const status = normalizeStatus(row.status);
    buckets[status] = (buckets[status] ?? 0) + 1;
    if (AWAITING_SUPPLIER_STATUSES.includes(status)) awaitingSupplier += 1;

    const isOpen = OPEN_STATUSES.includes(status);
    const anchor = row.submitted_at ?? row.created_at;
    const dueMs = row.due_at
      ? new Date(row.due_at).getTime()
      : anchor
        ? new Date(anchor).getTime() + slaDays * 86_400_000
        : null;
    if (isOpen && dueMs !== null && now > dueMs) late += 1;

    if (DECIDED_STATUSES.includes(status)) {
      decided += 1;
      if (status === REVIEW_STATUS.APPROVED) approved += 1;
      const start = row.submitted_at ?? row.created_at;
      const end = row.decided_at ?? row.first_reviewed_at;
      if (start && end) {
        const ms = new Date(end).getTime() - new Date(start).getTime();
        if (ms >= 0) {
          reviewMsTotal += ms;
          reviewSamples += 1;
        }
      }
    }
  }

  const total = rows.length;
  res.json({
    totals: {
      total,
      new: buckets[REVIEW_STATUS.NEW] ?? 0,
      assigned: buckets[REVIEW_STATUS.ASSIGNED] ?? 0,
      underReview: buckets[REVIEW_STATUS.UNDER_REVIEW] ?? 0,
      needsInformation: buckets[REVIEW_STATUS.NEEDS_INFORMATION] ?? 0,
      needsDocuments: buckets[REVIEW_STATUS.NEEDS_DOCUMENTS] ?? 0,
      resubmitted: buckets[REVIEW_STATUS.RESUBMITTED] ?? 0,
      verified: buckets[REVIEW_STATUS.VERIFIED] ?? 0,
      approved: buckets[REVIEW_STATUS.APPROVED] ?? 0,
      rejected: buckets[REVIEW_STATUS.REJECTED] ?? 0,
      suspended: buckets[REVIEW_STATUS.SUSPENDED] ?? 0,
      awaitingSupplier,
      late,
      decided,
      /** null (not 0) when nothing has been decided — an average of no data. */
      avgReviewDays:
        reviewSamples > 0 ? Number((reviewMsTotal / reviewSamples / 86_400_000).toFixed(2)) : null,
      /** null when nothing was decided: 0/0 is not 0%. */
      approvalRate: decided > 0 ? Number(((approved / decided) * 100).toFixed(1)) : null,
      slaDays,
    },
    byStatus: Object.entries(buckets).map(([status, count]) => ({
      status,
      label: REVIEW_STATUS_LABELS[status as ReviewStatus] ?? status,
      count,
    })),
  });
});

// ─── Workflow ──────────────────────────────────────────────────────────────

/**
 * POST /supplier-review/applications/:id/transition
 *
 * The ONE place a status changes. Every write records who, when and why, and
 * the legal moves live in `workflow.ts` — not in this handler.
 *
 * APPROVED is deliberately unreachable from this route when the application has
 * not passed VERIFIED: the reviewer's verification is the evidence an approver
 * reads, and skipping it would make the two-role split cosmetic.
 */
router.post(
  "/supplier-review/applications/:id/transition",
  requireAuth,
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "رقم الطلب غير صحيح" });
      return;
    }
    const target = normalizeStatus(String((req.body ?? {}).to ?? ""));
    const note = String((req.body ?? {}).note ?? "").trim();
    const assignTo = parseId((req.body ?? {}).assignToEmployeeId);
    const requestItems = (req.body ?? {}).requestItems as unknown;

    const application = await loadApplication(id);
    if (!application) {
      res.status(404).json({ error: "الطلب غير موجود" });
      return;
    }

    const actor = actorOf(req);
    const perms = await permissionsOf(req);
    const role = reviewRoleOf(actor.role, perms);
    const action = ACTION_FOR_TARGET[target];
    if (!action) {
      res.status(400).json({ error: "حالة غير معروفة" });
      return;
    }
    if (!canPerform(role, action)) {
      res.status(403).json({
        error: `صلاحيتك (${role}) لا تسمح بإجراء «${ACTION_LABELS[action]}»`,
        requiredAction: action,
        yourRole: role,
      });
      return;
    }

    const from = normalizeStatus(application.status);
    const check = canTransition(from, target);
    if (!check.ok) {
      res.status(409).json({ error: check.error, from, to: target });
      return;
    }
    if (requiresReason(target) && !note) {
      res.status(400).json({ error: "يجب كتابة سبب القرار" });
      return;
    }
    if (requiresRequestDetail(target) && !note && !requestItems) {
      res.status(400).json({ error: "حدّد المطلوب من المورد أو اكتب ملاحظة" });
      return;
    }
    // The approver reads the reviewer's verification. Reaching APPROVED without
    // it would mean a decision taken on no evidence.
    if (target === REVIEW_STATUS.APPROVED && from !== REVIEW_STATUS.VERIFIED) {
      res.status(409).json({
        error:
          "لا يمكن الاعتماد قبل اجتياز الفحص (VERIFIED) — الاعتماد النهائي قرار بشري مبني على مراجعة",
        from,
      });
      return;
    }

    const sets: string[] = ["status = $2", "updated_at = now()"];
    const values: unknown[] = [id, target];
    const push = (fragment: string, value: unknown) => {
      values.push(value);
      sets.push(fragment.replace("?", `$${values.length}`));
    };

    if (target === REVIEW_STATUS.ASSIGNED) {
      push("assigned_employee_id = ?", assignTo ?? actor.employeeId);
      sets.push("assigned_at = now()");
    }
    if (target === REVIEW_STATUS.UNDER_REVIEW && !application.first_reviewed_at) {
      sets.push("first_reviewed_at = now()");
    }
    if (target === REVIEW_STATUS.VERIFIED) {
      push("verified_by = ?", actor.employeeId);
      sets.push("verified_at = now()");
    }
    if (target === REVIEW_STATUS.APPROVED || target === REVIEW_STATUS.REJECTED) {
      push("decided_by = ?", actor.employeeId);
      sets.push("decided_at = now()");
    }
    if (requiresReason(target)) push("decision_reason = ?", note || null);
    if (requiresRequestDetail(target)) {
      push(
        "info_request = ?::jsonb",
        JSON.stringify({
          note,
          items: Array.isArray(requestItems) ? requestItems : [],
          requestedAt: new Date().toISOString(),
          requestedBy: actor.employeeName,
          deadline: (req.body ?? {}).deadline ?? null,
        }),
      );
    }

    try {
      await pool.query(`UPDATE supplier_applications SET ${sets.join(", ")} WHERE id = $1`, values);
    } catch (err) {
      logger.error({ err, applicationId: id }, "supplier review transition failed");
      res.status(500).json({ error: "تعذّر تحديث حالة الطلب" });
      return;
    }

    const eventMap: Record<string, string> = {
      [REVIEW_STATUS.ASSIGNED]: REVIEW_EVENT.ASSIGNED,
      [REVIEW_STATUS.UNDER_REVIEW]: REVIEW_EVENT.STARTED,
      [REVIEW_STATUS.NEEDS_INFORMATION]: REVIEW_EVENT.INFO_REQUESTED,
      [REVIEW_STATUS.NEEDS_DOCUMENTS]: REVIEW_EVENT.DOCS_REQUESTED,
      [REVIEW_STATUS.VERIFIED]: REVIEW_EVENT.VERIFIED,
      [REVIEW_STATUS.APPROVED]: REVIEW_EVENT.APPROVED,
      [REVIEW_STATUS.REJECTED]: REVIEW_EVENT.REJECTED,
      [REVIEW_STATUS.SUSPENDED]: REVIEW_EVENT.SUSPENDED,
      [REVIEW_STATUS.RESUBMITTED]: REVIEW_EVENT.RESUBMITTED,
    };
    await recordReviewEvent({
      applicationId: id,
      event: eventMap[target] ?? "status_changed",
      fromStatus: from,
      toStatus: target,
      note: note || null,
      actor,
      metadata: assignTo ? { assignedTo: assignTo } : null,
    });

    res.json({ ok: true, from, to: target, label: REVIEW_STATUS_LABELS[target] });
  },
);

/** GET /supplier-review/applications/:id/actions — what THIS user may do. */
router.get(
  "/supplier-review/applications/:id/actions",
  requireAuth,
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "رقم الطلب غير صحيح" });
      return;
    }
    const application = await loadApplication(id);
    if (!application) {
      res.status(404).json({ error: "الطلب غير موجود" });
      return;
    }
    const perms = await permissionsOf(req);
    const role = reviewRoleOf(actorOf(req).role, perms);
    const from = normalizeStatus(application.status);
    const allowed = actionsFor(role);
    const available = Object.entries(ACTION_FOR_TARGET)
      .filter(([, action]) => allowed.includes(action))
      .filter(([target]) => canTransition(from, target as ReviewStatus).ok)
      .map(([target, action]) => ({
        to: target,
        action,
        label: ACTION_LABELS[action],
      }));
    res.json({ role, from, available });
  },
);

// ─── Document reading + comparison ─────────────────────────────────────────

/**
 * POST /supplier-review/applications/:id/read-documents
 *
 * Reads the documents (OCR/vision) and returns the comparison table. `force`
 * re-reads the cached ones — the reviewer's «أعد الفحص».
 *
 * NOTHING here changes the application's status or verdicts. The operator's
 * rule is explicit: AI output is indicative, the reviewer decides.
 */
router.post(
  "/supplier-review/applications/:id/read-documents",
  requireAuth,
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "رقم الطلب غير صحيح" });
      return;
    }
    const application = await loadApplication(id);
    if (!application) {
      res.status(404).json({ error: "الطلب غير موجود" });
      return;
    }

    const force = Boolean((req.body ?? {}).force);
    let readings;
    try {
      readings = await readApplicationDocuments(id, { force });
    } catch (err) {
      logger.error({ err, applicationId: id }, "supplier document reading failed");
      res.status(500).json({ error: "تعذّرت قراءة المستندات" });
      return;
    }

    const documents = readings.map((r) => ({
      id: r.id,
      slot: r.slot,
      label: r.label,
      originalName: r.originalName,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      freshlyRead: r.freshlyRead,
      extraction: r.extraction,
    }));

    const comparison = buildComparison({
      declared: {
        name: application.name,
        taxRegistration: application.tax_registration,
        commercialRegister: application.commercial_register,
        activity: (application.trade_categories ?? []).join(", "),
      },
      documents: readings.map((r) => ({ id: r.id, label: r.label, extraction: r.extraction })),
    });

    const brandEvidence = buildBrandEvidence(
      application.brand_names ?? [],
      readings.map((r) => ({ id: r.id, label: r.label, extraction: r.extraction })),
    );

    const unreadable = documents.filter((d) => d.extraction.unreadable).length;
    await recordReviewEvent({
      applicationId: id,
      event: REVIEW_EVENT.COMPARISON,
      actor: actorOf(req),
      metadata: {
        documents: documents.length,
        unreadable,
        forced: force,
        mismatched: comparison.filter((c) => c.result === "mismatch").map((c) => c.key),
      },
      note: `قراءة ${documents.length} مستند — ${unreadable} غير مقروء`,
    });

    res.json({
      documents,
      comparison,
      brandEvidence,
      summary: {
        documents: documents.length,
        unreadable,
        matched: comparison.filter((c) => c.result === "match" || c.result === "match_reordered")
          .length,
        mismatched: comparison.filter((c) => c.result === "mismatch").length,
        notFound: comparison.filter((c) => c.result === "not_in_document").length,
      },
    });
  },
);

// ─── Per-category activity verification ────────────────────────────────────

const CATEGORY_VERDICTS = ["proven", "partial", "not_proven", "needs_document"] as const;
export type CategoryVerdict = (typeof CATEGORY_VERDICTS)[number];

export const CATEGORY_VERDICT_LABELS: Record<CategoryVerdict, string> = {
  proven: "مثبت بالمستندات",
  partial: "مثبت جزئيًا",
  not_proven: "غير مثبت",
  needs_document: "يحتاج مستندًا إضافيًا",
};

/**
 * POST /supplier-review/applications/:id/category-verdicts
 *
 * Records the reviewer's answer for ONE category or item — «هل النشاط مثبت
 * بالمستندات؟». Separate from the identity comparison: proving a company exists
 * says nothing about whether it really trades in the categories it picked.
 */
router.post(
  "/supplier-review/applications/:id/category-verdicts",
  requireAuth,
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "رقم الطلب غير صحيح" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = String(body.kind ?? "").trim();
    const name = String(body.name ?? "").trim();
    const verdict = String(body.verdict ?? "").trim() as CategoryVerdict;
    const note = String(body.note ?? "").trim();
    const refId = parseId(body.refId);

    if (!["trade", "item", "brand"].includes(kind)) {
      res.status(400).json({ error: "نوع التصنيف غير صحيح" });
      return;
    }
    if (!name) {
      res.status(400).json({ error: "اسم التصنيف مطلوب" });
      return;
    }
    if (!CATEGORY_VERDICTS.includes(verdict)) {
      res.status(400).json({ error: "نتيجة التحقق غير صحيحة" });
      return;
    }

    const actor = actorOf(req);
    const perms = await permissionsOf(req);
    if (!canPerform(reviewRoleOf(actor.role, perms), "verify")) {
      res.status(403).json({ error: "صلاحيتك لا تسمح بتسجيل نتيجة تحقق" });
      return;
    }

    try {
      await pool.query(
        `INSERT INTO supplier_application_category_verdicts
           (application_id, kind, ref_id, name, verdict, note, employee_id, employee_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (application_id, kind, name)
         DO UPDATE SET verdict = EXCLUDED.verdict, note = EXCLUDED.note,
                       ref_id = EXCLUDED.ref_id, employee_id = EXCLUDED.employee_id,
                       employee_name = EXCLUDED.employee_name, updated_at = now()`,
        [id, kind, refId, name, verdict, note || null, actor.employeeId, actor.employeeName],
      );
    } catch (err) {
      logger.error({ err, applicationId: id }, "category verdict write failed");
      res.status(500).json({ error: "تعذّر حفظ نتيجة التحقق" });
      return;
    }

    await recordReviewEvent({
      applicationId: id,
      event: REVIEW_EVENT.CATEGORY_VERDICT,
      actor,
      note: `${kind}: ${name} — ${CATEGORY_VERDICT_LABELS[verdict]}${note ? ` (${note})` : ""}`,
      metadata: { kind, name, verdict },
    });

    res.json({ ok: true, kind, name, verdict, label: CATEGORY_VERDICT_LABELS[verdict] });
  },
);

/** GET /supplier-review/applications/:id/category-verdicts */
router.get(
  "/supplier-review/applications/:id/category-verdicts",
  requireAuth,
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "رقم الطلب غير صحيح" });
      return;
    }
    const { rows } = await pool.query<{
      kind: string;
      ref_id: number | null;
      name: string;
      verdict: string;
      note: string | null;
      employee_name: string | null;
      updated_at: Date;
    }>(
      `SELECT kind, ref_id, name, verdict, note, employee_name, updated_at
         FROM supplier_application_category_verdicts
        WHERE application_id = $1 ORDER BY kind, name`,
      [id],
    );
    res.json({
      verdicts: rows.map((r) => ({
        kind: r.kind,
        refId: r.ref_id,
        name: r.name,
        verdict: r.verdict,
        label: CATEGORY_VERDICT_LABELS[r.verdict as CategoryVerdict] ?? r.verdict,
        note: r.note,
        employeeName: r.employee_name,
        updatedAt: r.updated_at.toISOString(),
      })),
    });
  },
);

// ─── Audit trail ───────────────────────────────────────────────────────────

/** GET /supplier-review/applications/:id/audit — the full history. */
router.get(
  "/supplier-review/applications/:id/audit",
  requireAuth,
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "رقم الطلب غير صحيح" });
      return;
    }
    res.json({ events: await loadAuditTrail(id) });
  },
);

// ─── Reports ───────────────────────────────────────────────────────────────

/**
 * GET /supplier-review/reports
 *
 * The seven reports the operator listed, from the rows themselves.
 *
 * A report that cannot be computed from stored data is returned as EMPTY with
 * `available: false` rather than as a zero — «0 documents cause rejections» and
 * «we never recorded why» are different statements, and the second is the truth
 * here.
 */
router.get("/supplier-review/reports", requireAuth, async (req, res): Promise<void> => {
  const from = String(req.query.from ?? "").trim();
  const to = String(req.query.to ?? "").trim();
  const where: string[] = [];
  const params: unknown[] = [];
  if (from) {
    params.push(from);
    where.push(`created_at >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`created_at < ($${params.length}::date + interval '1 day')`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const apps = await pool.query<{
    id: number;
    status: string;
    trade_categories: string[] | null;
    other_trade_category: string | null;
    decision_reason: string | null;
    assigned_employee_id: number | null;
    created_at: Date;
    submitted_at: Date | null;
    decided_at: Date | null;
  }>(
    `SELECT id, status, trade_categories, other_trade_category, decision_reason,
            assigned_employee_id, created_at, submitted_at, decided_at
       FROM supplier_applications ${whereSql}`,
    params,
  );

  const employees = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM employees`,
  );
  const employeeName = new Map(employees.rows.map((e) => [e.id, e.name]));

  const approvedByCategory = new Map<string, number>();
  const rejectionReasons = new Map<string, number>();
  const proposedCategories = new Map<string, number>();
  const reviewerStats = new Map<
    number,
    {
      name: string;
      reviewed: number;
      approved: number;
      rejected: number;
      totalMs: number;
      samples: number;
    }
  >();
  let needsFollowUp = 0;

  for (const row of apps.rows) {
    const status = normalizeStatus(row.status);
    const cats = [...(row.trade_categories ?? []), row.other_trade_category ?? ""].filter(Boolean);
    if (status === REVIEW_STATUS.APPROVED) {
      for (const c of cats) approvedByCategory.set(c, (approvedByCategory.get(c) ?? 0) + 1);
    }
    if (status === REVIEW_STATUS.REJECTED) {
      const reason = (row.decision_reason ?? "بدون سبب مسجل").trim();
      rejectionReasons.set(reason, (rejectionReasons.get(reason) ?? 0) + 1);
    }
    if ((row.trade_categories ?? []).includes("__other__") || row.other_trade_category) {
      const typed = (row.other_trade_category ?? "").trim();
      if (typed) proposedCategories.set(typed, (proposedCategories.get(typed) ?? 0) + 1);
    }
    if (AWAITING_SUPPLIER_STATUSES.includes(status)) needsFollowUp += 1;

    const assigned = row.assigned_employee_id;
    if (assigned) {
      const stat = reviewerStats.get(assigned) ?? {
        name: employeeName.get(assigned) ?? `#${assigned}`,
        reviewed: 0,
        approved: 0,
        rejected: 0,
        totalMs: 0,
        samples: 0,
      };
      stat.reviewed += 1;
      if (status === REVIEW_STATUS.APPROVED) stat.approved += 1;
      if (status === REVIEW_STATUS.REJECTED) stat.rejected += 1;
      const start = row.submitted_at ?? row.created_at;
      if (DECIDED_STATUSES.includes(status) && row.decided_at && start) {
        const ms = new Date(row.decided_at).getTime() - new Date(start).getTime();
        if (ms >= 0) {
          stat.totalMs += ms;
          stat.samples += 1;
        }
      }
      reviewerStats.set(assigned, stat);
    }
  }

  const toSorted = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

  // Documents that caused a rejection or a follow-up: only answerable when the
  // reviewer actually recorded which document was the problem.
  const docBlame = await pool
    .query<{ name: string; count: string }>(
      `SELECT note AS name, count(*)::text AS count
       FROM supplier_application_events
      WHERE event IN ('info_requested','docs_requested','rejected')
        AND note IS NOT NULL AND btrim(note) <> ''
      GROUP BY note ORDER BY count(*) DESC LIMIT 20`,
    )
    .catch(() => ({ rows: [] as Array<{ name: string; count: string }> }));

  res.json({
    approvedByCategory: toSorted(approvedByCategory),
    rejectionReasons: toSorted(rejectionReasons),
    needsFollowUp,
    proposedCategories: toSorted(proposedCategories),
    reviewers: [...reviewerStats.values()]
      .map((s) => ({
        name: s.name,
        reviewed: s.reviewed,
        approved: s.approved,
        rejected: s.rejected,
        avgReviewDays:
          s.samples > 0 ? Number((s.totalMs / s.samples / 86_400_000).toFixed(2)) : null,
      }))
      .sort((a, b) => b.reviewed - a.reviewed),
    documentIssues: docBlame.rows.map((r) => ({ name: r.name, count: Number(r.count) })),
    provenBrands: { available: false, note: "تُحسب من نتائج التحقق لكل علامة بعد أول مراجعة" },
  });
});

export default router;
