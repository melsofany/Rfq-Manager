/**
 * إدارة المندوبين الميدانيين — /api/hr/field-assignments · /api/hr/delegations
 *
 * The official way a person becomes a field representative. Mounted inside the
 * HR module, so the same `hr` permission that guards the HR pages guards this:
 * no separate representative registry, no second source of truth.
 *
 *   GET    /hr/field-assignments                 list (optionally active only)
 *   GET    /hr/field-assignments/candidates      active HR employees + status
 *   POST   /hr/field-assignments                 assign FIELD_REPRESENTATIVE
 *   POST   /hr/field-assignments/:id/revoke      revoke (history preserved)
 *   POST   /hr/field-assignments/:id/mobile-access  grant/revoke app login
 *   POST   /hr/field-assignments/:id/password    set the app password
 *   POST   /hr/delegations                       temporary delegation of a task
 *   POST   /hr/delegations/:id/revoke            end a delegation
 *   GET    /hr/delegations                       list delegations
 *   GET    /hr/assignments/:id/open-tasks        open tasks of a revoked rep
 */
import { Router } from "express";
import bcrypt from "bcryptjs";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  db,
  hrEmployeesTable,
  hrFieldAssignmentsTable,
  workOrderDelegationsTable,
  workOrderAssignmentsTable,
  auditLogTable,
  FIELD_ASSIGNMENT_STATUS,
  FIELD_ASSIGNMENT_TYPE,
} from "@workspace/db";
import { checkFieldAssignmentEligibility } from "../field-ops/assignment-logic";
import { notify } from "../field-ops/service";
import { requireAuth } from "../../middlewares/auth";
import { requirePermission } from "../../shared/permissions";

const router = Router();

// HR administration is behind the same guard as the rest of the HR module, so
// the staff who manage employees are exactly the staff who manage field reps.
// Field-representative administration belongs to the field-ops page; HR staff
// keep access too, since they are the ones who own the employee records.
const guard = [requireAuth, requirePermission("field-ops", "hr")];
router.use("/hr/field-assignments", ...guard);
router.use("/hr/delegations", ...guard);
router.use("/hr/assignments", ...guard);

function str(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** The actor (portal employee) from the HR session, for accountability. */
function actorName(req: { session?: { employeeName?: string } }): string | null {
  return req.session?.employeeName ?? null;
}

router.get("/hr/field-assignments", async (req, res): Promise<void> => {
  const activeOnly = String(req.query.active ?? "") === "true";
  const rows = await db
    .select({
      assignment: hrFieldAssignmentsTable,
      employeeNo: hrEmployeesTable.employeeNo,
      fullName: hrEmployeesTable.fullName,
      jobTitle: hrEmployeesTable.jobTitle,
      department: hrEmployeesTable.department,
      phone: hrEmployeesTable.phone,
      employeeStatus: hrEmployeesTable.status,
      mobileAccessEnabled: hrEmployeesTable.mobileAccessEnabled,
      hasPassword: hrEmployeesTable.mobilePasswordHash,
    })
    .from(hrFieldAssignmentsTable)
    .innerJoin(hrEmployeesTable, eq(hrFieldAssignmentsTable.employeeId, hrEmployeesTable.id))
    .where(
      activeOnly ? eq(hrFieldAssignmentsTable.status, FIELD_ASSIGNMENT_STATUS.ACTIVE) : undefined,
    )
    .orderBy(desc(hrFieldAssignmentsTable.assignedAt));

  res.json(
    rows.map((r) => ({
      id: r.assignment.id,
      employeeId: r.assignment.employeeId,
      employeeNo: r.employeeNo,
      fullName: r.fullName,
      jobTitle: r.jobTitle,
      department: r.department,
      phone: r.phone,
      employeeStatus: r.employeeStatus,
      assignmentType: r.assignment.assignmentType,
      status: r.assignment.status,
      assignedAt: r.assignment.assignedAt.toISOString(),
      assignedByName: r.assignment.assignedByName,
      revokedAt: r.assignment.revokedAt ? r.assignment.revokedAt.toISOString() : null,
      revokeReason: r.assignment.revokeReason,
      notes: r.assignment.notes,
      mobileAccessEnabled: r.mobileAccessEnabled,
      hasPassword: r.hasPassword != null,
    })),
  );
});

/** Active HR employees that may be assigned, with their current assignment. */
router.get("/hr/field-assignments/candidates", async (_req, res): Promise<void> => {
  const employees = await db
    .select({
      id: hrEmployeesTable.id,
      employeeNo: hrEmployeesTable.employeeNo,
      fullName: hrEmployeesTable.fullName,
      jobTitle: hrEmployeesTable.jobTitle,
      department: hrEmployeesTable.department,
      phone: hrEmployeesTable.phone,
      status: hrEmployeesTable.status,
      mobileAccessEnabled: hrEmployeesTable.mobileAccessEnabled,
    })
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.status, "active"))
    .orderBy(hrEmployeesTable.employeeNo);

  const activeAssignments = await db
    .select({ employeeId: hrFieldAssignmentsTable.employeeId })
    .from(hrFieldAssignmentsTable)
    .where(eq(hrFieldAssignmentsTable.status, FIELD_ASSIGNMENT_STATUS.ACTIVE));
  const assignedSet = new Set(activeAssignments.map((a) => a.employeeId));

  res.json(
    employees.map((e) => ({
      ...e,
      isFieldRepresentative: assignedSet.has(e.id),
    })),
  );
});

