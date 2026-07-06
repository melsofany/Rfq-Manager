/**
 * WhatsApp integration via @whiskeysockets/baileys
 * GitHub: https://github.com/WhiskeySockets/Baileys (26k+ stars, MIT-licensed)
 *
 * Connects to WhatsApp by scanning a QR code.
 * No Meta Business account or approval required.
 */
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import * as QRCode from "qrcode";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { logger } from "./logger";

// ─── Storage Directories ──────────────────────────────────────────────────
export const AUTH_DIR =
  process.env.WA_AUTH_DIR ?? path.join(process.cwd(), "wa-auth");
export const MEDIA_DIR =
  process.env.WA_MEDIA_DIR ?? path.join(process.cwd(), "wa-media");

for (const dir of [AUTH_DIR, MEDIA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Types ────────────────────────────────────────────────────────────────
export type WaStatus = "disconnected" | "qr" | "connecting" | "connected";

export interface InboundMessage {
  waMessageId: string;
  phone: string;
  body: string;
  mediaId: string | null;
  mediaType: string | null;
  mimeType: string | null;
  filename: string | null;
  senderName: string;
}

export interface SendRfqOpts {
  phone: string;
  toName: string;
  rfqNo: string;
  customerRfqNo: string;
  rfqDate?: string | null;
  items: Array<{
    lineItem?: string | null;
    partNo?: string | null;
    description: string;
    qty?: string | null;
    uom?: string | null;
  }>;
  pricingUrl: string;
  closeDate: string;
  employeeName: string;
  employeePhone?: string | null;
  notes?: string | null;
}

// ─── State ────────────────────────────────────────────────────────────────
let sock: WASocket | null = null;
let _status: WaStatus = "disconnected";
let _qrDataUrl: string | null = null;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Mutable callback handlers (set by routes/whatsapp.ts) ───────────────
export const handlers = {
  onQr: null as ((qrDataUrl: string) => void) | null,
  onStatus: null as ((status: WaStatus) => void) | null,
  onInboundMessage: null as ((msg: InboundMessage) => Promise<void>) | null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────
export const isWhatsAppConfigured = true;

export function normalizePhone(phone: string): string {
  let c = phone.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  if (c.startsWith("00")) c = c.slice(2);
  if (c.length === 11 && c.startsWith("0")) c = "2" + c;
  if (c.length === 10 && c.startsWith("1")) c = "20" + c;
  return c;
}

function toJid(phone: string): string {
  return normalizePhone(phone) + "@s.whatsapp.net";
}

async function saveMedia(buffer: Buffer): Promise<string> {
  const uuid = randomUUID();
  fs.writeFileSync(path.join(MEDIA_DIR, uuid), buffer);
  return uuid;
}

// ─── Socket lifecycle ─────────────────────────────────────────────────────
async function startSocket(): Promise<void> {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const silentPino = (await import("pino")).default({ level: "silent" });

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: silentPino as Parameters<typeof makeWASocket>[0]["logger"],
    browser: ["Cortoba RFQ Manager", "Chrome", "120.0.0"],
    connectTimeoutMs: 30_000,
    defaultQueryTimeoutMs: 30_000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        _qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
        _status = "qr";
        handlers.onQr?.(_qrDataUrl);
        handlers.onStatus?.("qr");
      } catch (err) {
        logger.error({ err }, "Failed to generate QR code image");
      }
    }

    if (connection === "connecting") {
      _status = "connecting";
      handlers.onStatus?.("connecting");
    }

    if (connection === "open") {
      _status = "connected";
      _qrDataUrl = null;
      handlers.onStatus?.("connected");
      logger.info("WhatsApp connected via Baileys");
    }

    if (connection === "close") {
      _status = "disconnected";
      _qrDataUrl = null;
      handlers.onStatus?.("disconnected");

      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output
        ?.statusCode;
      const loggedOut =
        statusCode === DisconnectReason.loggedOut ||
        statusCode === DisconnectReason.forbidden;

      logger.warn({ statusCode }, "WhatsApp connection closed");

      if (loggedOut) {
        logger.warn("WhatsApp logged out — clearing auth, will show QR");
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(AUTH_DIR, { recursive: true });
        } catch { /* ignore */ }
      }
      _reconnectTimer = setTimeout(startSocket, loggedOut ? 2_000 : 5_000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const remoteJid = msg.key.remoteJid ?? "";
      if (remoteJid.endsWith("@g.us")) continue;

      const phone = remoteJid.replace("@s.whatsapp.net", "");
      const waMessageId = msg.key.id ?? randomUUID();
      const senderName = msg.pushName ?? "";

      let body = "";
      let mediaId: string | null = null;
      let mediaType: string | null = null;
      let mimeType: string | null = null;
      let filename: string | null = null;

      const c = msg.message;

      try {
        if (c.conversation) {
          body = c.conversation;
        } else if (c.extendedTextMessage?.text) {
          body = c.extendedTextMessage.text;
        } else if (c.imageMessage) {
          body =
            "[صورة مرسلة]" +
            (c.imageMessage.caption ? " — " + c.imageMessage.caption : "");
          mediaType = "image";
          mimeType = c.imageMessage.mimetype ?? "image/jpeg";
          const buf = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
          mediaId = await saveMedia(buf);
        } else if (c.documentMessage) {
          filename = c.documentMessage.fileName ?? "ملف";
          body = "[مستند: " + filename + "]";
          mediaType = "document";
          mimeType = c.documentMessage.mimetype ?? "application/octet-stream";
          const buf = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
          mediaId = await saveMedia(buf);
        } else if (c.audioMessage) {
          body = "[رسالة صوتية]";
          mediaType = "audio";
          mimeType = c.audioMessage.mimetype ?? "audio/ogg; codecs=opus";
          const buf = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
          mediaId = await saveMedia(buf);
        } else if (c.videoMessage) {
          body =
            "[فيديو]" +
            (c.videoMessage.caption ? " — " + c.videoMessage.caption : "");
          mediaType = "video";
          mimeType = c.videoMessage.mimetype ?? "video/mp4";
          const buf = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
          mediaId = await saveMedia(buf);
        } else {
          body =
            "[رسالة من نوع: " + (Object.keys(c)[0] ?? "غير معروف") + "]";
        }
      } catch (mediaErr) {
        logger.warn({ mediaErr }, "Failed to process message media");
        if (!body) body = "[رسالة]";
      }

      try {
        await handlers.onInboundMessage?.({
          waMessageId,
          phone,
          body,
          mediaId,
          mediaType,
          mimeType,
          filename,
          senderName,
        });
        await sock?.readMessages([msg.key]);
      } catch (err) {
        logger.error({ err }, "Error processing inbound WhatsApp message");
      }
    }
  });
}

