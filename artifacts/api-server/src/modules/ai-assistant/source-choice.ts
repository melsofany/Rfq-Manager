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
 * Decide, before any model call, whether this message is a source question to
 * ask, a source answer that completes a held question, or an ordinary message.
 */
export function resolveSourceChoice(
  key: string,
  text: string,
  now: number = Date.now(),
): { kind: "ask"; reply: string } | { kind: "run"; text: string } {
  const held = pending.get(key);
  if (held) {
    pending.delete(key);
    const choice = now - held.at <= PENDING_TTL_MS ? parseSourceChoice(text) : null;
    if (choice) {
      const { directive } = LABELS[choice];
      return {
        kind: "run",
        text: `${held.question}\n(${directive}، المصدر المحدد: ${LABELS[choice].label})`,
      };
    }
    // Not a source answer: the operator moved on, so the held question is dropped
    // and this message is handled as a fresh one.
  }

  if (needsSourceChoice(text)) {
    pending.set(key, { question: text, at: now });
    return { kind: "ask", reply: SOURCE_QUESTION };
  }
  return { kind: "run", text };
}

/** Test helper and reset hook (e.g. on «تصفير»). */
export function clearSourceChoice(key?: string): void {
  if (key === undefined) pending.clear();
  else pending.delete(key);
}
