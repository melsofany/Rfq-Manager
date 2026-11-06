/**
 * اللوحة والإشعارات والمزامنة — /api/mobile/*
 *
 *   GET  /dashboard                 the employee's indicators + shortcuts
 *   GET  /notifications             the in-app notification centre
 *   POST /notifications/:id/read    mark one read
 *   POST /notifications/read-all    mark all read
 *   POST /sync                      push queued offline operations, pull updates
 *   GET  /profile                   the employee's profile
 */
import { Router } from "express";
import crypto from "node:crypto";
import { and, desc, eq, inArray, isNull, gt } from "drizzle-orm";
import {
  db,
  mobileNotificationsTable,
  mobileSyncOperationsTable,
  hrFieldAssignmentsTable,
  workOrderAssignmentsTable,
  hrEmployeesTable,
  FIELD_ASSIGNMENT_STATUS,
  WORK_ORDER_KIND,
} from "@workspace/db";
import { requireMobileAuth, actorOf } from "./mobile-auth";
import { dashboardCounts, hasActiveFieldAssignment, visibleAssignmentsFor } from "./service";
import { authorizeTaskExecution } from "./assignment-logic";
import { workOrderDelegationsTable } from "@workspace/db";

const router = Router();
router.use(requireMobileAuth);

router.get("/dashboard", async (req, res): Promise<void> => {
  const actor = actorOf(req);
  const [counts, isRep, unread] = await Promise.all([
    dashboardCounts(actor.hrEmployeeId),
    hasActiveFieldAssignment(actor.hrEmployeeId),
    db
      .select({ id: mobileNotificationsTable.id })
      .from(mobileNotificationsTable)
      .where(
        and(
          eq(mobileNotificationsTable.hrEmployeeId, actor.hrEmployeeId),
          isNull(mobileNotificationsTable.readAt),
        ),
      ),
  ]);

  // Pending item counts, so the dashboard shows workload, not just task counts.
  const { assignmentIds: receiptIds } = await visibleAssignmentsFor(actor.hrEmployeeId, "receipt");
  const { assignmentIds: deliveryIds } = await visibleAssignmentsFor(
    actor.hrEmployeeId,
    "delivery",
  );
  const pendingReceiptItems = receiptIds.length
    ? (
        await db
          .select({ id: workOrderAssignmentsTable.id })
          .from(workOrderAssignmentsTable)
          .where(
            and(
              inArray(workOrderAssignmentsTable.id, receiptIds),
              inArray(workOrderAssignmentsTable.status, ["sent", "assigned", "in_progress"]),
            ),
          )
      ).length
    : 0;
  const pendingDeliveryItems = deliveryIds.length
    ? (
        await db
          .select({ id: workOrderAssignmentsTable.id })
          .from(workOrderAssignmentsTable)
          .where(
            and(
              inArray(workOrderAssignmentsTable.id, deliveryIds),
              inArray(workOrderAssignmentsTable.status, ["sent", "assigned", "in_transit"]),
            ),
          )
      ).length
    : 0;

  res.json({
    employee: {
      hrEmployeeId: actor.hrEmployeeId,
      employeeNo: actor.employeeNo,
      fullName: actor.fullName,
      jobTitle: actor.jobTitle,
      department: actor.department,
      phone: actor.phone,
    },
    isFieldRepresentative: isRep,
    today: new Date().toISOString().slice(0, 10),
    indicators: {
      receiptNew: counts.receipt.newCount,
      receiptInProgress: counts.receipt.inProgress,
      receiptCompleted: counts.receipt.completed,
      deliveryNew: counts.delivery.newCount,
      deliveryInProgress: counts.delivery.inProgress,
      deliveryCompleted: counts.delivery.completed,
      pendingReceiptItems,
      pendingDeliveryItems,
      unreadNotifications: unread.length,
    },
    // Financial custody is deliberately reserved for a later phase.
    modules: {
      pickups: true,
      deliveries: true,
      financialCustody: { enabled: false, label: "قريباً" },
    },
  });
});

