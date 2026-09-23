/**
 * AI Assistant — conversation state (P4).
 *
 * A tiny, per-phone "what are we talking about" record. The point is a follow-up
 * question: «وطب آخر سعر له؟» should resolve "له" to the part just discussed,
 * without the operator restating it and without re-running a full search. This is
 * deliberately NOT a transcript — the transcript is `ai_assistant_messages`; this
 * holds only the last entities, so it stays small and cheap to read on every turn.
 *
 * It is best-effort by design: a failure to read or write state must never break
 * an answer, so every call swallows its own errors.
 */
import { db, aiAssistantStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../shared/logger";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ConversationState {
  lastDocumentType: string | null;
  lastDocumentNumber: string | null;
  lastSupplier: string | null;
  lastCustomer: string | null;
  lastPartNo: string | null;
  lastPeriod: string | null;
  lastJobId: number | null;
}

const EMPTY: ConversationState = {
  lastDocumentType: null,
  lastDocumentNumber: null,
  lastSupplier: null,
  lastCustomer: null,
  lastPartNo: null,
  lastPeriod: null,
  lastJobId: null,
};

/** Read the current state for a phone; returns an empty state when none exists. */
export async function loadConversationState(phone: string): Promise<ConversationState> {
  try {
    const rows = (await (db as any)
      .select()
      .from(aiAssistantStateTable)
      .where(eq(aiAssistantStateTable.phone, phone))
      .limit(1)) as any[];
    const r = rows[0];
    if (!r) return { ...EMPTY };
    return {
      lastDocumentType: r.lastDocumentType ?? null,
      lastDocumentNumber: r.lastDocumentNumber ?? null,
      lastSupplier: r.lastSupplier ?? null,
      lastCustomer: r.lastCustomer ?? null,
      lastPartNo: r.lastPartNo ?? null,
      lastPeriod: r.lastPeriod ?? null,
      lastJobId: r.lastJobId ?? null,
    };
  } catch (err) {
    logger.warn({ err, phone }, "AI assistant: conversation state read failed (non-fatal)");
    return { ...EMPTY };
  }
}

/**
 * Merge `patch` into the stored state. Only non-null patch fields overwrite, so
 * an entity that was not mentioned this turn is REMEMBERED rather than cleared —
 * that is what makes «آخر سعر له» still work two questions later.
 */
export async function saveConversationState(
  phone: string,
  patch: Partial<ConversationState>,
): Promise<void> {
  const clean: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  if (Object.keys(clean).length <= 1) return; // nothing to record
  try {
    const existing = (await (db as any)
      .select({ id: aiAssistantStateTable.id })
      .from(aiAssistantStateTable)
      .where(eq(aiAssistantStateTable.phone, phone))
      .limit(1)) as any[];
    if (existing[0]) {
      await (db as any)
        .update(aiAssistantStateTable)
        .set(clean)
        .where(eq(aiAssistantStateTable.phone, phone));
    } else {
      await (db as any).insert(aiAssistantStateTable).values({ phone, ...clean });
    }
  } catch (err) {
    logger.warn({ err, phone }, "AI assistant: conversation state write failed (non-fatal)");
  }
}

export async function clearConversationState(phone: string): Promise<void> {
  try {
    await (db as any).delete(aiAssistantStateTable).where(eq(aiAssistantStateTable.phone, phone));
  } catch (err) {
    logger.warn({ err, phone }, "AI assistant: conversation state clear failed (non-fatal)");
  }
}

/**
 * A short prompt fragment describing what is currently under discussion, so the
 * model can resolve pronouns itself. Returns "" when nothing is known.
 */
export function renderConversationState(state: ConversationState): string {
  const parts: string[] = [];
  if (state.lastDocumentNumber) {
    parts.push(`آخر مستند: ${state.lastDocumentType ?? "مستند"} ${state.lastDocumentNumber}`);
  }
  if (state.lastSupplier) parts.push(`آخر مورد: ${state.lastSupplier}`);
  if (state.lastCustomer) parts.push(`آخر عميل: ${state.lastCustomer}`);
  if (state.lastPartNo) parts.push(`آخر بند: ${state.lastPartNo}`);
  if (state.lastPeriod) parts.push(`آخر فترة: ${state.lastPeriod}`);
  if (parts.length === 0) return "";
  return (
    "\n\nسياق المحادثة الحالي (استخدمه لحلّ الضمائر مثل «له/بتاعه»، " +
    "ولا تفترض أنه لا يزال صحيحًا إن خالفه سؤال جديد):\n- " +
    parts.join("\n- ")
  );
}

/**
 * Best-effort extraction of state from a user turn + the entities a tool
 * returned. Deliberately conservative: it records what was EXPLICITLY named, not
 * an inference, because a wrong "last part" silently poisons the next question.
 */
export function inferStatePatch(opts: {
  userText: string;
  lastToolData?: unknown;
}): Partial<ConversationState> {
  const patch: Partial<ConversationState> = {};
  const text = opts.userText || "";

  // Document numbers: an alphanumeric id (P26E11407) or a bare 5+ digit run.
  const docNo =
    text.match(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{4,}\b/i)?.[0] ??
    text.match(/\b\d{5,}\b/)?.[0];
  if (docNo) patch.lastDocumentNumber = docNo;

  // A year or a "last N days/months" phrase — enough to scope a follow-up.
  const year = text.match(/\b(20\d{2})\b/);
  if (year) patch.lastPeriod = year[1];
  else if (/اخر\s*(شهر|اسبوع|سنه|يوم)|آخر\s*(شهر|أسبوع|سنة|يوم)/.test(text)) {
    patch.lastPeriod = text.match(/(اخر|آخر)\s*(شهر|اسبوع|اسبوع|سنه|سنة|يوم)/)?.[0] ?? null;
  }

  return patch;
}
