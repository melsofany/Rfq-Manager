import { Router, type Request, type Response } from "express";
import {
  db,
  suppliersTable,
  whatsappChatsTable,
  whatsappReactionsTable,
  whatsappMediaTable,
} from "@workspace/db";
import { eq, desc, sql, and, inArray } from "drizzle-orm";
import {
  Whatsapp,
  PHONE_NUMBER_ID,
  WEBHOOK_VERIFY_TOKEN,
  isWhatsAppConfigured,
  sendWhatsAppText,
} from "./service";
import { requireAuth } from "../../middlewares/auth";
import { logger } from "../../shared/logger";

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

export function broadcastWaEvent(event: { type: string; phone?: string; [key: string]: unknown }) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      (client as Response).write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

router.get("/whatsapp/events", requireAuth, (req, res): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const hb = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(hb);
      sseClients.delete(res);
    }
  }, 25000);
  sseClients.add(res);
  req.on("close", () => {
    clearInterval(hb);
    sseClients.delete(res);
  });
});

// ─── Webhook GET: Meta subscription handshake ─────────────────────────────
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
    result = Whatsapp.get({
      "hub.mode": mode,
      "hub.verify_token": verifyToken,
      "hub.challenge": challenge,
    });
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
    const msg = message as unknown as ServerMessage;
    if (msg.type === "reaction") {
      await handleReactionWebhook(from, msg);
    } else {
      await handleInboundMessage(phoneID, from, msg, name, reply);
    }
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
      failureReason =
        "⚠️ فواتير واتساب بيزنس غير مسددة — يرجى تسوية الفاتورة على Meta Business لاستئناف إرسال الرسائل.";
    } else if (errCode === 131026) {
      failureReason = "رقم المستلم غير مسجل على واتساب";
    } else if (errCode === 131047) {
      failureReason = "انتهت نافذة المحادثة (24 ساعة)";
    } else if (errDetails) {
      failureReason = errDetails;
    }
    broadcastWaEvent({
      type: "delivery_failed",
      waMessageId: id,
      reason: failureReason,
      codes: errCode ? [errCode] : [],
    });

    try {
      await db.delete(whatsappChatsTable).where(eq(whatsappChatsTable.waMessageId, id));
      logger.info({ waMessageId: id }, "Removed chat records for failed WhatsApp delivery");
    } catch (delErr) {
      logger.warn(
        { err: delErr, waMessageId: id },
        "Could not remove failed delivery chat records",
      );
    }
  } else {
    logger.info({ id, status }, "WhatsApp status update");
  }
};

router.post(
  "/webhook/whatsapp",
  async (req: Request & { rawBody?: string }, res): Promise<void> => {
    res.sendStatus(200);
    try {
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      if (req.rawBody && signature) {
        await Whatsapp.post(req.body, req.rawBody, signature);
      } else {
        await Whatsapp.post(req.body);
      }
    } catch (err) {
      logger.error({ err }, "WhatsApp webhook processing error");
    }
  },
);