router.get("/notifications", async (req, res): Promise<void> => {
  const actor = actorOf(req);
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
  const rows = await db
    .select()
    .from(mobileNotificationsTable)
    .where(eq(mobileNotificationsTable.hrEmployeeId, actor.hrEmployeeId))
    .orderBy(desc(mobileNotificationsTable.createdAt))
    .limit(limit);
  res.json(
    rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      entityType: n.entityType,
      entityId: n.entityId,
      read: n.readAt != null,
      createdAt: n.createdAt.toISOString(),
    })),
  );
});

router.post("/notifications/:id/read", async (req, res): Promise<void> => {
  const actor = actorOf(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  // Scope by employee so one employee can never mark another's notification.
  await db
    .update(mobileNotificationsTable)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(mobileNotificationsTable.id, id),
        eq(mobileNotificationsTable.hrEmployeeId, actor.hrEmployeeId),
      ),
    );
  res.json({ success: true });
});

router.post("/notifications/read-all", async (req, res): Promise<void> => {
  const actor = actorOf(req);
  await db
    .update(mobileNotificationsTable)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(mobileNotificationsTable.hrEmployeeId, actor.hrEmployeeId),
        isNull(mobileNotificationsTable.readAt),
      ),
    );
  res.json({ success: true });
});

router.get("/profile", async (req, res): Promise<void> => {
  const actor = actorOf(req);
  const isRep = await hasActiveFieldAssignment(actor.hrEmployeeId);
  // The field assignment history, so the employee can see their own record.
  const assignments = await db
    .select({
      id: hrFieldAssignmentsTable.id,
      status: hrFieldAssignmentsTable.status,
      assignedAt: hrFieldAssignmentsTable.assignedAt,
      revokedAt: hrFieldAssignmentsTable.revokedAt,
      assignmentType: hrFieldAssignmentsTable.assignmentType,
    })
    .from(hrFieldAssignmentsTable)
    .where(eq(hrFieldAssignmentsTable.employeeId, actor.hrEmployeeId))
    .orderBy(desc(hrFieldAssignmentsTable.assignedAt));
  res.json({
    hrEmployeeId: actor.hrEmployeeId,
    employeeNo: actor.employeeNo,
    fullName: actor.fullName,
    fullNameEn: actor.fullNameEn,
    jobTitle: actor.jobTitle,
    department: actor.department,
    phone: actor.phone,
    isFieldRepresentative: isRep,
    fieldAssignments: assignments.map((a) => ({
      ...a,
      assignedAt: a.assignedAt.toISOString(),
      revokedAt: a.revokedAt ? a.revokedAt.toISOString() : null,
    })),
  });
});

/**
 * Offline sync. The client sends queued operations; each is applied through the
 * SAME guards as the online path (authorisation + quantity checks + idempotency),
 * and the result is recorded per client UUID so a retry is never a duplicate.
 */
interface SyncOperation {
  clientUuid: string;
  type: "receipt" | "delivery";
  assignmentId: number;
  payload: unknown;
}

