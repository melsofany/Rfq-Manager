/**
 * لوحة التحكم في التطبيق — the operator console for the field-operations app.
 *
 * Everything an administrator needs to run the mobile app without touching the
 * database, mounted on the HR permission surface (`requireAuth + requireHr`):
 *
 *   GET  /hr/field-ops/overview            headline counts + app settings
 *   GET  /hr/field-ops/tasks               every receipt/delivery task
 *   POST /hr/field-ops/tasks/:id/assign    (re)assign a task to a representative
 *   POST /hr/field-ops/tasks/:id/unassign  take a task back to the pool
 *   POST /hr/field-ops/tasks/:id/cancel    cancel a task
 *   GET  /hr/field-ops/settings            app configuration
 *   PUT  /hr/field-ops/settings            replace app configuration
 *
 * Assignment rules mirror the rest of the system: a task can only go to an
 * ACTIVE HR employee who holds an ACTIVE field assignment, so the control page
 * can never hand work to somebody the mobile app would not show it to.
 */
import { Router } from "express";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  auditLogTable,
  hrEmployeesTable,
  hrFieldAssignmentsTable,
  hrSettingsTable,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
  suppliersTable,
  customerPosTable,
  workOrderAssignmentsTable,
  mobileSessionsTable,
  FIELD_ASSIGNMENT_STATUS,
  WORK_ORDER_KIND,
} from "@workspace/db";
import {
  notify,
  loadFieldOpsSettings,
  normaliseFieldOpsSettings,
  FIELD_OPS_DEFAULT_SETTINGS,
  FIELD_OPS_SETTINGS_KEY,
  type FieldOpsAppSettings,
} from "./service";
import { requireAuth } from "../../middlewares/auth";
import { requirePermission } from "../../shared/permissions";

const router = Router();
// The control page is its own permission key, so a manager may hold it without
// the full HR page — but HR access implies it, since HR staff already manage
// employees. `requirePermission` also re-checks the employee is active.
router.use("/hr/field-ops", requireAuth, requirePermission("field-ops", "hr"));

/** A task is "open" while it can still be worked on. */
const OPEN_STATUSES = ["sent", "assigned", "in_progress", "partial", "in_transit"];
/** Terminal states — never reassigned, because Rule 7 forbids rewriting history. */
const CLOSED_STATUSES = ["received", "delivered", "rejected", "cancelled"];

/** Trim a possibly-missing string, returning null when empty. */
function str(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

async function saveSettings(
  next: FieldOpsAppSettings,
  actorId: number | null,
  actor: string | null,
) {
  await db
    .insert(hrSettingsTable)
    .values({ key: FIELD_OPS_SETTINGS_KEY, value: next })
    .onConflictDoUpdate({
      target: hrSettingsTable.key,
      set: { value: next, updatedAt: new Date() },
    });
  await db.insert(auditLogTable).values({
    action: "field_ops.settings_updated",
    entityType: "hr_setting",
    entityId: null,
    employeeId: actorId,
    description: `Field-operations app settings updated by ${actor ?? "—"}`,
  });
}

/** Which HR employees may actually receive tasks: active rep + app access. */
async function eligibleAssigneeIds(): Promise<Set<number>> {
  const rows = await db
    .select({ employeeId: hrFieldAssignmentsTable.employeeId })
    .from(hrFieldAssignmentsTable)
    .innerJoin(hrEmployeesTable, eq(hrFieldAssignmentsTable.employeeId, hrEmployeesTable.id))
    .where(
      and(
        eq(hrFieldAssignmentsTable.status, FIELD_ASSIGNMENT_STATUS.ACTIVE),
        eq(hrEmployeesTable.status, "active"),
      ),
    );
  return new Set(rows.map((r) => r.employeeId));
}

// ── Overview ────────────────────────────────────────────────────────────────

router.get("/hr/field-ops/overview", async (_req, res): Promise<void> => {
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      receipt: sql<number>`count(*) filter (where ${workOrderAssignmentsTable.kind} = 'receipt')::int`,
      delivery: sql<number>`count(*) filter (where ${workOrderAssignmentsTable.kind} = 'delivery')::int`,
      open: sql<number>`count(*) filter (where ${workOrderAssignmentsTable.status} = any(${sql.raw(
        `ARRAY[${OPEN_STATUSES.map((s) => `'${s}'`).join(",")}]::text[]`,
      )}))::int`,
      unassigned: sql<number>`count(*) filter (where ${workOrderAssignmentsTable.hrEmployeeId} is null and ${workOrderAssignmentsTable.status} = any(${sql.raw(
        `ARRAY[${OPEN_STATUSES.map((s) => `'${s}'`).join(",")}]::text[]`,
      )}))::int`,
      completed: sql<number>`count(*) filter (where ${workOrderAssignmentsTable.status} in ('received','delivered'))::int`,
    })
    .from(workOrderAssignmentsTable);

  const reps = await db
    .select({
      id: hrFieldAssignmentsTable.id,
      employeeId: hrFieldAssignmentsTable.employeeId,
      status: hrFieldAssignmentsTable.status,
      mobileAccessEnabled: hrEmployeesTable.mobileAccessEnabled,
      employeeStatus: hrEmployeesTable.status,
    })
    .from(hrFieldAssignmentsTable)
    .innerJoin(hrEmployeesTable, eq(hrFieldAssignmentsTable.employeeId, hrEmployeesTable.id));

  const [openSessions] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mobileSessionsTable)
    .where(
      and(isNull(mobileSessionsTable.revokedAt), sql`${mobileSessionsTable.expiresAt} > now()`),
    );

  res.json({
    tasks: counts ?? { total: 0, receipt: 0, delivery: 0, open: 0, unassigned: 0, completed: 0 },
    representatives: {
      total: reps.length,
      active: reps.filter((r) => r.status === FIELD_ASSIGNMENT_STATUS.ACTIVE).length,
      withAppAccess: reps.filter(
        (r) => r.status === FIELD_ASSIGNMENT_STATUS.ACTIVE && r.mobileAccessEnabled,
      ).length,
      blocked: reps.filter(
        (r) =>
          r.status === FIELD_ASSIGNMENT_STATUS.ACTIVE &&
          (r.employeeStatus !== "active" || !r.mobileAccessEnabled),
      ).length,
    },
    activeSessions: openSessions?.count ?? 0,
    settings: await loadFieldOpsSettings(),
  });
});

