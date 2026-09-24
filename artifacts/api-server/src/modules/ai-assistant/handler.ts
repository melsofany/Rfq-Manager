/**
 * AI Assistant — WhatsApp gateway.
 *
 * Handles inbound WhatsApp messages for allowlisted admin/manager numbers. The
 * assistant is tried BEFORE the representative bot / normal chat so an
 * allowlisted number's text reaches the agent. When WhatsApp media is enabled,
 * images/voice notes/documents are downloaded and handed to the model.
 */
import { logger } from "../../shared/logger";
import {
  downloadInboundMedia,
  sendWhatsAppText,
  sendWhatsAppDocument,
} from "../communications/service";
import { findAuthorizedUser, loadSettings, isAiConfigured } from "./config";
import { runAgent } from "./agent";
import { isQuotaError, isTimeoutError } from "./llm";
import { capInput, checkRateLimit, noteInjection } from "./guardrails";

/** Minimal structural view of an inbound Meta message (matches routes.ts). */
export interface WaInboundMessage {
  type: string;
  text?: { body?: string };
  image?: { id?: string; caption?: string; mime_type?: string };
  document?: { id?: string; filename?: string; mime_type?: string };
  audio?: { id?: string; mime_type?: string };
  video?: { id?: string; caption?: string; mime_type?: string };
  interactive?: { button_reply?: { id?: string }; list_reply?: { id?: string } };
  button?: { payload?: string };
}

const RESET_WORDS = ["/reset", "تصفير", "ازالة السياق", "إزالة السياق", "ابدأ من جديد"];

/**
 * How long an answer may take before we reassure the operator. Sending an ack
 * on every message would double the message traffic and read as noise, so it is
 * sent only when the answer is actually slow.
 */
const ACK_AFTER_MS = 6_000;

/**
 * Background answers currently in flight. Tracked so the work can be drained on
 * shutdown (and in tests) instead of being silently cut off mid-answer.
 */
const inFlight = new Set<Promise<void>>();