// ─── Initialize on module load ────────────────────────────────────────────
startSocket().catch((err) => logger.error({ err }, "WhatsApp init failed"));

// ─── Public API ───────────────────────────────────────────────────────────
export function getStatus(): WaStatus {
  return _status;
}
export function getQrDataUrl(): string | null {
  return _qrDataUrl;
}

export async function getProfilePicture(
  phone: string,
): Promise<string | null> {
  if (!sock || _status !== "connected") return null;
  try {
    return await sock.profilePictureUrl(toJid(phone), "image");
  } catch {
    return null;
  }
}

export async function disconnectAndReset(): Promise<void> {
  try { await sock?.logout(); } catch { /* ignore */ }
  sock = null;
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  } catch { /* ignore */ }
  _status = "disconnected";
  _qrDataUrl = null;
  await startSocket();
}

export async function sendWhatsAppText(
  phone: string,
  text: string,
): Promise<string | null> {
  if (!sock || _status !== "connected") {
    throw new Error(
      "WhatsApp غير متصل — يرجى مسح رمز QR من صفحة الواتساب أولاً",
    );
  }
  const result = await sock.sendMessage(toJid(phone), { text });
  return result?.key.id ?? null;
}

export async function sendWhatsAppMedia(
  phone: string,
  buffer: Buffer,
  mimeType: string,
  filename?: string,
  caption?: string,
): Promise<string | null> {
  if (!sock || _status !== "connected") {
    throw new Error("WhatsApp غير متصل");
  }
  const jid = toJid(phone);
  let result;
  if (mimeType.startsWith("image/")) {
    result = await sock.sendMessage(jid, { image: buffer, caption: caption ?? "" });
  } else if (mimeType.startsWith("video/")) {
    result = await sock.sendMessage(jid, { video: buffer, caption: caption ?? "" });
  } else if (mimeType.startsWith("audio/")) {
    result = await sock.sendMessage(jid, { audio: buffer, mimetype: mimeType, ptt: false });
  } else {
    result = await sock.sendMessage(jid, {
      document: buffer,
      mimetype: mimeType,
      fileName: filename ?? "file",
      caption: caption ?? "",
    });
  }
  return result?.key.id ?? null;
}

export async function sendRfqWhatsApp(opts: SendRfqOpts): Promise<{
  pdfSent: boolean;
  usedTemplate: boolean;
  waMessageId: string | null;
}> {
  if (!sock || _status !== "connected") {
    throw new Error(
      "WhatsApp غير متصل — يرجى مسح رمز QR من صفحة الواتساب أولاً",
    );
  }

  const itemsList = opts.items
    .slice(0, 10)
    .map((item, i) => {
      const line = item.lineItem ?? String(i + 1);
      const qty = item.qty
        ? " — الكمية: " + item.qty + (item.uom ? " " + item.uom : "")
        : "";
      return line + ". " + item.description + qty;
    })
    .join("\n");

  const moreItems =
    opts.items.length > 10
      ? "\n... وغيرها (" + opts.items.length + " صنف إجمالاً)"
      : "";

  const lines = [
    "*طلب عروض أسعار — قرطبة للتوريدات*",
    "",
    "السيد/ة: *" + opts.toName + "*",
    "",
    "🔖 رقم الطلب: *" + opts.rfqNo + "*",
    "📅 تاريخ الطلب: " + (opts.rfqDate ?? new Date().toLocaleDateString("ar-EG")),
    "⏰ آخر موعد للرد: *" + opts.closeDate + "*",
    "",
    "📋 *الأصناف المطلوبة:*",
    itemsList + moreItems,
    "",
    "🔗 لتقديم عرض الأسعار:",
    opts.pricingUrl,
    "",
    "📞 للاستفسار: " + opts.employeeName + (opts.employeePhone ? " — " + opts.employeePhone : ""),
    ...(opts.notes ? ["", "📝 ملاحظات: " + opts.notes] : []),
  ];

  const result = await sock.sendMessage(toJid(opts.phone), {
    text: lines.join("\n"),
  });
  return { pdfSent: false, usedTemplate: false, waMessageId: result?.key.id ?? null };
}

export async function markWhatsAppRead(): Promise<void> {
  // Read receipts are sent automatically via sock.readMessages above
}