// ── Tasks ───────────────────────────────────────────────────────────────────

router.get("/hr/field-ops/tasks", async (req, res): Promise<void> => {
  const kind = String(req.query.kind ?? "");
  const status = String(req.query.status ?? "");
  const unassignedOnly = String(req.query.unassigned ?? "") === "true";
  const assignee = Number(req.query.hrEmployeeId);
  const q = str(req.query.q, 80);

  const filters = [];
  if (kind === WORK_ORDER_KIND.RECEIPT || kind === WORK_ORDER_KIND.DELIVERY) {
    filters.push(eq(workOrderAssignmentsTable.kind, kind));
  }
  if (status === "open") {
    filters.push(inArray(workOrderAssignmentsTable.status, OPEN_STATUSES));
  } else if (status === "closed") {
    filters.push(inArray(workOrderAssignmentsTable.status, CLOSED_STATUSES));
  } else if (status) {
    filters.push(eq(workOrderAssignmentsTable.status, status));
  }
  if (unassignedOnly) filters.push(isNull(workOrderAssignmentsTable.hrEmployeeId));
  if (Number.isInteger(assignee) && assignee > 0) {
    filters.push(eq(workOrderAssignmentsTable.hrEmployeeId, assignee));
  }

  const rows = await db
    .select({
      assignment: workOrderAssignmentsTable,
      po: {
        id: purchaseOrdersTable.id,
        internalPoNo: purchaseOrdersTable.internalPoNo,
        status: purchaseOrdersTable.status,
      },
      customerPo: {
        id: customerPosTable.id,
        internalPoNo: customerPosTable.internalPoNo,
        customerPoNo: customerPosTable.customerPoNo,
        customerName: customerPosTable.customerName,
      },
      assignee: {
        id: hrEmployeesTable.id,
        employeeNo: hrEmployeesTable.employeeNo,
        fullName: hrEmployeesTable.fullName,
      },
      itemDescription: purchaseOrderItemsTable.description,
      itemLine: purchaseOrderItemsTable.lineItem,
      supplierName: suppliersTable.name,
    })
    .from(workOrderAssignmentsTable)
    .leftJoin(purchaseOrdersTable, eq(workOrderAssignmentsTable.poId, purchaseOrdersTable.id))
    .leftJoin(customerPosTable, eq(workOrderAssignmentsTable.customerPoId, customerPosTable.id))
    .leftJoin(hrEmployeesTable, eq(workOrderAssignmentsTable.hrEmployeeId, hrEmployeesTable.id))
    .leftJoin(
      purchaseOrderItemsTable,
      eq(workOrderAssignmentsTable.poItemId, purchaseOrderItemsTable.id),
    )
    .leftJoin(suppliersTable, eq(purchaseOrderItemsTable.supplierId, suppliersTable.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(workOrderAssignmentsTable.createdAt))
    .limit(500);

  const eligible = await eligibleAssigneeIds();
  const needle = q?.toLowerCase() ?? null;

  const tasks = rows
    .map((r) => ({
      id: r.assignment.id,
      kind: r.assignment.kind,
      status: r.assignment.status,
      representativeName: r.assignment.representativeName,
      representativePhone: r.assignment.representativePhone,
      createdAt: r.assignment.createdAt.toISOString(),
      po: r.po?.id ? { id: r.po.id, internalPoNo: r.po.internalPoNo, status: r.po.status } : null,
      customerPo: r.customerPo?.id
        ? {
            id: r.customerPo.id,
            internalPoNo: r.customerPo.internalPoNo,
            customerPoNo: r.customerPo.customerPoNo,
            customerName: r.customerPo.customerName,
          }
        : null,
      item: r.itemDescription ? { lineItem: r.itemLine, description: r.itemDescription } : null,
      supplierName: r.supplierName ?? null,
      assignee: r.assignee?.id
        ? {
            id: r.assignee.id,
            employeeNo: r.assignee.employeeNo,
            fullName: r.assignee.fullName,
            eligible: eligible.has(r.assignee.id),
          }
        : null,
    }))
    .filter((t) => {
      if (!needle) return true;
      const hay = [
        t.po?.internalPoNo,
        t.customerPo?.customerPoNo,
        t.customerPo?.customerName,
        t.supplierName,
        t.assignee?.fullName,
        t.assignee?.employeeNo,
        t.item?.description,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });

  res.json({ tasks, total: tasks.length });
});

/** Load a task and its current open siblings, or reply with an error. */
async function loadTask(id: number, res: import("express").Response) {
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "معرّف المهمة غير صالح" });
    return null;
  }
  const [row] = await db
    .select()
    .from(workOrderAssignmentsTable)
    .where(eq(workOrderAssignmentsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "المهمة غير موجودة" });
    return null;
  }
  return row;
}

