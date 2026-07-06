import { Router, type Request, type Response } from "express";
import { db, suppliersTable, whatsappChatsTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import {
  Whatsapp,
  PHONE_NUMBER_ID,
  WEBHOOK_VERIFY_TOKEN,
  isWhatsAppConfigured,
  sendWhatsAppText,
} from "../lib/whatsapp";
import { requireAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";

const router = Router();

const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const WA_PHONE_ID = PHONE_NUMBER_ID;
const WA_API_VERSION = "v22.0";

function normalizePhone(phone: string): string {
  let cleaned = phone.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);
  if (cleaned.length === 11 && cleaned.startsWith("0")) cleaned = "2" + cleaned;
  if (cleaned.length === 10 && cleaned.startsWith("1")) cleaned = "20" + cleaned;
  return cleaned;
}

// ─── SSE: real-time push to connected browser clients ─────────────────────
const sseClients = new Set<Response>();

export function broadcastWaEvent(event: { type: string; phone?: string }) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try { (client as Response).write(payload); } catch { sseClients.delete(client); }
  }
}

router.get("/whatsapp/events", requireAuth, (req, res): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  // heartbeat every 25 s to survive proxies / load-balancers
  const hb = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(hb); sseClients.delete(res); }
  }, 25000);
  sseClients.add(res);
  req.on("close", () => { clearInterval(hb); sseClients.delete(res); });
});

// ─── Webhook: handled via the whatsapp-api-js official Cloud API client ────
// GET performs Meta's subscription handshake; POST parses inbound
// messages/status updates using the library's typed event emitters instead
// of manually walking the raw entry/changes payload shape.

router.get("/webhook/whatsapp", (req, res): void => {
  if (!WEBHOOK_VERIFY_TOKEN) {
    res.status(500).json({ error: "WHATSAPP_VERIFY_TOKEN not configured" });
    return;
  }
  const mode = req.query["hub.mode"];
  const verifyToken = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode !== "subscribe" || typeof verifyToken !== "string" || typeof challenge !== "string") {
    res.status(403).json({ error: "Verification failed" });
    return;
  }
  let result: string | undefined;
  try {
    result = Whatsapp.get({ "hub.mode": mode, "hub.verify_token": verifyToken, "hub.challenge": challenge });
  } catch {
    result = undefined;
  }
  if (typeof result === "string") {
    logger.info("WhatsApp webhook verified by Meta");
    res.status(200).send(result);
  } else {
    res.status(403).json({ error: "Verification failed" });
  }
});

// Register the inbound-message handler once at module load.
Whatsapp.on.message = async ({ phoneID, from, message, name, reply }) => {
  try {
    await handleInboundMessage(phoneID, from, message as unknown as ServerMessage, name, reply);
  } catch (err) {
    logger.error({ err }, "WhatsApp inbound message handling error");
  }
};

// Register the delivery-status handler once at module load.
Whatsapp.on.status = async ({ status, id, error }) => {
  if (status === "failed") {
    const errCode = error?.code;
    const errDetails = error?.error_data?.details;
    logger.error({ id, status, error }, "WhatsApp message delivery FAILED");

    let failureReason = "فشل تسليم رسالة واتساب";
    if (errCode === 131042) {
      failureReason = "⚠️ فواتير واتساب بيزنس غير مسددة — يرجى تسوية الفاتورة على Meta Business لاستئناف إرسال الرسائل.";
    } else if (errCode === 131026) {
      failureReason = "رقم المستلم غير مسجل على واتساب";
    } else if (errCode === 131047) {
      failureReason = "انتهت نافذة المحادثة (24 ساعة)";
    } else if (errDetails) {
      failureReason = errDetails;
    }
    broadcastWaEvent({ type: "delivery_failed", waMessageId: id, reason: failureReason, codes: errCode ? [errCode] : [] } as { type: string; phone?: string });

    try {
      await db.delete(whatsappChatsTable).where(eq(whatsappChatsTable.waMessageId, id));
      logger.info({ waMessageId: id }, "Removed chat records for failed WhatsApp delivery");
    } catch (delErr) {
      logger.warn({ err: delErr, waMessageId: id }, "Could not remove failed delivery chat records");
    }
  } else {
    logger.info({ id, status }, "WhatsApp status update");
  }
};

router.post("/webhook/whatsapp", async (req: Request & { rawBody?: string }, res): Promise<void> => {
  res.sendStatus(200);
  try {
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    if (req.rawBody && signature) {
      await Whatsapp.post(req.body, req.rawBody, signature);
    } else {
      // No app secret configured — process without signature verification.
      await Whatsapp.post(req.body);
    }
  } catch (err) {
    logger.error({ err }, "WhatsApp webhook processing error");
  }
});

