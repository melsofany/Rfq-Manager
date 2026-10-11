/**
 * Ask the operator WHICH SOURCE a census should read, before spending any model
 * quota on it.
 *
 * A count or «حصر» question has three possible datasets: the internal purchase-
 * order tables, the mailbox, or the WhatsApp conversation. They give different
 * numbers, and answering from the wrong one is a confident wrong answer. When the
 * question names no source, the agent asks once, with the three options, and
 * then runs the question against the choice.
 *
 * The question is held in memory for a short window (not in the database), so it
 * needs no schema change. If the process restarts in between, the operator simply
 * repeats the question, which costs one message.
 */

const CENSUS_RE =
  /حصر|جرد|إجمالي|اجمالي|كام\s*مرة|كم\s*مرة|اكتر\s*بند|أكثر\s*بند|اكثر\s*بند|أكتر\s*بند|كل\s*(?:ال)?(?:أوامر|اوامر|بنود|طلبات|مرفقات|أصناف|اصناف)|عدد\s*(?:ال)?(?:أوامر|اوامر|بنود|طلبات)|جميع\s*(?:ال)?(?:أوامر|اوامر|بنود)/;

/** Any sign that the operator already said where the data comes from. */
const SOURCE_NAMED_RE =
  /قاعد[ةه]\s*البيانات|الداتا|داتا|داتابيز|داتا\s*بيس|النظام|الميل|ميل|البريد|ايميل|إيميل|ايمل|إيمل|واتساب|واتس|الواتس|المحادث|database|\bdb\b|email|mail|inbox|whatsapp/i;

/** A reply of this many words or fewer can be a bare source choice. */
const MAX_CHOICE_WORDS = 6;
const PENDING_TTL_MS = 10 * 60 * 1000;

export type SourceChoice = "db" | "email" | "whatsapp";

const LABELS: Record<SourceChoice, { label: string; directive: string }> = {
  db: {
    label: "قاعدة البيانات الداخلية (أوامر الشراء المسجلة)",
    directive: "من قاعدة البيانات الداخلية",
  },
  email: {
    label: "البريد الإلكتروني (الرسائل والمرفقات)",
    directive: "من الميل",
  },
  whatsapp: {
    label: "رسائل واتساب",
    directive: "من الواتساب",
  },
};

export const SOURCE_QUESTION =
  "قبل ما أبدأ الحصر: البيانات دي هجيبها من فين؟\n" +
  "1) قاعدة البيانات الداخلية (أوامر الشراء المسجلة عندنا)\n" +
  "2) البريد الإلكتروني (الرسائل والمرفقات)\n" +
  "3) واتساب\n" +
  "ابعت الرقم أو اسم المصدر، وأبدأ على طول.";

/** A census question that names no source. */
export function needsSourceChoice(text: string): boolean {
  return CENSUS_RE.test(text) && !SOURCE_NAMED_RE.test(text);
}

/** Read a bare reply as one of the three sources, or null if it is a new question. */
export function parseSourceChoice(text: string): SourceChoice | null {
  const t = text.trim();
  if (!t || t.split(/\s+/).length > MAX_CHOICE_WORDS) return null;
  if (/^[1١]\)?\.?$/.test(t) || /قاعد|داتا|النظام|database|\bdb\b/i.test(t)) return "db";
  if (/^[2٢]\)?\.?$/.test(t) || /ميل|بريد|ايميل|إيميل|ايمل|email|mail/i.test(t)) return "email";
  if (/^[3٣]\)?\.?$/.test(t) || /واتس|محادث|whatsapp/i.test(t)) return "whatsapp";
  return null;
}

interface Pending {
  question: string;
  at: number;
}

const pending = new Map<string, Pending>();

/**
 * The last census that ran for this operator, with its source stated. A
 * «اكمل الحصر» that follows it resumes THAT question instead of asking again.
 * Without this, a continuation was read as a new census with no source — the
 * live failure that asked «من فين؟» in the middle of a half-finished read.
 */
