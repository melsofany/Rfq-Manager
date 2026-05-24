import { Router } from "express";
import { db, suppliersTable, whatsappChatsTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { sendWhatsAppText, markWhatsAppRead } from "../lib/whatsapp";
import { logger } from "../lib/logger";

const router = Router();

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// ─── GET /api/webhook/whatsapp — Meta verification handshake ───────────────
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

// ─── POST /api/webhook/whatsapp — Incoming messages from Meta ─────────────
router.post("/webhook/whatsapp", async (req, res): Promise<void> => {
  // Always respond 200 immediately so Meta doesn't retry
  res.sendStatus(200);

  try {
    const body = req.body as WhatsAppWebhookPayload;
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;

        // Handle incoming messages
        for (const msg of value.messages ?? []) {
          await handleInboundMessage(msg, value.contacts ?? []);
        }

        // Handle status updates (delivered/read) — logged but not stored
        for (const status of value.statuses ?? []) {
          logger.info({ id: status.id, status: status.status }, "WhatsApp status update");
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "WhatsApp webhook processing error");
  }
});

async function handleInboundMessage(
  msg: WAMessage,
  contacts: WAContact[]
): Promise<void> {
  const phone = msg.from;
  const waMessageId = msg.id;
  const contact = contacts.find(c => c.wa_id === phone);
  const senderName = contact?.profile?.name ?? phone;

  // Extract text from various message types
  let body: string;
  if (msg.type === "text" && msg.text) {
    body = msg.text.body;
  } else if (msg.type === "image") {
    body = `[صورة مرسلة]${msg.image?.caption ? " — " + msg.image.caption : ""}`;
  } else if (msg.type === "document") {
    body = `[مستند: ${msg.document?.filename ?? "ملف"}]`;
  } else if (msg.type === "audio") {
    body = "[رسالة صوتية]";
  } else {
    body = `[رسالة من نوع: ${msg.type}]`;
  }

  // Try to match supplier by phone number
  const allSuppliers = await db.select().from(suppliersTable);
  const matchedSupplier = allSuppliers.find(s => {
    if (!s.phone) return false;
    const normalized = s.phone.replace(/[\s\-()]/g, "").replace(/^\+/, "");
    return normalized === phone || normalized.endsWith(phone) || phone.endsWith(normalized);
  });

  // Skip if duplicate message ID
  const existing = await db.select({ id: whatsappChatsTable.id })
    .from(whatsappChatsTable)
    .where(eq(whatsappChatsTable.waMessageId, waMessageId))
    .limit(1);
  if (existing.length > 0) return;

  // Save inbound message
  await db.insert(whatsappChatsTable).values({
    waMessageId,
    direction: "inbound",
    phone,
    supplierId: matchedSupplier?.id ?? null,
    body,
    isRead: false,
  });

  // Mark as read on WhatsApp
  await markWhatsAppRead(waMessageId);

  logger.info(
    { phone, senderName, supplierId: matchedSupplier?.id, body: body.slice(0, 80) },
    "WhatsApp inbound message saved"
  );

  // Auto-reply to unknown senders
  if (!matchedSupplier) {
    try {
      await sendWhatsAppText(
        phone,
        `شكراً للتواصل مع قرطبة للتوريدات.\n\nلم نتمكن من التعرف على رقمك في سجلاتنا. يرجى التواصل مباشرة مع فريق المشتريات.`
      );
    } catch (err) {
      logger.warn({ err }, "Could not send auto-reply to unknown sender");
    }
  }
}

// ─── GET /api/whatsapp/chats — list all conversations (auth required) ────
router.get("/whatsapp/chats", async (req, res): Promise<void> => {
  // group by phone, latest message first
  const rows = await db
    .select({
      phone: whatsappChatsTable.phone,
      supplierId: whatsappChatsTable.supplierId,
      supplierName: suppliersTable.name,
      lastMessage: sql<string>`(array_agg(${whatsappChatsTable.body} ORDER BY ${whatsappChatsTable.createdAt} DESC))[1]`,
      lastAt: sql<Date>`MAX(${whatsappChatsTable.createdAt})`,
      unread: sql<number>`COUNT(*) FILTER (WHERE ${whatsappChatsTable.direction} = 'inbound' AND ${whatsappChatsTable.isRead} = false)`,
    })
    .from(whatsappChatsTable)
    .leftJoin(suppliersTable, eq(whatsappChatsTable.supplierId, suppliersTable.id))
    .groupBy(whatsappChatsTable.phone, whatsappChatsTable.supplierId, suppliersTable.name)
    .orderBy(sql`MAX(${whatsappChatsTable.createdAt}) DESC`);

  res.json(rows);
});

// ─── GET /api/whatsapp/chats/:phone — messages for a phone ───────────────
router.get("/whatsapp/chats/:phone", async (req, res): Promise<void> => {
  const phone = req.params.phone;
  const messages = await db
    .select()
    .from(whatsappChatsTable)
    .where(eq(whatsappChatsTable.phone, phone))
    .orderBy(desc(whatsappChatsTable.createdAt))
    .limit(100);

  // Mark inbound as read
  await db
    .update(whatsappChatsTable)
    .set({ isRead: true })
    .where(eq(whatsappChatsTable.phone, phone));

  res.json(messages.reverse());
});

// ─── POST /api/whatsapp/send — send a message from the dashboard ─────────
router.post("/whatsapp/send", async (req, res): Promise<void> => {
  const { phone, message, supplierId } = req.body as {
    phone: string;
    message: string;
    supplierId?: number;
  };

  if (!phone || !message) {
    res.status(400).json({ error: "phone and message are required" });
    return;
  }

  await sendWhatsAppText(phone, message);

  const normalized = phone.replace(/[\s\-()]/g, "").replace(/^\+/, "");

  await db.insert(whatsappChatsTable).values({
    direction: "outbound",
    phone: normalized,
    supplierId: supplierId ?? null,
    body: message,
    isRead: true,
  });

  res.json({ ok: true });
});

// ─── Types ────────────────────────────────────────────────────────────────
interface WhatsAppWebhookPayload {
  object: string;
  entry?: Array<{
    id: string;
    changes?: Array<{
      value?: WAValue;
      field: string;
    }>;
  }>;
}

interface WAValue {
  messaging_product: string;
  messages?: WAMessage[];
  statuses?: WAStatus[];
  contacts?: WAContact[];
}

interface WAMessage {
  id: string;
  from: string;
  type: string;
  timestamp: string;
  text?: { body: string };
  image?: { caption?: string };
  document?: { filename?: string };
  audio?: object;
}

interface WAStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}

interface WAContact {
  wa_id: string;
  profile?: { name?: string };
}

export default router;