router.post("/hr/field-assignments", async (req, res): Promise<void> => {
  const employeeId = Number(req.body?.employeeId);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    res.status(400).json({ error: "معرّف الموظف غير صالح" });
    return;
  }
  const [employee] = await db
    .select()
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.id, employeeId));
  const [existing] = await db
    .select({ id: hrFieldAssignmentsTable.id })
    .from(hrFieldAssignmentsTable)
    .where(
      and(
        eq(hrFieldAssignmentsTable.employeeId, employeeId),
        eq(hrFieldAssignmentsTable.status, FIELD_ASSIGNMENT_STATUS.ACTIVE),
      ),
    );

  const check = checkFieldAssignmentEligibility({
    employee: employee ? { status: employee.status } : null,
    alreadyAssigned: Boolean(existing),
  });
  if (!check.ok) {
    res.status(check.status).json({ error: check.error });
    return;
  }

  const [row] = await db
    .insert(hrFieldAssignmentsTable)
    .values({
      employeeId,
      assignmentType: FIELD_ASSIGNMENT_TYPE.FIELD_REPRESENTATIVE,
      status: FIELD_ASSIGNMENT_STATUS.ACTIVE,
      assignedBy: req.session?.employeeId ?? null,
      assignedByName: actorName(req),
      notes: str(req.body?.notes),
    })
    .returning();

  // Assigning a field representative enables their app access and sets an
  // initial password, so the assignment is usable immediately.
  const initialPassword = str(req.body?.password, 100);
  await db
    .update(hrEmployeesTable)
    .set({
      mobileAccessEnabled: true,
      ...(initialPassword ? { mobilePasswordHash: await bcrypt.hash(initialPassword, 10) } : {}),
    })
    .where(eq(hrEmployeesTable.id, employeeId));

  await db.insert(auditLogTable).values({
    action: "hr.field_assignment_created",
    entityType: "hr_employee",
    entityId: employeeId,
    employeeId: req.session?.employeeId ?? null,
    description: `Field representative assigned: ${employee!.employeeNo} ${employee!.fullName}`,
    ipAddress: req.ip,
  });

  await notify(employeeId, {
    kind: "task_assigned",
    title: "تم تفعيل حسابك في تطبيق العمليات الميدانية",
    body: "يمكنك الآن تسجيل الدخول بالرقم الوظيفي",
    entityType: "profile",
    entityId: employeeId,
  });

  res.status(201).json({
    id: row.id,
    employeeId: row.employeeId,
    status: row.status,
    assignedAt: row.assignedAt.toISOString(),
    passwordSet: Boolean(initialPassword),
  });
});