/** Resolves when every background answer has finished. */
export async function pendingAiAssistantWork(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

/**
 * Returns true when the AI assistant owns this message (i.e. the sender is an
 * allowlisted admin/manager). Returns false for everyone else so the normal
 * rep-bot / supplier chat flow continues untouched.
 *
 * The agent run itself happens in the BACKGROUND. A tool-calling answer takes
 * several provider round-trips (measured 10-40s), but Meta retries a webhook
 * that has not been acknowledged in a few seconds — so awaiting the answer here
 * made Meta redeliver the same message, running the whole thing twice and
 * burning double quota. Ownership is decided up front and the webhook returns
 * immediately; the reply is delivered when it is ready.
 */
export async function handleAiAssistantMessage(
  phone: string,
  msg: WaInboundMessage,
): Promise<boolean> {
  const user = await findAuthorizedUser(phone);
  if (!user) return false;

  // Admission control BEFORE any quota is spent. A flooded number is told to
  // wait rather than being answered until the day's quota is gone — the recorded
  // way this assistant goes silent for everyone.
  const rate = checkRateLimit(user.phone);
  if (!rate.allowed) {
    const waitSec = Math.ceil(rate.retryAfterMs / 1000);
    logger.warn({ phone: user.phone }, "AI assistant: rate limit exceeded");
    void sendWhatsAppText(
      user.phone,
      `وصلت للحد الأقصى من الرسائل في وقت قصير. حاول مرة أخرى بعد ${waitSec} ثانية.`,
    ).catch(() => {
      /* the notice must never break anything */
    });
    return true;
  }

  noteInjection(msg.text?.body ?? msg.image?.caption ?? "", user.phone);

  const ackTimer = setTimeout(() => {
    void sendWhatsAppText(user.phone, "⏳ جاري البحث في النظام... لحظات وأرسل لك الإجابة.").catch(
      () => {
        /* an ack must never break the answer */
      },
    );
  }, ACK_AFTER_MS);

  const work = respondToAuthorizedUser(user.phone, msg)
    .catch((err) => logger.error({ err, phone }, "AI assistant: background handling failed"))
    .finally(() => {
      clearTimeout(ackTimer);
      inFlight.delete(work);
    });
  inFlight.add(work);
  return true;
}

/** Does the actual work for an allowlisted sender; runs in the background. */
async function respondToAuthorizedUser(phone: string, msg: WaInboundMessage): Promise<void> {
  if (!isAiConfigured) {
    await sendWhatsAppText(
      phone,
      "المساعد الذكي غير مُفعّل بعد: مفتاح الذكاء الاصطناعي (AI_API_KEY) غير مضبوط على الخادم.",
    );
    return;
  }

  const settings = await loadSettings();
  if (!settings.enabled) {
    await sendWhatsAppText(phone, "المساعد الذكي معطّل حاليًا من الإعدادات.");
    return;
  }

  try {
    const raw = msg.text?.body?.trim() || msg.image?.caption?.trim() || "";
    const { text: capped, truncated } = capInput(raw);
    if (truncated) {
      // Tell the operator rather than answering a silently-shortened question.
      await sendWhatsAppText(
        phone,
        "رسالتك طويلة جدًا فتم اختصارها. أرسل السؤال الأهم في البداية لو أمكن.",
      );
    }
    const text = capped;
    if (RESET_WORDS.includes(text.toLowerCase())) {
      const { resetHistory } = await import("./agent");
      await resetHistory(phone);
      // Also drop the "what are we talking about" context, or a stale part /
      // supplier from before the reset would still resolve pronouns in the new
      // conversation.
      const { clearConversationState } = await import("./conversation");
      await clearConversationState(phone);
      // And drop the CACHED CENSUS. A reset means "start over with no prior
      // result": leaving the scan cache (or its Postgres mirror) in place would
      // let the next question reuse a cursor and a row set produced before the
      // reset — exactly the "don't rely on any previous result or sample" the
      // operator asked for, violated invisibly.
      const { clearScanCache, clearPersistedScanSessions } = await import("./email");
      clearScanCache();
      await clearPersistedScanSessions();
      await sendWhatsAppText(
        phone,
        "تم تصفير المحادثة والنتائج المحفوظة. اسألني عن أي شيء من جديد.",
      );
      return;
    }

    const payload: Parameters<typeof runAgent>[0] = { phone };

    if (msg.type === "text") {
      payload.text = text;
    } else if (msg.type === "image" || msg.type === "sticker") {
      if (msg.image?.id) {
        const media = await downloadInboundMedia(msg.image.id);
        if (media) {
          payload.imageUrl = `data:${media.mimeType};base64,${media.buffer.toString("base64")}`;
        }
      }
      payload.text = text || "حلّل هذه الصورة.";
    } else if (msg.type === "audio") {
      if (msg.audio?.id) {
        const media = await downloadInboundMedia(msg.audio.id);
        if (media) payload.audio = { buffer: media.buffer, mimeType: media.mimeType };
      }
    } else if (msg.type === "document") {
      const doc = msg.document;
      if (doc?.id) {
        const media = await downloadInboundMedia(doc.id);
        if (media) {
          payload.document = {
            buffer: media.buffer,
            mimeType: doc.mime_type || media.mimeType,
            filename: doc.filename,
          };
        }
      }
      // A caption ("لخّص ده") is the question about the file; without one, ask
      // the model to work out what the file is and answer about it.
      payload.text = text || "اقرأ هذا الملف ولخّص لي أهم ما فيه.";
    } else if (msg.type === "interactive" || msg.type === "button" || msg.type === "video") {
      // Videos are not read: too large to download and not a document format the
      // model can interpret usefully here. Text captions are still answered.
      payload.text = text || "اكتب سؤالك نصيًا وسأجيبك فورًا.";
    } else {
      return;
    }

    const result = await runAgent(payload);
    await sendWhatsAppText(phone, result.reply);

    for (const att of result.attachments) {
      try {
        await sendWhatsAppDocument(phone, att.buffer, att.filename, att.mimeType);
      } catch (err) {
        logger.warn({ err, phone }, "AI assistant: sending generated file failed");
      }
    }
  } catch (err) {
    logger.error({ err, phone }, "AI assistant: handling failed");
    const quota = isQuotaError(err);
    const timedOut = isTimeoutError(err);
    let message = quota
      ? `المساعد الذكي وصل لحد الاستخدام المسموح من المزود حاليًا (حصة الموديلات المجانية). ${quotaResetHint()} جرّب سؤالًا أكثر تحديدًا (مثل رقم أمر التوريد) — كل سؤال يستهلك عدة طلبات من نفس الحصة.`
      : timedOut
        ? "استغرق الطلب وقتًا أطول من المسموح فتم إيقافه. جرّب سؤالًا أكثر تحديدًا (مثل رقم أمر التوريد) وسأجيب أسرع."
        : "تعذّر معالجة طلبك حاليًا. حاول مرة أخرى بعد قليل.";
    if (quota) {
      // A quota failure is NOT always a dead end: a census already handed to a
      // background job keeps running (it reads mail locally and spends no model
      // quota), so its report will still arrive. Saying only «quota exhausted»
      // would make the operator re-send a request whose answer is already on the
      // way — and each re-send is another wasted model call.
      const active = await activeJobNote(phone).catch(() => "");
      if (active) message = `${message}\n${active}`;
    }
    try {
      await sendWhatsAppText(phone, message);
    } catch {
      /* ignore */
    }
  }
}

/**
 * The Gemini free tier resets at midnight PACIFIC. Saying «حاول بعد قليل» invites
 * the operator to retry during a window that CANNOT recover — a message that
 * cannot be acted on. This is advisory only; if Google changes the reset the
 * worst case is a stale hint, never a wrong action.
 */
function quotaResetHint(): string {
  try {
    const now = new Date();
    const pacific = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const midnight = new Date(pacific);
    midnight.setHours(24, 0, 0, 0);
    const minutes = Math.max(1, Math.round((midnight.getTime() - pacific.getTime()) / 60_000));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const human = h > 0 ? `${h} ساعة${m ? ` و${m} دقيقة` : ""}` : `${m} دقيقة`;
    return `تتجدد الحصة حوالي منتصف الليل بتوقيت الباسيفيك (بعد نحو ${human}). اضبط DEEPSEEK_API_KEY كمزوّد احتياطي لتجنّب التوقف.`;
  } catch {
    return "حاول مرة أخرى بعد قليل.";
  }
}

/**
 * A line telling the operator that a background job is still working (and will
 * report on its own), or "" when there is nothing in flight. Kept here rather
 * than in the prompt so it is stated even when the model never got a turn.
 */
async function activeJobNote(phone: string): Promise<string> {
  const { listJobs } = await import("./jobs");
  const jobs = await listJobs(phone, 5);
  const active = jobs.find((j) => j.status === "queued" || j.status === "running");
  if (!active) return "";
  return (
    `لكن مهمة الحصر #${active.id} لا تزال تعمل في الخلفية وتقرأ البريد مباشرة ` +
    `(بدون استهلاك حصة الموديل)، وسيصلك تقريرها على واتساب عند الانتهاء.`
  );
}