const LAST_CENSUS_TTL_MS = 30 * 60 * 1000;
const lastQuestion = new Map<string, Pending>();

/** A short message whose only job is to continue the previous work. */
const CONTINUE_RE = /^\s*(?:اكمل|أكمل|اكملي|كمل|كمّل|استمر|تابع|واصل|continue|go on)(?=\s|$)/i;

export function isContinuation(text: string): boolean {
  return CONTINUE_RE.test(text) && text.trim().split(/\s+/).length <= 4;
}

/**
 * Decide, before any model call, whether this message is a source question to
 * ask, a source answer that completes a held question, or an ordinary message.
 */
export function resolveSourceChoice(
  key: string,
  text: string,
  now: number = Date.now(),
): { kind: "ask"; reply: string } | { kind: "run"; text: string } {
  // A continuation resumes the last census with its source; it never opens a new
  // source question. With nothing to resume it runs as the plain message.
  if (isContinuation(text)) {
    const last = lastQuestion.get(key);
    if (last && now - last.at <= LAST_CENSUS_TTL_MS) {
      return {
        kind: "run",
        text: `${last.question}\n(استكمل المهمة السابقة من حيث توقفت، ولا تبدأ من الصفر)`,
      };
    }
    return { kind: "run", text };
  }

  const held = pending.get(key);
  if (held) {
    pending.delete(key);
    const choice = now - held.at <= PENDING_TTL_MS ? parseSourceChoice(text) : null;
    if (choice) {
      const { directive } = LABELS[choice];
      const question = `${held.question}\n(${directive}، المصدر المحدد: ${LABELS[choice].label})`;
      lastQuestion.set(key, { question, at: now });
      return { kind: "run", text: question };
    }
    // Not a source answer: the operator moved on, so the held question is dropped
    // and this message is handled as a fresh one.
  }

  if (needsSourceChoice(text)) {
    pending.set(key, { question: text, at: now });
    return { kind: "ask", reply: SOURCE_QUESTION };
  }
  // Any substantive question is resumable by «كمّل», not only a census: the operator's
  // «كمّل» after a reply that stopped halfway means that question.
  if (text.trim().split(/\s+/).length >= 4) lastQuestion.set(key, { question: text, at: now });
  return { kind: "run", text };
}

export interface LoggedTurn {
  role: string;
  content: string;
  /** Epoch ms the turn was stored. */
  at: number;
}

/** True when this process holds no state for the operator (e.g. after a restart). */
export function hasSourceState(key: string): boolean {
  return pending.has(key) || lastQuestion.has(key);
}

/**
 * Rebuild the gate's state from the stored conversation.
 *
 * The two maps above live in process memory, so every deploy or restart used to
 * erase a half-answered «من فين؟» and the target of a «كمّل». The conversation is
 * already persisted, so it is the durable source: a question the assistant asked
 * last is pending again, and the newest substantive operator message within the
 * resume window is what «كمّل» continues. `turns` is oldest-first.
 */
export function recoverSourceState(key: string, turns: LoggedTurn[], now: number): void {
  if (hasSourceState(key) || turns.length === 0) return;
  const last = turns[turns.length - 1];
  const before = turns[turns.length - 2];
  if (
    last.role === "assistant" &&
    last.content.startsWith(SOURCE_QUESTION.slice(0, 40)) &&
    before?.role === "user" &&
    now - last.at <= PENDING_TTL_MS
  ) {
    pending.set(key, { question: before.content, at: last.at });
    return;
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role !== "user") continue;
    if (now - t.at > LAST_CENSUS_TTL_MS) return;
    if (isContinuation(t.content) || t.content.trim().split(/\s+/).length < 4) continue;
    lastQuestion.set(key, { question: t.content, at: t.at });
    return;
  }
}

/** Test helper and reset hook (e.g. on «تصفير»). */
export function clearSourceChoice(key?: string): void {
  if (key === undefined) {
    pending.clear();
    lastQuestion.clear();
  } else {
    pending.delete(key);
    lastQuestion.delete(key);
  }
}