interface ServerMessage {
  id: string;
  from: string;
  type: string;
  timestamp: string;
  text?: { body: string };
  image?: { id?: string; caption?: string; mime_type?: string };
  document?: { id?: string; filename?: string; mime_type?: string };
  audio?: { id?: string; mime_type?: string };
  video?: { id?: string; caption?: string; mime_type?: string };
  reaction?: { message_id: string; emoji: string };
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
    mediaId = msg.image.id ?? null;
    mediaType = "image";
    mimeType = msg.image.mime_type ?? null;
  } else if (msg.type === "document" && msg.document) {
    body = `[مستند: ${msg.document.filename ?? "ملف"}]`;
    mediaId = msg.document.id ?? null;
    mediaType = "document";
    mimeType = msg.document.mime_type ?? null;
    filename = msg.document.filename ?? null;
  } else if (msg.type === "audio" && msg.audio) {
    body = "[رسالة صوتية]";
    mediaId = msg.audio.id ?? null;
    mediaType = "audio";
    mimeType = msg.audio.mime_type ?? null;
  } else if (msg.type === "video" && msg.video) {
    body = `[فيديو]${msg.video.caption ? " — " + msg.video.caption : ""}`;
    mediaId = msg.video.id ?? null;
    mediaType = "video";
    mimeType = msg.video.mime_type ?? null;
  } else {
    body = `[رسالة من نوع: ${msg.type}]`;
  }

  const allSuppliers = await db.select().from(suppliersTable);
  const matchedSupplier = allSuppliers.find((s) => {
    if (!s.phone) return false;
    const normalized = s.phone.replace(/[\s\-()]/g, "").replace(/^\+/, "");
    return normalized === phone || normalized.endsWith(phone) || phone.endsWith(normalized);
  });

  const existing = await db
    .select({ id: whatsappChatsTable.id })
    .from(whatsappChatsTable)
    .where(eq(whatsappChatsTable.waMessageId, waMessageId))
    .limit(1);
  if (existing.length > 0) return;

  await db.insert(whatsappChatsTable).values({
    waMessageId,
    direction: "inbound",
    phone,
    supplierId: matchedSupplier?.id ?? null,
    body,
    mediaId,
    mediaType,
    mimeType,
    filename,
    isRead: false,
  });

  try {
    await Whatsapp.markAsRead(phoneID, waMessageId);
  } catch {
    /* non-critical */
  }

  // Cache media binary in background so it survives Meta's 30-day expiry
  if (mediaId) {
    void downloadAndStoreMedia(mediaId, mimeType ?? "application/octet-stream");
  }

  logger.info(
    { from: phone, type: msg.type, supplier: matchedSupplier?.name },
    "WhatsApp inbound message saved",
  );
  broadcastWaEvent({ type: "new_message", phone, senderName });
  void reply;
}

// ─── Background: download + store media binary ─────────────────────────
async function downloadAndStoreMedia(mediaId: string, fallbackMime: string): Promise<void> {
  try {
    // Skip if already cached
    const existing = await db
      .select({ waMediaId: whatsappMediaTable.waMediaId })
      .from(whatsappMediaTable)
      .where(eq(whatsappMediaTable.waMediaId, mediaId))
      .limit(1);
    if (existing.length > 0) return;

    const metaRes = await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${mediaId}`,
    );
    if (!metaRes.ok) return;
    const metaData = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!metaData.url) return;

    const mediaRes = await Whatsapp.$$apiFetch$$(metaData.url);
    if (!mediaRes.ok) return;
    const buffer = Buffer.from(await mediaRes.arrayBuffer());

    await db
      .insert(whatsappMediaTable)
      .values({
        waMediaId: mediaId,
        data: buffer,
        mimeType: metaData.mime_type ?? fallbackMime,
      })
      .onConflictDoNothing();

    logger.info({ mediaId, bytes: buffer.length }, "WhatsApp media cached to DB");
  } catch (err) {
    logger.warn({ err, mediaId }, "Background media cache failed (non-critical)");
  }
}

// ─── Handle reaction webhook ──────────────────────────────────────────────
async function handleReactionWebhook(from: string, msg: ServerMessage): Promise<void> {
  const phone = normalizePhone(from);
  const reaction = msg.reaction;
  if (!reaction) return;
  const { message_id: waMessageId, emoji } = reaction;

  if (!emoji || emoji.trim() === "") {
    // Remove reaction
    await db
      .delete(whatsappReactionsTable)
      .where(
        and(
          eq(whatsappReactionsTable.waMessageId, waMessageId),
          eq(whatsappReactionsTable.reactorPhone, phone),
        ),
      );
  } else {
    // Upsert reaction
    await db
      .insert(whatsappReactionsTable)
      .values({
        waMessageId,
        reactorPhone: phone,
        emoji,
      })
      .onConflictDoUpdate({
        target: [whatsappReactionsTable.waMessageId, whatsappReactionsTable.reactorPhone],
        set: { emoji },
      });
  }
  broadcastWaEvent({ type: "reaction", waMessageId, reactorPhone: phone, emoji });
  logger.info({ waMessageId, phone, emoji }, "WhatsApp reaction processed");
}

// ─── GET /api/whatsapp/media/:mediaId ────────────────────────────────────
router.get("/whatsapp/media/:mediaId", requireAuth, async (req, res): Promise<void> => {
  const { mediaId } = req.params;
  if (!isWhatsAppConfigured) {
    res.status(503).json({ error: "WhatsApp not configured" });
    return;
  }
  try {
    // Try DB cache first (avoids Meta 30-day expiry)
    const cached = await db
      .select()
      .from(whatsappMediaTable)
      .where(eq(whatsappMediaTable.waMediaId, mediaId))
      .limit(1);
    if (cached.length > 0) {
      res.setHeader("Content-Type", cached[0].mimeType);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.send(cached[0].data);
      return;
    }

    // Fallback: fetch from Meta and store for next time
    const metaRes = await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${mediaId}`,
    );
    const metaData = (await metaRes.json()) as { url?: string; mime_type?: string; error?: object };
    if (!metaRes.ok || !metaData.url) {
      res.status(404).json({ error: "Media not found", detail: metaData.error });
      return;
    }
    const mediaRes = await Whatsapp.$$apiFetch$$(metaData.url);
    if (!mediaRes.ok) {
      res.status(404).json({ error: "Media download failed" });
      return;
    }
    const buffer = Buffer.from(await mediaRes.arrayBuffer());
    const mime = metaData.mime_type || "application/octet-stream";

    // Store in DB (fire-and-forget)
    void db
      .insert(whatsappMediaTable)
      .values({ waMediaId: mediaId, data: buffer, mimeType: mime })
      .onConflictDoNothing();

    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(buffer);
  } catch (err) {
    logger.error({ err, mediaId }, "Failed to proxy WhatsApp media");
    res.status(500).json({ error: "Failed to fetch media" });
  }
});

