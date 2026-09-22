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
import { isQuotaError } from "./llm";

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
 * Returns true when the AI assistant owns this message (i.e. the sender is an
 * allowlisted admin/manager). Returns false for everyone else so the normal
 * rep-bot / supplier chat flow continues untouched.
 */
export async function handleAiAssistantMessage(
  phone: string,
  msg: WaInboundMessage,
): Promise<boolean> {
  if (!isAiConfigured) {
    // No LLM configured — only take over if the sender is allowlisted, so we
    // can explain why there is no answer rather than silently dropping it.
    const user = await findAuthorizedUser(phone);
    if (!user) return false;
    await sendWhatsAppText(
      user.phone,
      "المساعد الذكي غير مُفعّل بعد: مفتاح الذكاء الاصطناعي (AI_API_KEY) غير مضبوط على الخادم.",
    );
    return true;
  }

  const user = await findAuthorizedUser(phone);
  if (!user) return false;

  const settings = await loadSettings();
  if (!settings.enabled) {
    await sendWhatsAppText(user.phone, "المساعد الذكي معطّل حاليًا من الإعدادات.");
    return true;
  }

  try {
    const text = msg.text?.body?.trim() || msg.image?.caption?.trim() || "";
    if (RESET_WORDS.includes(text.toLowerCase())) {
      const { resetHistory } = await import("./agent");
      await resetHistory(user.phone);
      await sendWhatsAppText(user.phone, "تم تصفير المحادثة. اسألني عن أي شيء.");
      return true;
    }

    const payload: Parameters<typeof runAgent>[0] = { phone: user.phone };

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
      return false;
    }

    const result = await runAgent(payload);
    await sendWhatsAppText(user.phone, result.reply);

    for (const att of result.attachments) {
      try {
        await sendWhatsAppDocument(user.phone, att.buffer, att.filename, att.mimeType);
      } catch (err) {
        logger.warn({ err, phone: user.phone }, "AI assistant: sending generated file failed");
      }
    }
    return true;
  } catch (err) {
    logger.error({ err, phone: user.phone }, "AI assistant: handling failed");
    const quota = isQuotaError(err);
    const message = quota
      ? "المساعد الذكي وصل لحد الاستخدام المسموح للموديل حاليًا (حصة Gemini اليومية). حاول مرة أخرى بعد قليل."
      : "تعذّر معالجة طلبك حاليًا. حاول مرة أخرى بعد قليل.";
    try {
      await sendWhatsAppText(user.phone, message);
    } catch {
      /* ignore */
    }
    return true;
  }
}
