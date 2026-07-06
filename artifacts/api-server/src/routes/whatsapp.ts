import { Router, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { db, suppliersTable, whatsappChatsTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import {
  handlers,
  getStatus,
  getQrDataUrl,
  isWhatsAppConfigured,
  sendWhatsAppText,
  sendWhatsAppMedia,
  disconnectAndReset,
  getProfilePicture,
  normalizePhone,
  MEDIA_DIR,
  type WaStatus,
  type InboundMessage,
} from "../lib/whatsapp";
import { requireAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";

const router = Router();

// ─── SSE: real-time push to connected browser clients ─────────────────────
const sseClients = new Set<Response>();

function broadcastWaEvent(event: Record<string, unknown>) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      (client as Response).write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ─── Wire Baileys callbacks ───────────────────────────────────────────────
handlers.onStatus = (status: WaStatus) => {
  broadcastWaEvent({ type: "wa_status", status });
};

handlers.onInboundMessage = async (msg: InboundMessage) => {
  const allSuppliers = await db.select().from(suppliersTable);
  const matchedSupplier = allSuppliers.find((s) => {
    if (!s.phone) return false;
    const norm = normalizePhone(s.phone);
    return (
      norm === msg.phone ||
      norm.endsWith(msg.phone) ||
      msg.phone.endsWith(norm)
    );
  });

  // Deduplicate by waMessageId
  const existing = await db
    .select({ id: whatsappChatsTable.id })
    .from(whatsappChatsTable)
    .where(eq(whatsappChatsTable.waMessageId, msg.waMessageId))
    .limit(1);
  if (existing.length > 0) return;

  await db.insert(whatsappChatsTable).values({
    waMessageId: msg.waMessageId,
    direction: "inbound",
    phone: msg.phone,
    supplierId: matchedSupplier?.id ?? null,
    body: msg.body,
    mediaId: msg.mediaId,
    mediaType: msg.mediaType,
    mimeType: msg.mimeType,
    filename: msg.filename,
    isRead: false,
  });

  logger.info(
    {
      phone: msg.phone,
      senderName: msg.senderName,
      supplierId: matchedSupplier?.id,
      body: msg.body.slice(0, 80),
    },
    "WhatsApp inbound message saved",
  );

  broadcastWaEvent({ type: "new_message", phone: msg.phone });

  // Auto-reply to unknown senders
  if (!matchedSupplier) {
    try {
      await sendWhatsAppText(
        msg.phone,
        "شكراً للتواصل مع قرطبة للتوريدات.\n\nلم نتمكن من التعرف على رقمك في سجلاتنا. يرجى التواصل مباشرة مع فريق المشتريات.",
      );
    } catch (err) {
      logger.warn({ err }, "Could not send auto-reply to unknown sender");
    }
  }
};

// ─── GET /api/whatsapp/events (SSE) ───────────────────────────────────────
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
  }, 25_000);

  sseClients.add(res);
  req.on("close", () => {
    clearInterval(hb);
    sseClients.delete(res);
  });
});

// ─── GET /api/whatsapp/status ─────────────────────────────────────────────
router.get("/whatsapp/status", requireAuth, (req, res): void => {
  res.json({ status: getStatus(), qrDataUrl: getQrDataUrl() });
});

// ─── POST /api/whatsapp/disconnect ────────────────────────────────────────
router.post(
  "/whatsapp/disconnect",
  requireAuth,
  async (req, res): Promise<void> => {
    try {
      await disconnectAndReset();
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "Failed to disconnect WhatsApp");
      res.status(500).json({ error: "Failed to disconnect" });
    }
  },
);

// ─── GET /api/whatsapp/configured ─────────────────────────────────────────
router.get("/whatsapp/configured", (req, res): void => {
  res.json({ configured: isWhatsAppConfigured, status: getStatus() });
});

// ─── GET /api/whatsapp/media/:mediaId ─────────────────────────────────────
router.get(
  "/whatsapp/media/:mediaId",
  requireAuth,
  (req, res): void => {
    const { mediaId } = req.params;
    // Security: only allow UUID-format IDs
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(mediaId)) {
      res.status(400).json({ error: "Invalid media ID" });
      return;
    }
    const mediaPath = path.join(MEDIA_DIR, mediaId);
    if (!fs.existsSync(mediaPath)) {
      res.status(404).json({ error: "Media not found" });
      return;
    }
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(mediaPath);
  },
);

// ─── GET /api/whatsapp/profile-picture/:phone ─────────────────────────────
router.get(
  "/whatsapp/profile-picture/:phone",
  requireAuth,
  async (req, res): Promise<void> => {
    const { phone } = req.params;
    try {
      const picUrl = await getProfilePicture(phone);
      if (!picUrl) {
        res.status(404).json({ error: "No profile picture" });
        return;
      }
      const imgRes = await fetch(picUrl);
      if (!imgRes.ok) {
        res.status(404).json({ error: "Image not available" });
        return;
      }
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      res.setHeader(
        "Content-Type",
        imgRes.headers.get("content-type") || "image/jpeg",
      );
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(buffer);
    } catch (err) {
      logger.warn({ err, phone }, "Failed to fetch WhatsApp profile picture");
      res.status(404).json({ error: "Failed to fetch profile picture" });
    }
  },
);

