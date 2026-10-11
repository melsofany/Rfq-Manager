/**
 * AI Assistant — incident capture.
 *
 * Every failure mode found so far was diagnosed by hand from logs after the
 * operator complained, then fixed for that one case. This closes the loop: a reply
 * that failed or had to be corrected is stored durably, with the question and the
 * reply, so (a) the rate of each failure kind is measurable and (b) each one can
 * be replayed as a regression case (`incidentToFixture`).
 *
 * Capture is best-effort and never on the critical path: a failed insert must not
 * turn a delivered answer into an error.
 */
import { db, aiAssistantIncidentsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { logger } from "../../shared/logger";
import { findUnkeptPromise } from "./answer-guard";

export type IncidentKind =
  | "gave_up"
  | "unkept_promise"
  | "ungrounded_fact"
  | "unknown_entity"
  | "claim_contradiction"
  | "premature_refusal"
  | "numeric_disagreement"
  | "tool_errors"
  | "tool_markup_only"
  | "run_error";

const GAVE_UP_RE = /^(?:لم أستطع إكمال الطلب|نفدت محاولات المعالجة|الحصر لم يكتمل)/;

export interface IncidentSignals {
  reply: string;
  /** Signals raised by the verification loop during the run. */
  raised: IncidentKind[];
  toolCalls: number;
  toolErrors: number;
  hadToolMarkup: boolean;
  usedJob: boolean;
}

/** Pure: which failure kinds does this finished run exhibit? */
export function detectIncidents(sig: IncidentSignals): IncidentKind[] {
  const kinds = new Set<IncidentKind>(sig.raised);
  const reply = sig.reply.trim();
  if (GAVE_UP_RE.test(reply)) kinds.add("gave_up");
  if (!sig.usedJob && findUnkeptPromise(reply)) kinds.add("unkept_promise");
  if (sig.hadToolMarkup && !reply) kinds.add("tool_markup_only");
  // Most calls failing is a failure even when the final text reads fine.
  if (sig.toolCalls >= 2 && sig.toolErrors / sig.toolCalls >= 0.5) kinds.add("tool_errors");
  return [...kinds];
}

export async function recordIncident(
  phone: string,
  question: string,
  reply: string,
  kinds: IncidentKind[],
  detail?: Record<string, unknown>,
): Promise<void> {
  if (kinds.length === 0) return;
  try {
    await db.insert(aiAssistantIncidentsTable).values({
      phone,
      question: question.slice(0, 4000),
      reply: reply.slice(0, 8000),
      kinds,
      detail: detail ?? null,
    });
    logger.warn({ phone, kinds }, "AI assistant: incident recorded");
  } catch (err) {
    logger.warn({ err }, "AI assistant: could not record the incident");
  }
}

export async function recentIncidents(limit = 50) {
  return db
    .select()
    .from(aiAssistantIncidentsTable)
    .orderBy(desc(aiAssistantIncidentsTable.id))
    .limit(Math.min(Math.max(limit, 1), 200));
}

export interface IncidentFixture {
  question: string;
  /** What the assistant answered when it failed — the thing that must not recur. */
  badReply: string;
  kinds: IncidentKind[];
}

/** An incident as a regression fixture, ready to commit under __tests__/fixtures. */
export function incidentToFixture(row: {
  question: string;
  reply: string;
  kinds: string[];
}): IncidentFixture {
  return { question: row.question, badReply: row.reply, kinds: row.kinds as IncidentKind[] };
}