router.post("/hr/field-assignments/:id/revoke", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const [row] = await db
    .select()
    .from(hrFieldAssignmentsTable)
    .where(eq(hrFieldAssignmentsTable.id, id));
  if (!row || row.status !== FIELD_ASSIGNMENT_STATUS.ACTIVE) {
    res.status(404).json({ error: "التعيين غير موجود أو ملغي بالفعل" });
    return;
  }
  const reason = str(req.body?.reason);

  await db
    .update(hrFieldAssignmentsTable)
    .set({
      status: FIELD_ASSIGNMENT_STATUS.REVOKED,
      revokedBy: req.session?.employeeId ?? null,
      revokedByName: actorName(req),
      revokedAt: new Date(),
      revokeReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(hrFieldAssignmentsTable.id, id));

  // Revoking the representative ends their app access. Historical tasks and
  // operations are untouched — only future work stops.
  await db
    .update(hrEmployeesTable)
    .set({ mobileAccessEnabled: false })
    .where(eq(hrEmployeesTable.id, row.employeeId));

  // Open tasks are surfaced to the operator rather than silently lost.
  const openTasks = await db
    .select({
      id: workOrderAssignmentsTable.id,
      kind: workOrderAssignmentsTable.kind,
      poId: workOrderAssignmentsTable.poId,
      status: workOrderAssignmentsTable.status,
    })
    .from(workOrderAssignmentsTable)
    .where(
      and(
        eq(workOrderAssignmentsTable.hrEmployeeId, row.employeeId),
        ne(workOrderAssignmentsTable.status, "received"),
        ne(workOrderAssignmentsTable.status, "delivered"),
        ne(workOrderAssignmentsTable.status, "rejected"),
      ),
    );

  await db.insert(auditLogTable).values({
    action: "hr.field_assignment_revoked",
    entityType: "hr_employee",
    entityId: row.employeeId,
    employeeId: req.session?.employeeId ?? null,
    description: `Field assignment revoked (id ${id}); ${openTasks.length} open task(s) need reassignment. Reason: ${reason ?? "—"}`,
    ipAddress: req.ip,
  });

  res.json({ success: true, openTasks });
});

/** Grant or revoke app login without touching the HR record. */
router.post("/hr/field-assignments/:id/mobile-access", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const enabled = req.body?.enabled === true;
  const [row] = await db
    .select()
    .from(hrFieldAssignmentsTable)
    .where(eq(hrFieldAssignmentsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "التعيين غير موجود" });
    return;
  }
  await db
    .update(hrEmployeesTable)
    .set({ mobileAccessEnabled: enabled })
    .where(eq(hrEmployeesTable.id, row.employeeId));
  await db.insert(auditLogTable).values({
    action: enabled ? "hr.mobile_access_enabled" : "hr.mobile_access_disabled",
    entityType: "hr_employee",
    entityId: row.employeeId,
    employeeId: req.session?.employeeId ?? null,
    description: `Mobile access ${enabled ? "enabled" : "disabled"} for HR employee ${row.employeeId}`,
    ipAddress: req.ip,
  });
  res.json({ success: true, mobileAccessEnabled: enabled });
});

/** Set (or reset) the app password for the assigned employee. */
router.post("/hr/field-assignments/:id/password", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const password = str(req.body?.password, 100);
  if (!password || password.length < 6) {
    res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" });
    return;
  }
  const [row] = await db
    .select()
    .from(hrFieldAssignmentsTable)
    .where(eq(hrFieldAssignmentsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "التعيين غير موجود" });
    return;
  }
  await db
    .update(hrEmployeesTable)
    .set({ mobilePasswordHash: await bcrypt.hash(password, 10), mobileAccessEnabled: true })
    .where(eq(hrEmployeesTable.id, row.employeeId));
  await db.insert(auditLogTable).values({
    action: "hr.mobile_password_set",
    entityType: "hr_employee",
    entityId: row.employeeId,
    employeeId: req.session?.employeeId ?? null,
    description: `Mobile password set for HR employee ${row.employeeId}`,
    ipAddress: req.ip,
  });
  res.json({ success: true });
});

// ── Delegations ─────────────────────────────────────────────────────────────

router.get("/hr/delegations", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(workOrderDelegationsTable)
    .orderBy(desc(workOrderDelegationsTable.createdAt))
    .limit(200);
  res.json(
    rows.map((d) => ({
      ...d,
      startsAt: d.startsAt.toISOString(),
      endsAt: d.endsAt ? d.endsAt.toISOString() : null,
      createdAt: d.createdAt.toISOString(),
      revokedAt: d.revokedAt ? d.revokedAt.toISOString() : null,
    })),
  );
});

