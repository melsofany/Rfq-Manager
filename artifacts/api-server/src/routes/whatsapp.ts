import { Router } from "express";
import { db, suppliersTable, whatsappChatsTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { sendWhatsAppText, markWhatsAppRead } from "../lib/whatsapp";
import { requireAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";

const router = Router();

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_API_VERSION = "v22.0";

function normalizePhone(phone: string): string {
  let cleaned = phone.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);
  if (cleaned.length === 11 && cleaned.startsWith("0")) cleaned = "2" + cleaned;
  if (cleaned.length === 10 && cleaned.startsWith("1")) cleaned = "20" + cleaned;
  return cleaned;
}

// ─── GET /api/webhook/whatsapp ────────────────────────────────────────────
router.get("/webhook/whatsapp", (req, res): void => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    logger.info("WhatsApp webhook verified by Meta");
    res.status(200).send(challenge);
    return;
  }
  res.status(403).json({ error: "Verification failed" });
});

// ─── POST /api/webhook/whatsapp ───────────────────────────────────────────
router.post("/webhook/whatsapp", async (req, res): Promise<void> => {
  res.sendStatus(200);
  try {
    const body = req.body as WhatsAppWebhookPayload;
    if (body.object !== "whatsapp_business_account") return;
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;
        for (const msg of value.messages ?? []) await handleInboundMessage(msg, value.contacts ?? []);
        for (const status of value.statuses ?? []) logger.info({ id: status.id, status: status.status }, "WhatsApp status update");
      }
    }
  } catch (err) {
    logger.error({ err }, "WhatsApp webhook processing error");
  }
});

async function handleInboundMessage(msg: WAMessage, contacts: WAContact[]): Promise<void> {
  const phone = msg.from;
  const waMessageId = msg.id;
  const contact = contacts.find(c => c.wa_id === phone);
  const senderName = contact?.profile?.name ?? phone;

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

  await markWhatsAppRead(waMessageId);
  logger.info({ phone, senderName, supplierId: matchedSupplier?.id, body: body.slice(0, 80) }, "WhatsApp inbound message saved");

  if (!matchedSupplier) {
    try {
      await sendWhatsAppText(phone, `شكراً للتواصل مع قرطبة للتوريدات.\n\nلم نتمكن من التعرف على رقمك في سجلاتنا. يرجى التواصل مباشرة مع فريق المشتريات.`);
    } catch (err) {
      logger.warn({ err }, "Could not send auto-reply to unknown sender");
    }
  }
}

