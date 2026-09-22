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
    const text = msg.text?.body?.trim() || msg.image?.caption?.trim() || "";
    if (RESET_WORDS.includes(text.toLowerCase())) {
      const { resetHistory } = await import("./agent");
      await resetHistory(phone);
      await sendWhatsAppText(phone, "تم تصفير المحادثة. اسألني عن أي شيء.");
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
    const message = quota
      ? "المساعد الذكي وصل لحد الاستخدام المسموح للموديل حاليًا (حصة Gemini اليومية). حاول مرة أخرى بعد قليل."
      : timedOut
        ? "استغرق الطلب وقتًا أطول من المسموح فتم إيقافه. جرّب سؤالًا أكثر تحديدًا (مثل رقم أمر التوريد) وسأجيب أسرع."
        : "تعذّر معالجة طلبك حاليًا. حاول مرة أخرى بعد قليل.";
    try {
      await sendWhatsAppText(phone, message);
    } catch {
      /* ignore */
    }
  }
}
