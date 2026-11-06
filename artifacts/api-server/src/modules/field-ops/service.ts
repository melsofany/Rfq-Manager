/**
 * خدمات العمليات الميدانية — shared data access used by the mobile routes.
 *
 * Centralised so a rule is implemented once: whether an employee is a
 * representative, which tasks they may see, and how a notification is written
 * are all decided here, not in each handler.
 */
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  db,
  hrEmployeesTable,
  hrFieldAssignmentsTable,
  hrSettingsTable,
  workOrderAssignmentsTable,
  workOrderDelegationsTable,
  mobileNotificationsTable,
  auditLogTable,
  FIELD_ASSIGNMENT_STATUS,
  WORK_ORDER_KIND,
} from "@workspace/db";

/** The settings row the control page writes. */
export const FIELD_OPS_SETTINGS_KEY = "field_ops_app";

export interface FieldOpsAppSettings {
  appNameAr: string;
  appNameEn: string;
  welcomeMessageAr: string;
  supportPhone: string;
  /** Mobile session lifetime, in days. */
  sessionDays: number;
  autoAssignOnDispatch: boolean;
  notifyOnAssignment: boolean;
  notifyOnDeliveryAvailable: boolean;
  maintenanceMode: boolean;
}

export const FIELD_OPS_DEFAULT_SETTINGS: FieldOpsAppSettings = {
  appNameAr: "قرطبة للتوريدات",
  appNameEn: "Cortoba Supplies",
  welcomeMessageAr: "مرحباً بك في نظام العمليات الميدانية – قرطبة للتوريدات",
  supportPhone: "",
  sessionDays: 30,
  autoAssignOnDispatch: true,
  notifyOnAssignment: true,
  notifyOnDeliveryAvailable: true,
  maintenanceMode: false,
};

/**
 * Coerce arbitrary JSON into valid settings: every field is clamped to its
 * allowed range and unknown/ill-typed values fall back to the default. Pure, so
 * it is the single place both the loader and the settings PUT agree on.
 */
export function normaliseFieldOpsSettings(raw: unknown): FieldOpsAppSettings {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = { ...FIELD_OPS_DEFAULT_SETTINGS };
  if (typeof src.appNameAr === "string" && src.appNameAr.trim())
    out.appNameAr = src.appNameAr.slice(0, 60);
  if (typeof src.appNameEn === "string" && src.appNameEn.trim())
    out.appNameEn = src.appNameEn.slice(0, 60);
  if (typeof src.welcomeMessageAr === "string" && src.welcomeMessageAr.trim())
    out.welcomeMessageAr = src.welcomeMessageAr.slice(0, 300);
  if (typeof src.supportPhone === "string") out.supportPhone = src.supportPhone.slice(0, 30);
  if (typeof src.sessionDays === "number" && Number.isFinite(src.sessionDays)) {
    out.sessionDays = Math.min(365, Math.max(1, Math.round(src.sessionDays)));
  }
  for (const k of [
    "autoAssignOnDispatch",
    "notifyOnAssignment",
    "notifyOnDeliveryAvailable",
    "maintenanceMode",
  ] as const) {
    if (typeof src[k] === "boolean") out[k] = src[k] as boolean;
  }
  return out;
}

/**
 * Read the field-operations app settings, falling back to defaults for any
 * missing or malformed field. A missing row is normal (fresh install), so this
 * never throws — the app must keep working with sane values.
 */
export async function loadFieldOpsSettings(): Promise<FieldOpsAppSettings> {
  // Settings are an overlay on core behaviour, never a dependency of it: a
  // missing table (older deployment) or a malformed row must degrade to the
  // defaults rather than fail the caller — dispatch must not hinge on config.
  try {
    const [row] = await db
      .select()
      .from(hrSettingsTable)
      .where(eq(hrSettingsTable.key, FIELD_OPS_SETTINGS_KEY));
    return normaliseFieldOpsSettings(row?.value);
  } catch {
    return { ...FIELD_OPS_DEFAULT_SETTINGS };
  }
}