// ─── GET /api/whatsapp/profile-picture/:phone ─────────────────────────────
router.get("/whatsapp/profile-picture/:phone", requireAuth, async (req, res): Promise<void> => {
  const phone = req.params.phone;
  if (!isWhatsAppConfigured) {
    res.status(404).json({ error: "Not configured" });
    return;
  }
  try {
    const contactRes = await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/contacts?wa_id=${phone}&fields=profile_picture_url`,
    );
    const contactData = (await contactRes.json()) as {
      data?: Array<{ profile_picture_url?: string }>;
    };
    const picUrl = contactData.data?.[0]?.profile_picture_url;
    if (!picUrl) {
      res.status(404).json({ error: "No profile picture" });
      return;
    }
    const imgRes = await Whatsapp.$$apiFetch$$(picUrl);
    if (!imgRes.ok) {
      res.status(404).json({ error: "Image not available" });
      return;
    }
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
router.get("/whatsapp/chats", requireAuth, async (req, res): Promise<void> => {
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
router.get("/whatsapp/chats/:phone", requireAuth, async (req, res): Promise<void> => {
  const phone = req.params.phone;
  const messages = await db
    .select()
    .from(whatsappChatsTable)
    .where(eq(whatsappChatsTable.phone, phone))
    .orderBy(desc(whatsappChatsTable.createdAt))
    .limit(200);
  await db
    .update(whatsappChatsTable)
    .set({ isRead: true })
    .where(eq(whatsappChatsTable.phone, phone));

  // Attach reactions to each message
  const msgIds = messages.map((m) => m.waMessageId).filter(Boolean) as string[];
  const reactionMap = new Map<string, Array<{ reactorPhone: string; emoji: string }>>();
  if (msgIds.length > 0) {
    const reactions = await db
      .select()
      .from(whatsappReactionsTable)
      .where(inArray(whatsappReactionsTable.waMessageId, msgIds));
    for (const r of reactions) {
      const list = reactionMap.get(r.waMessageId) ?? [];
      list.push({ reactorPhone: r.reactorPhone, emoji: r.emoji });
      reactionMap.set(r.waMessageId, list);
    }
  }

  const enriched = messages.reverse().map((m) => ({
    ...m,
    reactions: m.waMessageId ? (reactionMap.get(m.waMessageId) ?? []) : [],
  }));
  res.json(enriched);
});

// ─── POST /api/whatsapp/react ─────────────────────────────────────────────
router.post("/whatsapp/react", requireAuth, async (req, res): Promise<void> => {
  const { waMessageId, toPhone, emoji } = req.body as {
    waMessageId: string;
    toPhone: string;
    emoji: string;
  };
  if (!waMessageId || !toPhone) {
    res.status(400).json({ error: "waMessageId and toPhone are required" });
    return;
  }
  if (!isWhatsAppConfigured) {
    res.status(503).json({ error: "WhatsApp not configured" });
    return;
  }
  try {
    // Send reaction via Meta API
    await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: toPhone,
          type: "reaction",
          reaction: { message_id: waMessageId, emoji: emoji ?? "" },
        }),
      },
    );

    // Persist locally (reactorPhone = "me" = our account)
    if (emoji && emoji.trim() !== "") {
      await db
        .insert(whatsappReactionsTable)
        .values({
          waMessageId,
          reactorPhone: "me",
          emoji,
        })
        .onConflictDoUpdate({
          target: [whatsappReactionsTable.waMessageId, whatsappReactionsTable.reactorPhone],
          set: { emoji },
        });
    } else {
      await db
        .delete(whatsappReactionsTable)
        .where(
          and(
            eq(whatsappReactionsTable.waMessageId, waMessageId),
            eq(whatsappReactionsTable.reactorPhone, "me"),
          ),
        );
    }

    broadcastWaEvent({ type: "reaction", waMessageId, reactorPhone: "me", emoji });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, waMessageId }, "Failed to send WhatsApp reaction");
    res.status(500).json({ error: "Failed to send reaction" });
  }
});

// ─── POST /api/whatsapp/send ──────────────────────────────────────────────
router.post("/whatsapp/send", requireAuth, async (req, res): Promise<void> => {
  const { phone, message, supplierId } = req.body as {
    phone: string;
    message: string;
    supplierId?: number;
  };
  if (!phone || !message) {
    res.status(400).json({ error: "phone and message are required" });
    return;
  }
  const normalized = normalizePhone(phone);
  let outboundWaId: string | null = null;
  try {
    outboundWaId = await sendWhatsAppText(phone, message);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, phone: normalized }, "WhatsApp send failed");
    let userMessage = "فشل إرسال الرسالة عبر WhatsApp.";
    if (errMsg.includes("131047"))
      userMessage =
        "انتهت نافذة المحادثة (24 ساعة). لا يمكن إرسال رسائل حرة بعد 24 ساعة من آخر رسالة من المورد.";
    else if (errMsg.includes("131026")) userMessage = "رقم الهاتف غير مسجل على WhatsApp.";
    res.status(400).json({ error: userMessage, detail: errMsg });
    return;
  }
  await db.insert(whatsappChatsTable).values({
    waMessageId: outboundWaId,
    direction: "outbound",
    phone: normalized,
    supplierId: supplierId ?? null,
    body: message,
    isRead: true,
  });
  res.json({ ok: true });
});

// ─── POST /api/whatsapp/send-media ────────────────────────────────────────
router.post("/whatsapp/send-media", requireAuth, async (req, res): Promise<void> => {
  const {
    phone,
    supplierId,
    base64,
    mimeType: fileMime,
    filename: fileFilename,
  } = req.body as {
    phone: string;
    supplierId?: number;
    base64: string;
    mimeType: string;
    filename?: string;
  };
  if (!phone || !base64 || !fileMime) {
    res.status(400).json({ error: "phone, base64, and mimeType are required" });
    return;
  }
  if (!isWhatsAppConfigured) {
    res.status(500).json({ error: "WhatsApp not configured" });
    return;
  }
  try {
    const buffer = Buffer.from(base64, "base64");
    const blob = new Blob([buffer], { type: fileMime });
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", fileMime);
    form.append("file", blob, fileFilename || "file");
    const uploadRes = await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/media`,
      {
        method: "POST",
        body: form,
      },
    );
    const uploadData = (await uploadRes.json()) as { id?: string; error?: object };
    if (!uploadRes.ok || !uploadData.id) {
      logger.error({ uploadData }, "WhatsApp media upload failed");
      res.status(500).json({ error: "Failed to upload media to WhatsApp" });
      return;
    }
    const mediaType = fileMime.startsWith("image/")
      ? "image"
      : fileMime.startsWith("video/")
        ? "video"
        : fileMime.startsWith("audio/")
          ? "audio"
          : "document";

    const { Image, Video, Audio, Document: WADocument } = await import("whatsapp-api-js/messages");
    const message =
      mediaType === "image"
        ? new Image(uploadData.id, true)
        : mediaType === "video"
          ? new Video(uploadData.id, true)
          : mediaType === "audio"
            ? new Audio(uploadData.id, true)
            : new WADocument(uploadData.id, true, undefined, fileFilename || "document");

    const normalized = normalizePhone(phone);
    const sendResult = await Whatsapp.sendMessage(WA_PHONE_ID, normalized, message);
    if ("error" in sendResult && sendResult.error) {
      logger.error({ sendResult }, "WhatsApp send media failed");
      res.status(500).json({ error: "Failed to send media" });
      return;
    }
    const outboundWaId = sendResult.messages?.[0]?.id ?? null;
    const bodyText =
      mediaType === "image"
        ? `[صورة: ${fileFilename || "image"}]`
        : mediaType === "video"
          ? `[فيديو: ${fileFilename || "video"}]`
          : mediaType === "audio"
            ? `[صوت: ${fileFilename || "audio"}]`
            : `[مستند: ${fileFilename || "file"}]`;
    await db.insert(whatsappChatsTable).values({
      waMessageId: outboundWaId,
      direction: "outbound",
      phone: normalized,
      supplierId: supplierId ?? null,
      body: bodyText,
      mediaId: uploadData.id,
      mediaType,
      mimeType: fileMime,
      filename: fileFilename ?? null,
      isRead: true,
    });
    logger.info({ phone: normalized, mediaType, filename: fileFilename }, "WhatsApp media sent");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Error in send-media");
    res.status(500).json({ error: "Internal error" });
  }
});