// ─── GET /api/whatsapp/media/:mediaId ────────────────────────────────────
router.get("/whatsapp/media/:mediaId", requireAuth, async (req, res): Promise<void> => {
  const { mediaId } = req.params;
  if (!WA_TOKEN) { res.status(500).json({ error: "WhatsApp not configured" }); return; }
  try {
    const metaRes = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
    });
    const meta = await metaRes.json() as { url?: string; mime_type?: string };
    if (!meta.url) { res.status(404).json({ error: "Media not found" }); return; }
    const mediaRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
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
  if (!WA_TOKEN || !WA_PHONE_ID) { res.status(404).json({ error: "Not configured" }); return; }
  try {
    const contactRes = await fetch(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/contacts?wa_id=${phone}&fields=profile_picture_url`,
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
    );
    const contactData = await contactRes.json() as { data?: Array<{ profile_picture_url?: string }> };
    const picUrl = contactData.data?.[0]?.profile_picture_url;
    if (!picUrl) { res.status(404).json({ error: "No profile picture" }); return; }
    const imgRes = await fetch(picUrl, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
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
    // sendWhatsAppText now returns the wamid so we can delete the message later
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
  if (!WA_TOKEN || !WA_PHONE_ID) { res.status(500).json({ error: "WhatsApp not configured" }); return; }
  try {
    const buffer = Buffer.from(base64, "base64");
    const blob = new Blob([buffer], { type: fileMime });
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", fileMime);
    form.append("file", blob, fileFilename || "file");
    const uploadRes = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/media`, {
      method: "POST", headers: { Authorization: `Bearer ${WA_TOKEN}` }, body: form,
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
    const msgBody: Record<string, unknown> = { messaging_product: "whatsapp", to: normalizePhone(phone), type: mediaType };
    if (mediaType === "image") msgBody.image = { id: uploadData.id };
    else if (mediaType === "document") msgBody.document = { id: uploadData.id, filename: fileFilename || "document" };
    else if (mediaType === "audio") msgBody.audio = { id: uploadData.id };
    else if (mediaType === "video") msgBody.video = { id: uploadData.id };
    const sendRes = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(msgBody),
    });
    const sendData = await sendRes.json() as { messages?: { id: string }[]; error?: object };
    if (!sendRes.ok) {
      req.log.error({ sendData }, "WhatsApp send media failed");
      res.status(500).json({ error: "Failed to send media" }); return;
    }
    const outboundWaId = sendData.messages?.[0]?.id ?? null;
    const normalized = normalizePhone(phone);
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

// ─── PATCH /api/whatsapp/messages/:id — edit body (local only) ────────────
// No requireAuth: consistent with other WA endpoints; session-based auth handled by app middleware
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
// Deletes from our DB and attempts WhatsApp-side delete (for recent outbound messages with waMessageId)
router.delete("/whatsapp/messages/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [msg] = await db.select().from(whatsappChatsTable).where(eq(whatsappChatsTable.id, id)).limit(1);
  if (!msg) { res.status(404).json({ error: "Not found" }); return; }

  // Attempt WhatsApp-side deletion for outbound messages with a known wamid
  let waDeletedOnPlatform = false;
  if (WA_TOKEN && WA_PHONE_ID && msg.waMessageId && msg.direction === "outbound") {
    try {
      const waDelRes = await fetch(
        `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/messages/${msg.waMessageId}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${WA_TOKEN}` } }
      );
      const waDelData = await waDelRes.json() as { success?: boolean; error?: { message?: string } };
      if (waDelRes.ok && waDelData.success) {
        waDeletedOnPlatform = true;
        logger.info({ msgId: msg.waMessageId }, "WhatsApp message deleted for all participants");
      } else {
        logger.warn({ waDelData, msgId: msg.waMessageId }, "WhatsApp delete API rejected (message may be > 60s old or already deleted)");
      }
    } catch (err) {
      logger.warn({ err }, "Error calling WhatsApp delete API — removing from DB only");
    }
  }

  // Always delete from our DB regardless of WhatsApp API result
  await db.delete(whatsappChatsTable).where(eq(whatsappChatsTable.id, id));
  res.json({ ok: true, waDeletedOnPlatform });
});

// ─── Types ────────────────────────────────────────────────────────────────
interface WhatsAppWebhookPayload {
  object: string;
  entry?: Array<{ id: string; changes?: Array<{ value?: WAValue; field: string }> }>;
}
interface WAValue {
  messaging_product: string; messages?: WAMessage[]; statuses?: WAStatus[]; contacts?: WAContact[];
}
interface WAMessage {
  id: string; from: string; type: string; timestamp: string;
  text?: { body: string };
  image?: { id?: string; caption?: string; mime_type?: string };
  document?: { id?: string; filename?: string; mime_type?: string };
  audio?: { id?: string; mime_type?: string };
  video?: { id?: string; caption?: string; mime_type?: string };
}
interface WAStatus { id: string; status: string; timestamp: string; recipient_id: string; }
interface WAContact { wa_id: string; profile?: { name?: string }; }


  // ─── POST /api/whatsapp/test-send (debug only) ────────────────────────────
  router.post("/whatsapp/test-send", requireAuth, async (req, res): Promise<void> => {
    const { phone } = req.body as { phone: string };
    if (!phone) { res.status(400).json({ error: "phone required" }); return; }

    const normalized = normalizePhone(phone);
    const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const TOKEN = process.env.WHATSAPP_TOKEN;

    if (!PHONE_ID || !TOKEN) { res.status(500).json({ error: "WhatsApp not configured" }); return; }

    const url = `https://graph.facebook.com/v22.0/${PHONE_ID}/messages`;

    // Test 1: plain text (will fail if outside 24h window)
    const r1 = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: normalized, type: "text", text: { body: "اختبار اتصال واتساب", preview_url: false } }),
    });
    const d1 = await r1.json();

    // Test 2: rfq_send_ar template
    const r2 = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to: normalized, type: "template",
        template: {
          name: "rfq_send_ar", language: { code: "ar" },
          components: [
            { type: "body", parameters: [
              { type: "text", text: "مورد تجريبي" },
              { type: "text", text: "CRQ-TEST" },
              { type: "text", text: "اختبار" },
              { type: "text", text: "2026-06-30" },
              { type: "text", text: "مسؤول التسعير" },
            ]},
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "test" }] },
          ],
        },
      }),
    });
    const d2 = await r2.json();

    res.json({
      phone_input: phone,
      phone_normalized: normalized,
      plain_text: { status: r1.status, body: d1 },
      template_rfq_send_ar: { status: r2.status, body: d2 },
    });
  });

  export default router;
