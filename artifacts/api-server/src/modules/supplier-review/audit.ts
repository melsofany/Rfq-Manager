/**
 * The review audit trail.
 *
 * `supplier_application_events` already exists and the PORTAL writes its own
 * side of it (submitted, document_uploaded, email_verified…). The main system
 * wrote NOTHING, so every employee decision — the only part an auditor actually
 * asks about — was invisible. This module is the employee half.
 *
 * Append-only by construction: there is no update and no delete here, and the
 * table has no UI to edit it. An audit row that can be rewritten is not an
 * audit row.
 */
import { pool } from "@workspace/db";
import { logger } from "../../shared/logger";

/** Events the main system records. Distinct from the portal's own names. */
export const REVIEW_EVENT = {
  ASSIGNED: "review_assigned",
  STARTED: "review_started",
  FIELD_VERDICT: "field_verdict",
  COMPARISON: "document_comparison",
  INFO_REQUESTED: "info_requested",
  DOCS_REQUESTED: "docs_requested",
  RESUBMITTED: "resubmitted",
  VERIFIED: "verified",
  APPROVED: "approved",
  REJECTED: "rejected",
  SUSPENDED: "suspended",
  RESUMED: "resumed",
  DOCUMENT_VIEWED: "document_viewed",
  DOCUMENT_DOWNLOADED: "document_downloaded",
  CATEGORY_VERDICT: "category_verdict",
  DECISION_BLOCKED: "decision_blocked",
} as const;

export type ReviewEvent = (typeof REVIEW_EVENT)[keyof typeof REVIEW_EVENT];

export interface AuditActor {
  employeeId?: number | null;
  employeeName?: string | null;
}

export interface AuditEntry {
  applicationId: number;
  event: ReviewEvent | string;
  fromStatus?: string | null;
  toStatus?: string | null;
  note?: string | null;
  actor?: AuditActor;
  /** Free-form context (which fields changed, which doc, OCR confidence…). */
  metadata?: Record<string, unknown> | null;
}

/**
 * Append one event.
 *
 * Best-effort ON PURPOSE: a failed audit write must never turn a decision the
 * reviewer already made into an error, or the reviewer retries and the decision
 * lands twice. A failure is logged loudly instead — a silent gap in an audit
 * trail is the worst possible outcome, so it must be visible in the logs.
 */
export async function recordReviewEvent(entry: AuditEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO supplier_application_events
         (application_id, event, from_status, to_status, note, actor_name, actor_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        entry.applicationId,
        entry.event,
        entry.fromStatus ?? null,
        entry.toStatus ?? null,
        entry.note ?? null,
        entry.actor?.employeeName ?? null,
        entry.actor?.employeeId ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ],
    );
  } catch (err) {
    // The column may not exist yet on a database that predates this migration;
    // retry without metadata rather than losing the event itself.
    try {
      await pool.query(
        `INSERT INTO supplier_application_events
           (application_id, event, from_status, to_status, note, actor_name, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.applicationId,
          entry.event,
          entry.fromStatus ?? null,
          entry.toStatus ?? null,
          entry.note ?? null,
          entry.actor?.employeeName ?? null,
          entry.actor?.employeeId ?? null,
        ],
      );
    } catch (inner) {
      logger.error(
        { err: inner, applicationId: entry.applicationId, event: entry.event },
        "AUDIT WRITE FAILED — the review trail is now missing an event",
      );
    }
  }
}

export interface AuditRow {
  id: number;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  actorName: string | null;
  actorId: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** The full history of one application, oldest first. */
export async function loadAuditTrail(applicationId: number): Promise<AuditRow[]> {
  const { rows } = await pool.query<{
    id: number;
    event: string;
    from_status: string | null;
    to_status: string | null;
    note: string | null;
    actor_name: string | null;
    actor_id: number | null;
    metadata: Record<string, unknown> | null;
    created_at: Date;
  }>(
    `SELECT id, event, from_status, to_status, note, actor_name, actor_id, metadata, created_at
       FROM supplier_application_events
      WHERE application_id = $1
      ORDER BY created_at ASC, id ASC`,
    [applicationId],
  );
  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    note: r.note,
    actorName: r.actor_name,
    actorId: r.actor_id,
    metadata: r.metadata ?? null,
    createdAt: r.created_at.toISOString(),
  }));
}