// ─── PATCH /api/whatsapp/messages/:id ────────────────────────────────────
router.patch("/whatsapp/messages/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { body } = req.body as { body: string };
  if (!body?.trim()) {
    res.status(400).json({ error: "body is required" });
    return;
  }
  const [updated] = await db
    .update(whatsappChatsTable)
    .set({ body: body.trim() })
    .where(eq(whatsappChatsTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(updated);
});

// ─── DELETE /api/whatsapp/messages/:id ───────────────────────────────────
router.delete("/whatsapp/messages/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [msg] = await db
    .select()
    .from(whatsappChatsTable)
    .where(eq(whatsappChatsTable.id, id))
    .limit(1);
  if (!msg) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  let waDeletedOnPlatform = false;
  if (isWhatsAppConfigured && msg.waMessageId && msg.direction === "outbound") {
    try {
      const waDelRes = await Whatsapp.$$apiFetch$$(
        `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/messages/${msg.waMessageId}`,
        { method: "DELETE" },
      );
      const waDelData = (await waDelRes.json()) as {
        success?: boolean;
        error?: { message?: string };
      };
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

// ─── GET /api/whatsapp/templates (Meta Business API templates) ────────────
router.get("/whatsapp/templates", requireAuth, async (req, res): Promise<void> => {
  const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!isWhatsAppConfigured) {
    res.status(503).json({ error: "WhatsApp not configured" });
    return;
  }
  if (!WABA_ID) {
    res
      .status(400)
      .json({ error: "WHATSAPP_BUSINESS_ACCOUNT_ID not set — يجب إضافة هذا المتغير البيئي" });
    return;
  }
  try {
    const r = await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${WABA_ID}/message_templates?limit=100&fields=name,status,quality_score,language,category,components`,
    );
    const data = (await r.json()) as { data?: unknown[]; error?: unknown; paging?: unknown };
    if (!r.ok) {
      res.status(500).json({ error: data.error || "Failed to fetch templates" });
      return;
    }
    res.json({ templates: data.data ?? [], paging: data.paging ?? null });
  } catch (err) {
    logger.error({ err }, "Failed to fetch WhatsApp templates");
    res.status(500).json({ error: "Failed to fetch templates from Meta" });
  }
});

// ─── POST /api/whatsapp/send-template ────────────────────────────────────
router.post("/whatsapp/send-template", requireAuth, async (req, res): Promise<void> => {
  const { phone, templateName, language, components, supplierId } = req.body as {
    phone: string;
    templateName: string;
    language?: string;
    components?: unknown[];
    supplierId?: number;
  };
  if (!phone || !templateName) {
    res.status(400).json({ error: "phone and templateName required" });
    return;
  }
  if (!isWhatsAppConfigured) {
    res.status(503).json({ error: "WhatsApp not configured" });
    return;
  }
  const normalized = normalizePhone(phone);
  try {
    const body = JSON.stringify({
      messaging_product: "whatsapp",
      to: normalized,
      type: "template",
      template: {
        name: templateName,
        language: { code: language || "ar" },
        components: components || [],
      },
    });
    const r = await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
    );
    const data = (await r.json()) as { messages?: Array<{ id: string }>; error?: unknown };
    if (!r.ok) {
      logger.error({ data, phone: normalized, templateName }, "WhatsApp template send failed");
      res.status(400).json({ error: data.error || "Failed to send template" });
      return;
    }
    const waId = data.messages?.[0]?.id ?? null;
    await db.insert(whatsappChatsTable).values({
      waMessageId: waId,
      direction: "outbound",
      phone: normalized,
      supplierId: supplierId ?? null,
      body: `[قالب: ${templateName}]`,
      isRead: true,
    });
    logger.info({ phone: normalized, templateName, waId }, "WhatsApp template sent");
    res.json({ ok: true, waMessageId: waId });
  } catch (err) {
    logger.error({ err, phone: normalized, templateName }, "Error sending WhatsApp template");
    res.status(500).json({ error: "Failed to send template" });
  }
});

// ─── GET /api/whatsapp/contacts ──────────────────────────────────────────
router.get("/whatsapp/contacts", requireAuth, async (req, res): Promise<void> => {
  try {
    const suppliers = await db
      .select()
      .from(suppliersTable)
      .where(eq(suppliersTable.isActive, true))
      .orderBy(suppliersTable.name);
    const withPhone = suppliers.filter((s) => s.phone && s.phone.trim());
    res.json(withPhone);
  } catch (err) {
    logger.error({ err }, "Failed to fetch WhatsApp contacts");
    res.status(500).json({ error: "Failed to fetch contacts" });
  }
});

// ─── GET /api/whatsapp/stats ──────────────────────────────────────────────
router.get("/whatsapp/stats", requireAuth, async (req, res): Promise<void> => {
  try {
    const [stats] = await db
      .select({
        total: sql<number>`COUNT(*)`,
        unread: sql<number>`COUNT(*) FILTER (WHERE ${whatsappChatsTable.direction} = 'inbound' AND ${whatsappChatsTable.isRead} = false)`,
        totalChats: sql<number>`COUNT(DISTINCT ${whatsappChatsTable.phone})`,
        outbound: sql<number>`COUNT(*) FILTER (WHERE ${whatsappChatsTable.direction} = 'outbound')`,
        inbound: sql<number>`COUNT(*) FILTER (WHERE ${whatsappChatsTable.direction} = 'inbound')`,
      })
      .from(whatsappChatsTable);
    res.json(stats);
  } catch (err) {
    logger.error({ err }, "Failed to fetch WhatsApp stats");
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ─── POST /api/whatsapp/broadcast ─────────────────────────────────────────
router.post("/whatsapp/broadcast", requireAuth, async (req, res): Promise<void> => {
  const { phones, message, supplierIds } = req.body as {
    phones: string[];
    message: string;
    supplierIds?: number[];
  };
  if (!phones?.length || !message?.trim()) {
    res.status(400).json({ error: "phones and message are required" });
    return;
  }
  if (!isWhatsAppConfigured) {
    res.status(503).json({ error: "WhatsApp not configured" });
    return;
  }

  const results: Array<{
    phone: string;
    supplierId?: number;
    ok: boolean;
    error?: string;
    waId?: string | null;
  }> = [];
  for (let i = 0; i < phones.length; i++) {
    const phone = phones[i];
    const supplierId = supplierIds?.[i];
    try {
      const waId = await sendWhatsAppText(phone, message);
      const normalized = normalizePhone(phone);
      await db.insert(whatsappChatsTable).values({
        waMessageId: waId,
        direction: "outbound",
        phone: normalized,
        supplierId: supplierId ?? null,
        body: message,
        isRead: true,
      });
      results.push({ phone, supplierId, ok: true, waId });
      logger.info({ phone: normalized, supplierId }, "Broadcast message sent");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({ phone, supplierId, ok: false, error: errMsg });
      logger.warn({ err, phone }, "Broadcast message failed for one recipient");
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;
  logger.info({ successCount, failCount, total: phones.length }, "Broadcast completed");
  res.json({ ok: true, results, successCount, failCount });
});

// ─── GET /api/whatsapp/diagnose ───────────────────────────────────────────
router.get("/whatsapp/diagnose", requireAuth, async (req, res): Promise<void> => {
  const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || "ar";
  const TEMPLATE_NAMES = [
    process.env.WHATSAPP_TEMPLATE_PDF || "rfq_pdf_ar",
    process.env.WHATSAPP_TEMPLATE_TEXT || "rfq_send_ar",
    process.env.WHATSAPP_TEMPLATE_UTILITY || "rfq_utility_ar",
  ];

  if (!isWhatsAppConfigured) {
    res.json({ configured: false, error: "Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_TOKEN" });
    return;
  }

  let phoneInfo: Record<string, unknown> = {};
  try {
    const r = await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}?fields=display_phone_number,verified_name,quality_rating,status,platform_type`,
    );
    phoneInfo = (await r.json()) as Record<string, unknown>;
  } catch (e) {
    phoneInfo = { error: String(e) };
  }

  let templates: Record<string, unknown> = {};
  if (WABA_ID) {
    try {
      const r = await Whatsapp.$$apiFetch$$(
        `https://graph.facebook.com/${WA_API_VERSION}/${WABA_ID}/message_templates?limit=30&fields=name,status,quality_score,language,category`,
      );
      const data = (await r.json()) as {
        data?: Array<{
          name: string;
          status: string;
          language: string;
          category?: string;
          quality_score?: unknown;
        }>;
      };
      const all = data.data ?? [];
      const ourTemplates = all.filter(
        (t) => TEMPLATE_NAMES.includes(t.name) || t.language === TEMPLATE_LANG,
      );
      templates = {
        total: all.length,
        our_templates: ourTemplates,
        all_names: all.map((t) => ({ name: t.name, status: t.status, lang: t.language })),
      };
    } catch (e) {
      templates = { error: String(e) };
    }
  } else {
    templates = { warning: "WHATSAPP_BUSINESS_ACCOUNT_ID not set — cannot check template status" };
  }

  const creds = {
    WHATSAPP_PHONE_NUMBER_ID: WA_PHONE_ID
      ? "✓ set (" + WA_PHONE_ID.slice(0, 5) + "...)"
      : "✗ missing",
    WHATSAPP_TOKEN: WA_TOKEN ? "✓ set (length=" + WA_TOKEN.length + ")" : "✗ missing",
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET
      ? "✓ set (signature verification enabled)"
      : "✗ missing — webhook signature verification disabled",
    WHATSAPP_BUSINESS_ACCOUNT_ID: WABA_ID
      ? "✓ set"
      : "✗ missing — add this env var to check template status",
    WHATSAPP_VERIFY_TOKEN: WEBHOOK_VERIFY_TOKEN ? "✓ set" : "✗ missing",
    template_names: TEMPLATE_NAMES,
    template_lang: TEMPLATE_LANG,
    library:
      "whatsapp-api-js v6 (open-source, official Meta Cloud API wrapper — github.com/Secreto31126/whatsapp-api-js)",
  };

  res.json({ configured: true, phone: phoneInfo, templates, creds });
});

export default router;