interface ServerMessage {
  id: string; from: string; type: string; timestamp: string;
  text?: { body: string };
  image?: { id?: string; caption?: string; mime_type?: string };
  document?: { id?: string; filename?: string; mime_type?: string };
  audio?: { id?: string; mime_type?: string };
  video?: { id?: string; caption?: string; mime_type?: string };
}

async function handleInboundMessage(
  phoneID: string,
  phone: string,
  msg: ServerMessage,
  senderName: string | undefined,
  reply: (message: import("whatsapp-api-js/types").ClientMessage) => Promise<unknown>,
): Promise<void> {
  const waMessageId = msg.id;

  let body: string;
  let mediaId: string | null = null;
  let mediaType: string | null = null;
  let mimeType: string | null = null;
  let filename: string | null = null;

  if (msg.type === "text" && msg.text) {
    body = msg.text.body;
  } else if (msg.type === "image" && msg.image) {
    body = `[صورة مرسلة]${msg.image.caption ? " — " + msg.image.caption : ""}`;
    mediaId = msg.image.id ?? null; mediaType = "image"; mimeType = msg.image.mime_type ?? null;
  } else if (msg.type === "document" && msg.document) {
    body = `[مستند: ${msg.document.filename ?? "ملف"}]`;
    mediaId = msg.document.id ?? null; mediaType = "document";
    mimeType = msg.document.mime_type ?? null; filename = msg.document.filename ?? null;
  } else if (msg.type === "audio" && msg.audio) {
    body = "[رسالة صوتية]";
    mediaId = msg.audio.id ?? null; mediaType = "audio"; mimeType = msg.audio.mime_type ?? null;
  } else if (msg.type === "video" && msg.video) {
    body = `[فيديو]${msg.video.caption ? " — " + msg.video.caption : ""}`;
    mediaId = msg.video.id ?? null; mediaType = "video"; mimeType = msg.video.mime_type ?? null;
  } else {
    body = `[رسالة من نوع: ${msg.type}]`;
  }

  const allSuppliers = await db.select().from(suppliersTable);
  const matchedSupplier = allSuppliers.find(s => {
    if (!s.phone) return false;
    const normalized = s.phone.replace(/[\s\-()]/g, "").replace(/^\+/, "");
    return normalized === phone || normalized.endsWith(phone) || phone.endsWith(normalized);
  });

  const existing = await db.select({ id: whatsappChatsTable.id })
    .from(whatsappChatsTable).where(eq(whatsappChatsTable.waMessageId, waMessageId)).limit(1);
  if (existing.length > 0) return;

  await db.insert(whatsappChatsTable).values({
    waMessageId, direction: "inbound", phone,
    supplierId: matchedSupplier?.id ?? null,
    body, mediaId, mediaType, mimeType, filename, isRead: false,
  });

  try {
    await Whatsapp.markAsRead(phoneID, waMessageId);
  } catch {
    // non-critical
  }
  logger.info({ phone, senderName, supplierId: matchedSupplier?.id, body: body.slice(0, 80) }, "WhatsApp inbound message saved");

  // Push real-time event to all SSE-connected browser clients
  broadcastWaEvent({ type: "new_message", phone });

  if (!matchedSupplier) {
    try {
      const { Text } = await import("whatsapp-api-js/messages");
      await reply(new Text(`شكراً للتواصل مع قرطبة للتوريدات.\n\nلم نتمكن من التعرف على رقمك في سجلاتنا. يرجى التواصل مباشرة مع فريق المشتريات.`));
    } catch (err) {
      logger.warn({ err }, "Could not send auto-reply to unknown sender");
    }
  }
}

// ─── GET /api/whatsapp/media/:mediaId ────────────────────────────────────
router.get("/whatsapp/media/:mediaId", requireAuth, async (req, res): Promise<void> => {
  const { mediaId } = req.params;
  if (!isWhatsAppConfigured) { res.status(500).json({ error: "WhatsApp not configured" }); return; }
  try {
    const metaRes = await Whatsapp.$$apiFetch$$(`https://graph.facebook.com/${WA_API_VERSION}/${mediaId}`);
    const meta = await metaRes.json() as { url?: string; mime_type?: string };
    if (!meta.url) { res.status(404).json({ error: "Media not found" }); return; }
    const mediaRes = await Whatsapp.$$apiFetch$$(meta.url);
    const contentType = meta.mime_type || mediaRes.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await mediaRes.arrayBuffer());
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(buffer);
  } catch (err) {
    logger.error({ err, mediaId }, "Failed to proxy WhatsApp media");
    res.status(500).json({ error: "Failed to fetch media" });
  }
});