// ─── GET /api/whatsapp/chats ──────────────────────────────────────────────
router.get("/whatsapp/chats", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select({
      phone: whatsappChatsTable.phone,
      supplierId: whatsappChatsTable.supplierId,
      supplierName: suppliersTable.name,
      lastMessage: sql<string>`(array_agg(${whatsappChatsTable.body} ORDER BY ${whatsappChatsTable.createdAt} DESC))[1]`,
      lastAt: sql<Date>`MAX(${whatsappChatsTable.createdAt})`,
      lastInboundAt: sql<
        Date | null
      >`MAX(${whatsappChatsTable.createdAt}) FILTER (WHERE ${whatsappChatsTable.direction} = 'inbound')`,
      unread: sql<number>`COUNT(*) FILTER (WHERE ${whatsappChatsTable.direction} = 'inbound' AND ${whatsappChatsTable.isRead} = false)`,
    })
    .from(whatsappChatsTable)
    .leftJoin(
      suppliersTable,
      eq(whatsappChatsTable.supplierId, suppliersTable.id),
    )
    .groupBy(
      whatsappChatsTable.phone,
      whatsappChatsTable.supplierId,
      suppliersTable.name,
    )
    .orderBy(sql`MAX(${whatsappChatsTable.createdAt}) DESC`);
  res.json(rows);
});

// ─── GET /api/whatsapp/chats/:phone ──────────────────────────────────────
router.get(
  "/whatsapp/chats/:phone",
  requireAuth,
  async (req, res): Promise<void> => {
    const { phone } = req.params;
    const messages = await db
      .select()
      .from(whatsappChatsTable)
      .where(eq(whatsappChatsTable.phone, phone))
      .orderBy(desc(whatsappChatsTable.createdAt))
      .limit(100);
    await db
      .update(whatsappChatsTable)
      .set({ isRead: true })
      .where(eq(whatsappChatsTable.phone, phone));
    res.json(messages.reverse());
  },
);

// ─── POST /api/whatsapp/send ──────────────────────────────────────────────
router.post(
  "/whatsapp/send",
  requireAuth,
  async (req, res): Promise<void> => {
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
      req.log.error({ err, phone: normalized }, "WhatsApp send failed");
      res.status(400).json({ error: errMsg });
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
  },
);

// ─── POST /api/whatsapp/send-media ────────────────────────────────────────
router.post(
  "/whatsapp/send-media",
  requireAuth,
  async (req, res): Promise<void> => {
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
      res
        .status(400)
        .json({ error: "phone, base64, and mimeType are required" });
      return;
    }

    const normalized = normalizePhone(phone);
    const buffer = Buffer.from(base64, "base64");
    let outboundWaId: string | null = null;

    try {
      outboundWaId = await sendWhatsAppMedia(
        phone,
        buffer,
        fileMime,
        fileFilename,
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      req.log.error({ err, phone: normalized }, "WhatsApp send-media failed");
      res.status(400).json({ error: errMsg });
      return;
    }

    // Store sent media locally so it can be served back
    let localMediaId: string | null = null;
    try {
      const uuid = randomUUID();
      fs.writeFileSync(path.join(MEDIA_DIR, uuid), buffer);
      localMediaId = uuid;
    } catch { /* ignore */ }

    const mediaTypeName = fileMime.startsWith("image/")
      ? "image"
      : fileMime.startsWith("video/")
        ? "video"
        : fileMime.startsWith("audio/")
          ? "audio"
          : "document";

    const body =
      mediaTypeName === "image"
        ? "[صورة مرسلة]"
        : mediaTypeName === "video"
          ? "[فيديو مرسل]"
          : mediaTypeName === "audio"
            ? "[رسالة صوتية]"
            : "[مستند: " + (fileFilename ?? "ملف") + "]";

    await db.insert(whatsappChatsTable).values({
      waMessageId: outboundWaId,
      direction: "outbound",
      phone: normalized,
      supplierId: supplierId ?? null,
      body,
      mediaId: localMediaId,
      mediaType: mediaTypeName,
      mimeType: fileMime,
      filename: fileFilename ?? null,
      isRead: true,
    });

    res.json({ ok: true });
  },
);

// ─── DELETE /api/whatsapp/chats/:phone ────────────────────────────────────
router.delete(
  "/whatsapp/chats/:phone",
  requireAuth,
  async (req, res): Promise<void> => {
    const { phone } = req.params;
    await db
      .delete(whatsappChatsTable)
      .where(eq(whatsappChatsTable.phone, phone));
    res.json({ ok: true });
  },
);

export { broadcastWaEvent };
export default router;