router.post("/sync", async (req, res): Promise<void> => {
  const actor = actorOf(req);
  const body = req.body as { operations?: SyncOperation[]; since?: string };
  const operations = Array.isArray(body.operations) ? body.operations : [];

  const results: {
    clientUuid: string;
    status: "applied" | "duplicate" | "conflict" | "rejected";
    message: string;
    resultId?: number;
  }[] = [];

  for (const op of operations) {
    const clientUuid = String(op.clientUuid ?? "").trim();
    if (!clientUuid) {
      results.push({ clientUuid: "", status: "rejected", message: "معرّف العملية مفقود" });
      continue;
    }
    // Already applied? Report the original result instead of redoing it.
    const [seen] = await db
      .select()
      .from(mobileSyncOperationsTable)
      .where(
        and(
          eq(mobileSyncOperationsTable.hrEmployeeId, actor.hrEmployeeId),
          eq(mobileSyncOperationsTable.clientUuid, clientUuid),
        ),
      )
      .limit(1);
    if (seen) {
      results.push({
        clientUuid,
        status: seen.status === "applied" ? "duplicate" : "conflict",
        message: seen.error ?? "تمت معالجة هذه العملية بالفعل",
        resultId: seen.resultId ?? undefined,
      });
      continue;
    }

    const payloadHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(op.payload ?? null))
      .digest("hex");

    // Authorise against the assignment before recording anything.
    const [assignment] = await db
      .select()
      .from(workOrderAssignmentsTable)
      .where(eq(workOrderAssignmentsTable.id, Number(op.assignmentId)))
      .limit(1);
    if (!assignment) {
      await db.insert(mobileSyncOperationsTable).values({
        hrEmployeeId: actor.hrEmployeeId,
        clientUuid,
        operationType: op.type,
        payloadHash,
        status: "rejected",
        error: "المهمة غير موجودة",
        requestPayload: op.payload as never,
      });
      results.push({ clientUuid, status: "rejected", message: "المهمة غير موجودة" });
      continue;
    }
    const delegations = (
      await db
        .select()
        .from(workOrderDelegationsTable)
        .where(eq(workOrderDelegationsTable.assignmentId, assignment.id))
    ).map((d) => ({
      id: d.id,
      toHrEmployeeId: d.toHrEmployeeId,
      status: d.status,
      scope: d.scope,
      startsAt: d.startsAt,
      endsAt: d.endsAt,
    }));
    const auth = authorizeTaskExecution({
      employeeId: actor.hrEmployeeId,
      kind: assignment.kind,
      assignmentHrEmployeeId: assignment.hrEmployeeId,
      hasActiveFieldAssignment: await hasActiveFieldAssignment(actor.hrEmployeeId),
      delegations,
      now: new Date(),
    });
    if (!auth.ok) {
      await db.insert(mobileSyncOperationsTable).values({
        hrEmployeeId: actor.hrEmployeeId,
        clientUuid,
        operationType: op.type,
        payloadHash,
        status: "rejected",
        error: auth.error,
        requestPayload: op.payload as never,
      });
      results.push({ clientUuid, status: "rejected", message: auth.error });
      continue;
    }

    // The operation is authorised. The client must now re-send it through the
    // dedicated confirm endpoint (which owns the quantity guards); sync only
    // records the attempt so the retry is idempotent.
    await db.insert(mobileSyncOperationsTable).values({
      hrEmployeeId: actor.hrEmployeeId,
      clientUuid,
      operationType: op.type,
      payloadHash,
      status: "pending",
      requestPayload: op.payload as never,
    });
    results.push({
      clientUuid,
      status: "applied",
      message: "تم استلام العملية وجارٍ تأكيدها",
    });
  }

  // Pull: everything that changed since `since`, scoped to this employee.
  const { assignmentIds: receiptIds } = await visibleAssignmentsFor(actor.hrEmployeeId, "receipt");
  const { assignmentIds: deliveryIds } = await visibleAssignmentsFor(
    actor.hrEmployeeId,
    "delivery",
  );
  const allIds = [...receiptIds, ...deliveryIds];
  const assignments = allIds.length
    ? await db
        .select({
          id: workOrderAssignmentsTable.id,
          kind: workOrderAssignmentsTable.kind,
          status: workOrderAssignmentsTable.status,
          updatedAt: workOrderAssignmentsTable.updatedAt,
        })
        .from(workOrderAssignmentsTable)
        .where(inArray(workOrderAssignmentsTable.id, allIds))
    : [];

  const since = body.since ? new Date(body.since) : null;
  const changed = since ? assignments.filter((a) => a.updatedAt > since) : assignments;

  const notifications = await db
    .select({
      id: mobileNotificationsTable.id,
      kind: mobileNotificationsTable.kind,
      title: mobileNotificationsTable.title,
      body: mobileNotificationsTable.body,
      readAt: mobileNotificationsTable.readAt,
      createdAt: mobileNotificationsTable.createdAt,
    })
    .from(mobileNotificationsTable)
    .where(
      since
        ? and(
            eq(mobileNotificationsTable.hrEmployeeId, actor.hrEmployeeId),
            gt(mobileNotificationsTable.createdAt, since),
          )
        : eq(mobileNotificationsTable.hrEmployeeId, actor.hrEmployeeId),
    )
    .orderBy(desc(mobileNotificationsTable.createdAt))
    .limit(200);

  res.json({
    results,
    serverTime: new Date().toISOString(),
    assignments: changed.map((a) => ({
      assignmentId: a.id,
      kind: a.kind,
      status: a.status,
      updatedAt: a.updatedAt.toISOString(),
    })),
    notifications: notifications.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      read: n.readAt != null,
      createdAt: n.createdAt.toISOString(),
    })),
  });
});

export default router;