/** Validate the target employee is an active representative who can log in. */
async function resolveAssignee(id: unknown, res: import("express").Response) {
  const employeeId = Number(id);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    res.status(400).json({ error: "معرّف الموظف غير صالح" });
    return null;
  }
  const [emp] = await db
    .select({
      id: hrEmployeesTable.id,
      fullName: hrEmployeesTable.fullName,
      employeeNo: hrEmployeesTable.employeeNo,
      status: hrEmployeesTable.status,
      mobileAccessEnabled: hrEmployeesTable.mobileAccessEnabled,
    })
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.id, employeeId));
  if (!emp) {
    res.status(400).json({ error: "الموظف غير موجود في الموارد البشرية" });
    return null;
  }
  if (emp.status !== "active") {
    res.status(400).json({ error: "لا يمكن إسناد مهمة لموظف غير نشط" });
    return null;
  }
  const [assignment] = await db
    .select({ id: hrFieldAssignmentsTable.id })
    .from(hrFieldAssignmentsTable)
    .where(
      and(
        eq(hrFieldAssignmentsTable.employeeId, employeeId),
        eq(hrFieldAssignmentsTable.status, FIELD_ASSIGNMENT_STATUS.ACTIVE),
      ),
    );
  if (!assignment) {
    // The app only shows tasks to an active field representative; assigning to
    // anyone else would create work nobody can see. The operator adds them as a
    // representative first (tab «المندوبين»), which is the audited path.
    res.status(400).json({
      error: "الموظف ليس مندوباً ميدانياً نشطاً — أضِفه من تبويب المندوبين أولاً",
    });
    return null;
  }
  return emp;
}