/** Does this HR employee hold an ACTIVE field assignment right now? */
export async function hasActiveFieldAssignment(hrEmployeeId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: hrFieldAssignmentsTable.id })
    .from(hrFieldAssignmentsTable)
    .where(
      and(
        eq(hrFieldAssignmentsTable.employeeId, hrEmployeeId),
        eq(hrFieldAssignmentsTable.status, FIELD_ASSIGNMENT_STATUS.ACTIVE),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Active delegations targeting this employee (any task). */
export async function activeDelegationsFor(hrEmployeeId: number) {
  return db
    .select()
    .from(workOrderDelegationsTable)
    .where(
      and(
        eq(workOrderDelegationsTable.toHrEmployeeId, hrEmployeeId),
        eq(workOrderDelegationsTable.status, "active"),
      ),
    );
}

/**
 * Every work-order assignment this employee may act on: the ones they are
 * responsible for, plus the ones temporarily delegated to them. `kind` narrows
 * to the receipt or delivery side.
 */
export async function visibleAssignmentsFor(
  hrEmployeeId: number,
  kind: "receipt" | "delivery",
): Promise<{ assignmentIds: number[]; ownedIds: number[]; delegatedIds: number[] }> {
  const owned = await db
    .select({ id: workOrderAssignmentsTable.id })
    .from(workOrderAssignmentsTable)
    .where(
      and(
        eq(workOrderAssignmentsTable.kind, kind),
        eq(workOrderAssignmentsTable.hrEmployeeId, hrEmployeeId),
      ),
    );

  const delegated = await db
    .select({ id: workOrderAssignmentsTable.id })
    .from(workOrderDelegationsTable)
    .innerJoin(
      workOrderAssignmentsTable,
      eq(workOrderDelegationsTable.assignmentId, workOrderAssignmentsTable.id),
    )
    .where(
      and(
        eq(workOrderDelegationsTable.toHrEmployeeId, hrEmployeeId),
        eq(workOrderDelegationsTable.status, "active"),
        eq(workOrderAssignmentsTable.kind, kind),
      ),
    );

  const ownedIds = owned.map((r) => r.id);
  const delegatedIds = delegated.map((r) => r.id);
  return {
    ownedIds,
    delegatedIds,
    assignmentIds: [...new Set([...ownedIds, ...delegatedIds])],
  };
}

/**
 * Counts for the dashboard. "New" = status sent, "in progress" = anything the
 * rep has started, "completed" = received/delivered.
 */
export async function dashboardCounts(hrEmployeeId: number) {
  const [receipt, delivery] = await Promise.all([
    visibleAssignmentsFor(hrEmployeeId, "receipt"),
    visibleAssignmentsFor(hrEmployeeId, "delivery"),
  ]);

  async function tally(kind: "receipt" | "delivery", ids: number[]) {
    if (!ids.length) return { newCount: 0, inProgress: 0, completed: 0, total: 0 };
    const rows = await db
      .select({ status: workOrderAssignmentsTable.status })
      .from(workOrderAssignmentsTable)
      .where(
        and(
          eq(workOrderAssignmentsTable.kind, kind),
          sql`${workOrderAssignmentsTable.id} = ANY(${sql.raw(`ARRAY[${ids.join(",")}]::int[]`)})`,
        ),
      );
    let newCount = 0;
    let inProgress = 0;
    let completed = 0;
    for (const r of rows) {
      if (r.status === "sent" || r.status === "assigned") newCount++;
      else if (r.status === "received" || r.status === "delivered") completed++;
      else inProgress++;
    }
    return { newCount, inProgress, completed, total: rows.length };
  }

  const receiptCounts = await tally("receipt", receipt.assignmentIds);
  const deliveryCounts = await tally("delivery", delivery.assignmentIds);
  return { receipt: receiptCounts, delivery: deliveryCounts };
}

/** Write an in-app notification. Best-effort: never fails the caller. */
export async function notify(
  hrEmployeeId: number,
  input: {
    kind: string;
    title: string;
    body?: string | null;
    entityType?: string | null;
    entityId?: number | null;
  },
): Promise<void> {
  try {
    await db.insert(mobileNotificationsTable).values({
      hrEmployeeId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
    });
  } catch {
    // Notifications are advisory state — a failed write must never undo work.
  }
}

/** Record an audit entry for a field operation. */
export async function auditFieldOperation(input: {
  action: string;
  entityType: string;
  entityId: number | null;
  /** hr_employees.id of the actual executor. */
  hrEmployeeId: number;
  description: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  await db.insert(auditLogTable).values({
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    // audit_log.employee_id references the procurement login account; the HR
    // employee is captured in the description so the actual executor is always
    // identifiable even when they have no portal account.
    employeeId: null,
    description: `[hr:${input.hrEmployeeId}] ${input.description}`,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
}

/** HR employee row by employee number, for login. */
export async function findHrEmployeeByNo(employeeNo: string) {
  const [row] = await db
    .select()
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.employeeNo, employeeNo.trim()))
    .limit(1);
  return row ?? null;
}

/** Unread notification count for the badge. */
export async function unreadNotificationCount(hrEmployeeId: number): Promise<number> {
  const rows = await db
    .select({ id: mobileNotificationsTable.id })
    .from(mobileNotificationsTable)
    .where(
      and(
        eq(mobileNotificationsTable.hrEmployeeId, hrEmployeeId),
        isNull(mobileNotificationsTable.readAt),
      ),
    );
  return rows.length;
}

export { WORK_ORDER_KIND, or, desc };