// ─── GET /api/whatsapp/profile-picture/:phone ─────────────────────────────
router.get("/whatsapp/profile-picture/:phone", requireAuth, async (req, res): Promise<void> => {
  const phone = req.params.phone;
  if (!isWhatsAppConfigured) { res.status(404).json({ error: "Not configured" }); return; }
  try {
    const contactRes = await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/contacts?wa_id=${phone}&fields=profile_picture_url`
    );
    const contactData = await contactRes.json() as { data?: Array<{ profile_picture_url?: string }> };
    const picUrl = contactData.data?.[0]?.profile_picture_url;
    if (!picUrl) { res.status(404).json({ error: "No profile picture" }); return; }
    const imgRes = await Whatsapp.$$apiFetch$$(picUrl);
    if (!imgRes.ok) { res.status(404).json({ error: "Image not available" }); return; }
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    res.setHeader("Content-Type", imgRes.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(buffer);
  } catch (err) {
    logger.warn({ err, phone }, "Failed to fetch WhatsApp profile picture");
    res.status(404).json({ error: "Failed to fetch profile picture" });
  }
});

// ─── GET /api/whatsapp/chats ──────────────────────────────────────────────
router.get("/whatsapp/chats", async (req, res): Promise<void> => {
  const rows = await db
    .select({
      phone: whatsappChatsTable.phone,
      supplierId: whatsappChatsTable.supplierId,
      supplierName: suppliersTable.name,
      lastMessage: sql<string>`(array_agg(${whatsappChatsTable.body} ORDER BY ${whatsappChatsTable.createdAt} DESC))[1]`,
      lastAt: sql<Date>`MAX(${whatsappChatsTable.createdAt})`,
      lastInboundAt: sql<Date | null>`MAX(${whatsappChatsTable.createdAt}) FILTER (WHERE ${whatsappChatsTable.direction} = 'inbound')`,
      unread: sql<number>`COUNT(*) FILTER (WHERE ${whatsappChatsTable.direction} = 'inbound' AND ${whatsappChatsTable.isRead} = false)`,
    })
    .from(whatsappChatsTable)
    .leftJoin(suppliersTable, eq(whatsappChatsTable.supplierId, suppliersTable.id))
    .groupBy(whatsappChatsTable.phone, whatsappChatsTable.supplierId, suppliersTable.name)
    .orderBy(sql`MAX(${whatsappChatsTable.createdAt}) DESC`);
  res.json(rows);
});

// ─── GET /api/whatsapp/chats/:phone ──────────────────────────────────────
router.get("/whatsapp/chats/:phone", async (req, res): Promise<void> => {
  const phone = req.params.phone;
  const messages = await db
    .select().from(whatsappChatsTable)
    .where(eq(whatsappChatsTable.phone, phone))
    .orderBy(desc(whatsappChatsTable.createdAt)).limit(100);
  await db.update(whatsappChatsTable).set({ isRead: true }).where(eq(whatsappChatsTable.phone, phone));
  res.json(messages.reverse());
});

// ─── POST /api/whatsapp/send ──────────────────────────────────────────────
router.post("/whatsapp/send", async (req, res): Promise<void> => {
  const { phone, message, supplierId } = req.body as { phone: string; message: string; supplierId?: number };
  if (!phone || !message) { res.status(400).json({ error: "phone and message are required" }); return; }
  const normalized = normalizePhone(phone);
  let outboundWaId: string | null = null;
  try {
    outboundWaId = await sendWhatsAppText(phone, message);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, phone: normalized }, "WhatsApp send failed");
    let userMessage = "فشل إرسال الرسالة عبر WhatsApp.";
    if (errMsg.includes("131047")) userMessage = "انتهت نافذة المحادثة (24 ساعة). لا يمكن إرسال رسائل حرة بعد 24 ساعة من آخر رسالة من المورد.";
    else if (errMsg.includes("131026")) userMessage = "رقم الهاتف غير مسجل على WhatsApp.";
    res.status(400).json({ error: userMessage, detail: errMsg });
    return;
  }
  await db.insert(whatsappChatsTable).values({
    waMessageId: outboundWaId,
    direction: "outbound", phone: normalized,
    supplierId: supplierId ?? null, body: message, isRead: true,
  });
  res.json({ ok: true });
});

// ─── POST /api/whatsapp/send-media ────────────────────────────────────────
router.post("/whatsapp/send-media", async (req, res): Promise<void> => {
  const { phone, supplierId, base64, mimeType: fileMime, filename: fileFilename } = req.body as {
    phone: string; supplierId?: number; base64: string; mimeType: string; filename?: string;
  };
  if (!phone || !base64 || !fileMime) { res.status(400).json({ error: "phone, base64, and mimeType are required" }); return; }
  if (!isWhatsAppConfigured) { res.status(500).json({ error: "WhatsApp not configured" }); return; }
  try {
    const buffer = Buffer.from(base64, "base64");
    const blob = new Blob([buffer], { type: fileMime });
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", fileMime);
    form.append("file", blob, fileFilename || "file");
    const uploadRes = await Whatsapp.$$apiFetch$$(`https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/media`, {
      method: "POST", body: form,
    });
    const uploadData = await uploadRes.json() as { id?: string; error?: object };
    if (!uploadRes.ok || !uploadData.id) {
      req.log.error({ uploadData }, "WhatsApp media upload failed");
      res.status(500).json({ error: "Failed to upload media to WhatsApp" }); return;
    }
    const mediaType = fileMime.startsWith("image/") ? "image"
      : fileMime.startsWith("video/") ? "video"
      : fileMime.startsWith("audio/") ? "audio"
      : "document";

    const { Image, Video, Audio, Document: WADocument } = await import("whatsapp-api-js/messages");
    const message = mediaType === "image" ? new Image(uploadData.id, true)
      : mediaType === "video" ? new Video(uploadData.id, true)
      : mediaType === "audio" ? new Audio(uploadData.id, true)
      : new WADocument(uploadData.id, true, undefined, fileFilename || "document");

    const normalized = normalizePhone(phone);
    const sendResult = await Whatsapp.sendMessage(WA_PHONE_ID, normalized, message);
    if ("error" in sendResult && sendResult.error) {
      req.log.error({ sendResult }, "WhatsApp send media failed");
      res.status(500).json({ error: "Failed to send media" }); return;
    }
    const outboundWaId = sendResult.messages?.[0]?.id ?? null;
    const bodyText = mediaType === "image" ? `[صورة: ${fileFilename || "image"}]`
      : mediaType === "video" ? `[فيديو: ${fileFilename || "video"}]`
      : mediaType === "audio" ? `[صوت: ${fileFilename || "audio"}]`
      : `[مستند: ${fileFilename || "file"}]`;
    await db.insert(whatsappChatsTable).values({
      waMessageId: outboundWaId,
      direction: "outbound", phone: normalized,
      supplierId: supplierId ?? null, body: bodyText,
      mediaId: uploadData.id, mediaType, mimeType: fileMime,
      filename: fileFilename ?? null, isRead: true,
    });
    logger.info({ phone: normalized, mediaType, filename: fileFilename }, "WhatsApp media sent");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Error in send-media");
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── PATCH /api/whatsapp/messages/:id ────────────────────────────────────
router.patch("/whatsapp/messages/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { body } = req.body as { body: string };
  if (!body?.trim()) { res.status(400).json({ error: "body is required" }); return; }
  const [updated] = await db.update(whatsappChatsTable)
    .set({ body: body.trim() }).where(eq(whatsappChatsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

// ─── DELETE /api/whatsapp/messages/:id ───────────────────────────────────
router.delete("/whatsapp/messages/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [msg] = await db.select().from(whatsappChatsTable).where(eq(whatsappChatsTable.id, id)).limit(1);
  if (!msg) { res.status(404).json({ error: "Not found" }); return; }

  let waDeletedOnPlatform = false;
  if (isWhatsAppConfigured && msg.waMessageId && msg.direction === "outbound") {
    try {
      const waDelRes = await Whatsapp.$$apiFetch$$(
        `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/messages/${msg.waMessageId}`,
        { method: "DELETE" }
      );
      const waDelData = await waDelRes.json() as { success?: boolean; error?: { message?: string } };
      if (waDelRes.ok && waDelData.success) {
        waDeletedOnPlatform = true;
        logger.info({ msgId: msg.waMessageId }, "WhatsApp message deleted for all participants");
      } else {
        logger.warn({ waDelData, msgId: msg.waMessageId }, "WhatsApp delete API rejected");
      }
    } catch (err) {
      logger.warn({ err }, "Error calling WhatsApp delete API — removing from DB only");
    }
  }

  await db.delete(whatsappChatsTable).where(eq(whatsappChatsTable.id, id));
  res.json({ ok: true, waDeletedOnPlatform });
});

// ─── POST /api/whatsapp/test-send (debug only) ────────────────────────────
router.post("/whatsapp/test-send", requireAuth, async (req, res): Promise<void> => {
  const { phone } = req.body as { phone: string };
  if (!phone) { res.status(400).json({ error: "phone required" }); return; }
  if (!isWhatsAppConfigured) { res.status(500).json({ error: "WhatsApp not configured" }); return; }

  const normalized = normalizePhone(phone);
  const { Text, Template, Language, BodyComponent, BodyParameter, URLComponent } = await import("whatsapp-api-js/messages");

  const textResult = await Whatsapp.sendMessage(WA_PHONE_ID, normalized, new Text("اختبار اتصال واتساب", false));

  const templateName = process.env.WHATSAPP_TEMPLATE_TEXT || "rfq_send_ar";
  const template = new Template(
    templateName,
    new Language("ar"),
    new BodyComponent(
      new BodyParameter("مورد تجريبي"),
      new BodyParameter("CRQ-TEST"),
      new BodyParameter("اختبار"),
      new BodyParameter("2026-06-30"),
      new BodyParameter("مسؤول التسعير"),
    ),
    new URLComponent("test"),
  );
  const templateResult = await Whatsapp.sendMessage(WA_PHONE_ID, normalized, template);

  res.json({
    phone_input: phone,
    phone_normalized: normalized,
    plain_text: textResult,
    [`template_${templateName}`]: templateResult,
  });
});

// ─── GET /api/whatsapp/diagnose ───────────────────────────────────────────
router.get("/whatsapp/diagnose", requireAuth, async (req, res): Promise<void> => {
  const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || "ar";
  const TEMPLATE_NAMES = [
    process.env.WHATSAPP_TEMPLATE_PDF     || "rfq_pdf_ar",
    process.env.WHATSAPP_TEMPLATE_TEXT    || "rfq_send_ar",
    process.env.WHATSAPP_TEMPLATE_UTILITY || "rfq_utility_ar",
  ];

  if (!isWhatsAppConfigured) {
    res.json({ configured: false, error: "Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_TOKEN" });
    return;
  }

  // 1. Phone number details
  let phoneInfo: Record<string, unknown> = {};
  try {
    const r = await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}?fields=display_phone_number,verified_name,quality_rating,status,platform_type`
    );
    phoneInfo = await r.json() as Record<string, unknown>;
  } catch (e) {
    phoneInfo = { error: String(e) };
  }

  // 2. Template status (needs WABA_ID)
  let templates: Record<string, unknown> = {};
  if (WABA_ID) {
    try {
      const r = await Whatsapp.$$apiFetch$$(
        `https://graph.facebook.com/${WA_API_VERSION}/${WABA_ID}/message_templates?limit=30&fields=name,status,quality_score,language,category`
      );
      const data = await r.json() as { data?: Array<{ name: string; status: string; language: string; category?: string; quality_score?: unknown }> };
      const all = data.data ?? [];
      const ourTemplates = all.filter(t => TEMPLATE_NAMES.includes(t.name) || t.language === TEMPLATE_LANG);
      templates = {
        total: all.length,
        our_templates: ourTemplates,
        all_names: all.map(t => ({ name: t.name, status: t.status, lang: t.language })),
      };
    } catch (e) {
      templates = { error: String(e) };
    }
  } else {
    templates = { warning: "WHATSAPP_BUSINESS_ACCOUNT_ID not set — cannot check template status" };
  }

  // 3. Credentials summary (no secrets exposed)
  const creds = {
    WHATSAPP_PHONE_NUMBER_ID: WA_PHONE_ID ? "✓ set (" + WA_PHONE_ID.slice(0, 5) + "...)" : "✗ missing",
    WHATSAPP_TOKEN: WA_TOKEN ? "✓ set (length=" + WA_TOKEN.length + ")" : "✗ missing",
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET ? "✓ set (signature verification enabled)" : "✗ missing — webhook signature verification disabled",
    WHATSAPP_BUSINESS_ACCOUNT_ID: WABA_ID ? "✓ set" : "✗ missing — add this env var to check template status",
    WHATSAPP_VERIFY_TOKEN: WEBHOOK_VERIFY_TOKEN ? "✓ set" : "✗ missing",
    template_names: TEMPLATE_NAMES,
    template_lang: TEMPLATE_LANG,
    library: "whatsapp-api-js v6 (open-source, official Meta Cloud API wrapper)",
  };

  res.json({ configured: true, phone: phoneInfo, templates, creds });
});

export default router;