router.post("/hr/field-ops/tasks/:id/assign", async (req, res): Promise<void> => {
  const task = await loadTask(Number(req.params.id), res);
  if (!task) return;

  const target = await resolveAssignee(req.body?.hrEmployeeId, res);
  if (!target) return;

  if (task.status === "cancelled") {
    res.status(400).json({ error: "لا يمكن إسناد مهمة ملغاة" });
    return;
  }
  if (["received", "delivered", "rejected"].includes(task.status)) {
    res.status(400).json({ error: "لا يمكن تغيير منفّذ مهمة مكتملة — السجل محفوظ" });
    return;
  }

  const reason = str(req.body?.reason);
  // A supplier PO's pickups normally move together, so the whole PO follows the
  // new representative unless the caller asks for a single-task change.
  const cascadePo = req.body?.cascadePo !== false && task.kind === WORK_ORDER_KIND.RECEIPT;

  const moved = await db.transaction(async (tx) => {
    const openFilter = and(
      eq(workOrderAssignmentsTable.poId, task.poId),
      eq(workOrderAssignmentsTable.kind, WORK_ORDER_KIND.RECEIPT),
      inArray(workOrderAssignmentsTable.status, OPEN_STATUSES),
    );

    const updated = await tx
      .update(workOrderAssignmentsTable)
      .set({ hrEmployeeId: target.id, updatedAt: new Date() })
      .where(cascadePo ? openFilter : eq(workOrderAssignmentsTable.id, task.id))
      .returning({ id: workOrderAssignmentsTable.id });

    if (cascadePo) {
      // Keep the PO-level field in step so the portal's PO page agrees with the
      // per-task assignment the app reads.
      await tx
        .update(purchaseOrdersTable)
        .set({ representativeHrEmployeeId: target.id, updatedAt: new Date() })
        .where(eq(purchaseOrdersTable.id, task.poId));
    }

    await tx.insert(auditLogTable).values({
      action: "field_ops.task_assigned",
      entityType: "work_order_assignment",
      entityId: task.id,
      employeeId: req.session.employeeId,
      description: `Task ${task.id} (${task.kind}) assigned to ${target.employeeNo} ${target.fullName}; ${updated.length} task(s) moved${reason ? `; reason: ${reason}` : ""}`,
      ipAddress: req.ip,
    });

    return updated.map((r) => r.id);
  });

  await notify(target.id, {
    kind: "task_assigned",
    title: "تم تكليفك بمهمة ميدانية",
    body: `برجاء مراجعة قائمة ${task.kind === WORK_ORDER_KIND.RECEIPT ? "الاستلامات" : "التسليمات"} في التطبيق`,
    entityType: "assignment",
    entityId: task.id,
  });

  res.json({ success: true, assignedTo: target.id, taskIds: moved });
});

router.post("/hr/field-ops/tasks/:id/unassign", async (req, res): Promise<void> => {
  const task = await loadTask(Number(req.params.id), res);
  if (!task) return;
  if (["received", "delivered", "rejected"].includes(task.status)) {
    res.status(400).json({ error: "لا يمكن إلغاء إسناد مهمة مكتملة" });
    return;
  }
  await db
    .update(workOrderAssignmentsTable)
    .set({ hrEmployeeId: null, updatedAt: new Date() })
    .where(eq(workOrderAssignmentsTable.id, task.id));
  await db.insert(auditLogTable).values({
    action: "field_ops.task_unassigned",
    entityType: "work_order_assignment",
    entityId: task.id,
    employeeId: req.session.employeeId,
    description: `Task ${task.id} returned to the unassigned pool by ${req.session.employeeName ?? "—"}`,
    ipAddress: req.ip,
  });
  res.json({ success: true });
});

router.post("/hr/field-ops/tasks/:id/cancel", async (req, res): Promise<void> => {
  const task = await loadTask(Number(req.params.id), res);
  if (!task) return;
  if (CLOSED_STATUSES.includes(task.status)) {
    res.status(400).json({ error: "المهمة مغلقة بالفعل" });
    return;
  }
  const reason = str(req.body?.reason);
  await db
    .update(workOrderAssignmentsTable)
    .set({ status: "cancelled", rejectionReason: reason, updatedAt: new Date() })
    .where(eq(workOrderAssignmentsTable.id, task.id));
  await db.insert(auditLogTable).values({
    action: "field_ops.task_cancelled",
    entityType: "work_order_assignment",
    entityId: task.id,
    employeeId: req.session.employeeId,
    description: `Task ${task.id} (${task.kind}) cancelled${reason ? `; reason: ${reason}` : ""}`,
    ipAddress: req.ip,
  });
  if (task.hrEmployeeId) {
    await notify(task.hrEmployeeId, {
      kind: "task_cancelled",
      title: "تم إلغاء مهمة ميدانية",
      body: reason ?? "تم إلغاء المهمة من إدارة التطبيق",
      entityType: "assignment",
      entityId: task.id,
    });
  }
  res.json({ success: true });
});

// ── App settings ────────────────────────────────────────────────────────────

router.get("/hr/field-ops/settings", async (_req, res): Promise<void> => {
  res.json({ settings: await loadFieldOpsSettings(), defaults: FIELD_OPS_DEFAULT_SETTINGS });
});

router.put("/hr/field-ops/settings", async (req, res): Promise<void> => {
  const next = normaliseFieldOpsSettings(req.body?.settings ?? req.body);
  await saveSettings(next, req.session.employeeId ?? null, req.session.employeeName ?? null);
  res.json({ success: true, settings: next });
});

export default router;
