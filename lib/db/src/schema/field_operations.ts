import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  boolean,
  numeric,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hrEmployeesTable } from "./hr";
import { employeesTable } from "./employees";
import { workOrderAssignmentsTable } from "./work_order_assignments";

/**
 * تعيين المندوب الميداني — the single official source of "who may run field
 * operations". A representative is an HR employee with an ACTIVE row here; no
 * separate representative registry exists (the legacy `representatives` table
 * stays as the WhatsApp phone directory only).
 *
 * Revoking never deletes: the row flips to `revoked` and keeps its actor and
 * timestamps, so assignment history survives an employee leaving.
 */
export const FIELD_ASSIGNMENT_TYPE = {
  FIELD_REPRESENTATIVE: "FIELD_REPRESENTATIVE",
} as const;
export type FieldAssignmentType =
  (typeof FIELD_ASSIGNMENT_TYPE)[keyof typeof FIELD_ASSIGNMENT_TYPE];

export const FIELD_ASSIGNMENT_STATUS = {
  ACTIVE: "active",
  REVOKED: "revoked",
} as const;
export type FieldAssignmentStatus =
  (typeof FIELD_ASSIGNMENT_STATUS)[keyof typeof FIELD_ASSIGNMENT_STATUS];

export const hrFieldAssignmentsTable = pgTable(
  "hr_field_assignments",
  {
    id: serial("id").primaryKey(),
    /** hr_employees.id */
    employeeId: integer("employee_id")
      .notNull()
      .references(() => hrEmployeesTable.id, { onDelete: "cascade" }),
    assignmentType: text("assignment_type")
      .notNull()
      .default(FIELD_ASSIGNMENT_TYPE.FIELD_REPRESENTATIVE),
    // active | revoked
    status: text("status").notNull().default(FIELD_ASSIGNMENT_STATUS.ACTIVE),
    /** Procurement login account (employees.id) that granted the assignment. */
    assignedBy: integer("assigned_by").references(() => employeesTable.id, {
      onDelete: "set null",
    }),
    assignedByName: text("assigned_by_name"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    revokedBy: integer("revoked_by").references(() => employeesTable.id, { onDelete: "set null" }),
    revokedByName: text("revoked_by_name"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: text("revoke_reason"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("hr_field_assignments_employee_idx").on(t.employeeId),
    // At most ONE active assignment per employee — enforced by the database so
    // no write path can create a second active row for the same person.
    uniqueIndex("hr_field_assignments_one_active_uq")
      .on(t.employeeId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export type HrFieldAssignment = typeof hrFieldAssignmentsTable.$inferSelect;

/**
 * التكليف المؤقت — a temporary, scoped, time-bounded delegation of ONE field
 * task to another HR employee (typically a purchasing employee covering for an
 * unavailable representative). The original representative on the assignment is
 * never overwritten; the actual executor is recorded separately.
 */
export const DELEGATION_SCOPE = {
  RECEIPT: "receipt",
  DELIVERY: "delivery",
  BOTH: "both",
} as const;
export type DelegationScope = (typeof DELEGATION_SCOPE)[keyof typeof DELEGATION_SCOPE];

export const workOrderDelegationsTable = pgTable(
  "work_order_delegations",
  {
    id: serial("id").primaryKey(),
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => workOrderAssignmentsTable.id, { onDelete: "cascade" }),
    /** The HR employee the task was originally assigned to (may be null for legacy rows). */
    fromHrEmployeeId: integer("from_hr_employee_id").references(() => hrEmployeesTable.id, {
      onDelete: "set null",
    }),
    /** The HR employee temporarily covering the task. */
    toHrEmployeeId: integer("to_hr_employee_id")
      .notNull()
      .references(() => hrEmployeesTable.id, { onDelete: "cascade" }),
    // receipt | delivery | both
    scope: text("scope").notNull().default(DELEGATION_SCOPE.BOTH),
    /** Procurement login account (employees.id) that issued the delegation. */
    issuedBy: integer("issued_by").references(() => employeesTable.id, { onDelete: "set null" }),
    issuedByName: text("issued_by_name"),
    reason: text("reason"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    // active | revoked | expired
    status: text("status").notNull().default("active"),
    revokedBy: integer("revoked_by").references(() => employeesTable.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("work_order_delegations_assignment_idx").on(t.assignmentId),
    index("work_order_delegations_to_employee_idx").on(t.toHrEmployeeId),
  ],
);

export type WorkOrderDelegation = typeof workOrderDelegationsTable.$inferSelect;

/**
 * إشعارات التطبيق — the in-app notification centre. Built so Firebase Cloud
 * Messaging can be layered on later: `fcmMessageId` records the FCM id once
 * push is enabled, and the row is the source of truth the app reads regardless.
 */
export const mobileNotificationsTable = pgTable(
  "mobile_notifications",
  {
    id: serial("id").primaryKey(),
    /** Recipient HR employee. */
    hrEmployeeId: integer("hr_employee_id")
      .notNull()
      .references(() => hrEmployeesTable.id, { onDelete: "cascade" }),
    // task_assigned | task_reassigned | task_cancelled | task_due_changed |
    // partial_receipt | receipt_complete | delivery_available | task_overdue |
    // approval_request
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    // Deep-link target so tapping the notification opens the exact task.
    entityType: text("entity_type"),
    entityId: integer("entity_id"),
    readAt: timestamp("read_at", { withTimezone: true }),
    fcmMessageId: text("fcm_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mobile_notifications_employee_idx").on(t.hrEmployeeId, t.createdAt),
    index("mobile_notifications_unread_idx")
      .on(t.hrEmployeeId)
      .where(sql`${t.readAt} IS NULL`),
  ],
);

export type MobileNotification = typeof mobileNotificationsTable.$inferSelect;

/**
 * مرفقات العمليات الميدانية — photographs and recipient signatures attached to
 * a receipt or a delivery. Content is stored base64 (the same pattern as
 * `rfq_attachments`), which keeps the mobile flow dependency-free.
 */
export const mobileAttachmentsTable = pgTable(
  "mobile_attachments",
  {
    id: serial("id").primaryKey(),
    // receipt | delivery
    operationType: text("operation_type").notNull(),
    /** po_item_receipts.id or customer_po_item_deliveries.id */
    operationId: integer("operation_id").notNull(),
    // photo | signature | invoice | delivery_note
    kind: text("kind").notNull().default("photo"),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    /** base64-encoded content. */
    content: text("content").notNull(),
    /** HR employee that uploaded the attachment. */
    uploadedByHrEmployeeId: integer("uploaded_by_hr_employee_id").references(
      () => hrEmployeesTable.id,
      { onDelete: "set null" },
    ),
    /** Client-side UUID so an offline upload is never duplicated on retry. */
    clientId: text("client_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mobile_attachments_operation_idx").on(t.operationType, t.operationId),
    uniqueIndex("mobile_attachments_client_uq")
      .on(t.clientId)
      .where(sql`${t.clientId} IS NOT NULL`),
  ],
);

export type MobileAttachment = typeof mobileAttachmentsTable.$inferSelect;

/**
 * طابور المزامنة — server-side record of a client operation submitted for
 * sync. The unique (employee, client uuid) pair makes a retried offline
 * submission a no-op instead of a duplicate.
 */
export const mobileSyncOperationsTable = pgTable(
  "mobile_sync_operations",
  {
    id: serial("id").primaryKey(),
    hrEmployeeId: integer("hr_employee_id")
      .notNull()
      .references(() => hrEmployeesTable.id, { onDelete: "cascade" }),
    /** Client-generated UUID identifying the operation. */
    clientUuid: text("client_uuid").notNull(),
    // receipt | delivery
    operationType: text("operation_type").notNull(),
    /** Fingerprint of the payload so a changed retry is rejected, not merged. */
    payloadHash: text("payload_hash"),
    // pending | applied | conflict | rejected
    status: text("status").notNull().default("pending"),
    /** Resulting server row id (po_item_receipts.id / customer_po_item_deliveries.id). */
    resultId: integer("result_id"),
    error: text("error"),
    requestPayload: jsonb("request_payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mobile_sync_operations_employee_uuid_uq").on(t.hrEmployeeId, t.clientUuid),
    index("mobile_sync_operations_status_idx").on(t.hrEmployeeId, t.status),
  ],
);

export type MobileSyncOperation = typeof mobileSyncOperationsTable.$inferSelect;

/**
 * جلسات تطبيق الموبايل — opaque bearer tokens. Only the SHA-256 hash of the
 * token is stored, so a database read can never yield a usable credential, and
 * a token can be revoked or left to expire server-side (the client cannot
 * extend its own session). `fcmToken` here is the device's push token, captured
 * at login so notifications can target the device later.
 */
export const mobileSessionsTable = pgTable(
  "mobile_sessions",
  {
    id: serial("id").primaryKey(),
    hrEmployeeId: integer("hr_employee_id")
      .notNull()
      .references(() => hrEmployeesTable.id, { onDelete: "cascade" }),
    /** SHA-256 hex of the opaque token — the token itself is never stored. */
    tokenHash: text("token_hash").notNull(),
    deviceInfo: text("device_info"),
    fcmToken: text("fcm_token"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("mobile_sessions_token_uq").on(t.tokenHash),
    index("mobile_sessions_employee_idx").on(t.hrEmployeeId),
  ],
);

export type MobileSession = typeof mobileSessionsTable.$inferSelect;