router.post("/hr/delegations", async (req, res): Promise<void> => {
  const assignmentId = Number(req.body?.assignmentId);
  const toHrEmployeeId = Number(req.body?.toHrEmployeeId);
  const scope = String(req.body?.scope ?? "both");
  if (!Number.isInteger(assignmentId) || !Number.isInteger(toHrEmployeeId)) {
    res.status(400).json({ error: "بيانات التكليف غير مكتملة" });
    return;
  }
  if (!["receipt", "delivery", "both"].includes(scope)) {
    res.status(400).json({ error: "نطاق التكليف غير صالح" });
    return;
  }

  const [assignment] = await db
    .select()
    .from(workOrderAssignmentsTable)
    .where(eq(workOrderAssignmentsTable.id, assignmentId));
  if (!assignment) {
    res.status(404).json({ error: "المهمة غير موجودة" });
    return;
  }
  const [toEmployee] = await db
    .select()
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.id, toHrEmployeeId));
  if (!toEmployee || toEmployee.status !== "active") {
    res.status(400).json({ error: "الموظف المكلف غير نشط أو غير موجود" });
    return;
  }

  const endsAtRaw = str(req.body?.endsAt, 40);
  const endsAt = endsAtRaw ? new Date(endsAtRaw) : null;
  if (endsAt && isNaN(endsAt.getTime())) {
    res.status(400).json({ error: "تاريخ الانتهاء غير صالح" });
    return;
  }

  const [row] = await db
    .insert(workOrderDelegationsTable)
    .values({
      assignmentId,
      fromHrEmployeeId: assignment.hrEmployeeId ?? null,
      toHrEmployeeId,
      scope,
      issuedBy: req.session?.employeeId ?? null,
      issuedByName: actorName(req),
      reason: str(req.body?.reason),
      endsAt,
    })
    .returning();

  await db.insert(auditLogTable).values({
    action: "hr.delegation_created",
    entityType: "work_order_assignment",
    entityId: assignmentId,
    employeeId: req.session?.employeeId ?? null,
    description: `Task ${assignmentId} delegated to HR employee ${toHrEmployeeId} (scope ${scope}) by ${actorName(req) ?? "—"}. Reason: ${str(req.body?.reason) ?? "—"}`,
    ipAddress: req.ip,
  });

  await notify(toHrEmployeeId, {
    kind: "task_assigned",
    title: "تم تكليفك بمهمة ميدانية",
    body: "برجاء مراجعة قائمة المهام في التطبيق",
    entityType: "assignment",
    entityId: assignmentId,
  });

  res.status(201).json({ ...row, startsAt: row.startsAt.toISOString() });
});

router.post("/hr/delegations/:id/revoke", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [row] = await db
    .select()
    .from(workOrderDelegationsTable)
    .where(eq(workOrderDelegationsTable.id, id));
  if (!row || row.status !== "active") {
    res.status(404).json({ error: "التكليف غير موجود أو منتهي" });
    return;
  }
  await db
    .update(workOrderDelegationsTable)
    .set({
      status: "revoked",
      revokedBy: req.session?.employeeId ?? null,
      revokedAt: new Date(),
    })
    .where(eq(workOrderDelegationsTable.id, id));
  await db.insert(auditLogTable).values({
    action: "hr.delegation_revoked",
    entityType: "work_order_assignment",
    entityId: row.assignmentId,
    employeeId: req.session?.employeeId ?? null,
    description: `Delegation ${id} revoked`,
    ipAddress: req.ip,
  });
  res.json({ success: true });
});

/** Open tasks for a (usually revoked) representative, so they can be reassigned. */
router.get("/hr/assignments/open-tasks", async (req, res): Promise<void> => {
  const hrEmployeeId = Number(req.query.hrEmployeeId);
  if (!Number.isInteger(hrEmployeeId)) {
    res.status(400).json({ error: "معرّف الموظف غير صالح" });
    return;
  }
  const rows = await db
    .select()
    .from(workOrderAssignmentsTable)
    .where(
      and(
        eq(workOrderAssignmentsTable.hrEmployeeId, hrEmployeeId),
        inArray(workOrderAssignmentsTable.status, ["sent", "assigned", "in_progress"]),
        isNull(workOrderAssignmentsTable.performedByHrEmployeeId),
      ),
    );
  res.json(rows);
});

export default router;
