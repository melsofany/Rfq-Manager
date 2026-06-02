import { logger } from "./logger";
import { generateRfqPdf } from "./rfqPdf";

const WHATSAPP_API_VERSION = "v22.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

const TEMPLATE_TEXT    = process.env.WHATSAPP_TEMPLATE_TEXT    || "rfq_send_ar";
const TEMPLATE_UTILITY = process.env.WHATSAPP_TEMPLATE_UTILITY || "rfq_utility_ar";
const TEMPLATE_PDF     = process.env.WHATSAPP_TEMPLATE_PDF     || "rfq_pdf_ar";
const TEMPLATE_LANG    = process.env.WHATSAPP_TEMPLATE_LANG    || "ar";

interface WaApiError {
  error?: {
    code?: number;
    error_subcode?: number;
    message?: string;
    error_data?: { details?: string };
  };
}

interface WaApiResponse {
  messages?: { id: string }[];
}

function apiUrl(): string {
  return `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${PHONE_NUMBER_ID}/messages`;
}

function mediaUrl(): string {
  return `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${PHONE_NUMBER_ID}/media`;
}

class WhatsAppApiError extends Error {
  waCode?: number;
  constructor(message: string, waCode?: number) {
    super(message);
    this.name = "WhatsAppApiError";
    this.waCode = waCode;
  }
}

async function postMessage(body: object): Promise<WaApiResponse> {
  if (!PHONE_NUMBER_ID || !TOKEN) {
    throw new Error("WhatsApp credentials not configured (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TOKEN)");
  }
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as WaApiError & WaApiResponse;
  if (!res.ok) {
    const code = json?.error?.code;
    throw new WhatsAppApiError(`WhatsApp API error ${res.status}: ${JSON.stringify(json)}`, code);
  }
  return json;
}

function normalizePhone(phone: string): string {
  let cleaned = phone.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);
  if (cleaned.length === 11 && cleaned.startsWith("0")) cleaned = "2" + cleaned;
  if (cleaned.length === 10 && cleaned.startsWith("1")) cleaned = "20" + cleaned;
  return cleaned;
}

function extractPricingToken(pricingUrl: string): string {
  const parts = pricingUrl.split("/");
  return parts[parts.length - 1] || pricingUrl;
}

async function uploadWhatsAppMedia(pdfBuffer: Buffer, filename: string): Promise<string> {
  if (!PHONE_NUMBER_ID || !TOKEN) throw new Error("WhatsApp credentials not configured");
  const blob = new Blob([pdfBuffer], { type: "application/pdf" });
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "application/pdf");
  form.append("file", blob, filename);
  const res = await fetch(mediaUrl(), { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: form });
  const json = (await res.json()) as { id?: string; error?: object };
  if (!res.ok || !json.id) throw new Error(`WhatsApp media upload error ${res.status}: ${JSON.stringify(json)}`);
  logger.info({ mediaId: json.id, filename }, "WhatsApp media uploaded");
  return json.id;
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

function sanitizeWaParam(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ {5,}/g, "    ").trim();
}

function buildItemsSummary(opts: SendRfqOpts): string {
    const suffix = opts.items.length > 5 ? `، وغيرها (${opts.items.length} صنف)` : "";
    const summary = opts.items
      .slice(0, 5)
      .map((item, i) => {
        const line = item.lineItem || String(i + 1);
        const qty = item.qty ? ` x${item.qty}` : "";
        return `${line}. ${sanitizeWaParam(item.description)}${qty}`;
      })
      .join("، ") + suffix;
    const full = sanitizeWaParam(summary);
    // WhatsApp template params must stay well under 1024-char limit
    if (full.length <= 800) return full;
    return full.slice(0, 800 - suffix.length).trimEnd() + "…" + suffix;
  }
  
function buildContactText(opts: SendRfqOpts): string {
  return sanitizeWaParam(`${opts.employeeName}${opts.employeePhone ? " — " + opts.employeePhone : ""}`);
}

async function sendRfqTemplateUtility(to: string, opts: SendRfqOpts): Promise<string> {
  const pricingToken = extractPricingToken(opts.pricingUrl);
  const result = await postMessage({
    messaging_product: "whatsapp", to, type: "template",
    template: {
      name: TEMPLATE_UTILITY, language: { code: TEMPLATE_LANG },
      components: [
        { type: "body", parameters: [
          { type: "text", text: opts.toName },
          { type: "text", text: opts.rfqNo },
          { type: "text", text: buildItemsSummary(opts) },
          { type: "text", text: opts.closeDate },
          { type: "text", text: buildContactText(opts) },
        ]},
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: pricingToken }] },
      ],
    },
  });
  const waMessageId = result.messages?.[0]?.id ?? "";
  logger.info({ to, rfqNo: opts.rfqNo, waMessageId }, "RFQ UTILITY template sent via WhatsApp");
  return waMessageId;
}

async function sendRfqTemplateWithPdf(to: string, opts: SendRfqOpts): Promise<string> {
  const pdfBuffer = await Promise.race<Buffer>([
    generateRfqPdf({
      rfqNo: opts.rfqNo, customerRfqNo: opts.customerRfqNo, rfqDate: opts.rfqDate,
      closeDate: opts.closeDate, supplierName: opts.toName, items: opts.items,
      pricingUrl: opts.pricingUrl, employeeName: opts.employeeName,
      employeePhone: opts.employeePhone, notes: opts.notes,
    }),
    new Promise<Buffer>((_, rej) => setTimeout(() => rej(new Error("PDF generation timed out")), 25000)),
  ]);
  const filename = `RFQ-${opts.rfqNo}.pdf`;
  const mediaId = await uploadWhatsAppMedia(pdfBuffer, filename);
  const pricingToken = extractPricingToken(opts.pricingUrl);
  const result = await postMessage({
    messaging_product: "whatsapp", to, type: "template",
    template: {
      name: TEMPLATE_PDF, language: { code: TEMPLATE_LANG },
      components: [
        { type: "header", parameters: [{ type: "document", document: { id: mediaId, filename } }] },
        { type: "body", parameters: [
          { type: "text", text: opts.toName },
          { type: "text", text: opts.rfqNo },
          { type: "text", text: opts.closeDate },
          { type: "text", text: buildContactText(opts) },
        ]},
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: pricingToken }] },
      ],
    },
  });
  const waMessageId = result.messages?.[0]?.id ?? "";
  logger.info({ to, rfqNo: opts.rfqNo, waMessageId }, "RFQ PDF template sent via WhatsApp");
  return waMessageId;
}

async function sendRfqTemplateTextOnly(to: string, opts: SendRfqOpts): Promise<string> {
  const pricingToken = extractPricingToken(opts.pricingUrl);
  const result = await postMessage({
    messaging_product: "whatsapp", to, type: "template",
    template: {
      name: TEMPLATE_TEXT, language: { code: TEMPLATE_LANG },
      components: [
        { type: "body", parameters: [
          { type: "text", text: opts.toName },
          { type: "text", text: opts.rfqNo },
          { type: "text", text: buildItemsSummary(opts) },
          { type: "text", text: opts.closeDate },
          { type: "text", text: buildContactText(opts) },
        ]},
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: pricingToken }] },
      ],
    },
  });
  const waMessageId = result.messages?.[0]?.id ?? "";
  logger.info({ to, rfqNo: opts.rfqNo, waMessageId }, "RFQ text-only template sent via WhatsApp");
  return waMessageId;
}

function buildTextMessage(opts: SendRfqOpts): string {
  const itemLines = opts.items.map((item, i) => {
    const line = item.lineItem || String(i + 1);
    const part = item.partNo ? ` [${item.partNo}]` : "";
    const qty = item.qty ? ` — الكمية: ${item.qty}${item.uom ? " " + item.uom : ""}` : "";
    return `${line}. ${item.description}${part}${qty}`;
  }).join("\n");
  return [
    `*طلب عرض سعر — ${opts.rfqNo}*`,
    `───────────────────`,
    `عزيزنا ${opts.toName}،`,
    ``,
    `تود شركة قرطبة للتوريدات الحصول على أفضل عرض سعر للأصناف التالية:`,
    ``,
    itemLines,
    ``,
    `───────────────────`,
    `*تاريخ الإغلاق:* ${opts.closeDate}`,
    ``,
    `لتقديم عرضك، يرجى الضغط على الرابط التالي:`,
    opts.pricingUrl,
    ``,
    `_هذا الرابط خاص بشركتكم، يرجى عدم مشاركته._`,
    ``,
    `للاستفسار: ${buildContactText(opts)}`,
  ].join("\n");
}

export async function sendRfqWhatsApp(opts: SendRfqOpts): Promise<{ pdfSent: boolean; usedTemplate: boolean; waMessageId: string | null }> {
    const to = normalizePhone(opts.phone);
    const methodErrors: string[] = [];

    // Primary: rfq_pdf_ar (PDF attachment + button)
    try {
      const waId = await sendRfqTemplateWithPdf(to, opts);
      logger.info({ to, rfqNo: opts.rfqNo, waMessageId: waId }, "RFQ sent via rfq_pdf_ar template");
      return { pdfSent: true, usedTemplate: true, waMessageId: waId || null };
    } catch (pdfErr) {
      const msg = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
      methodErrors.push(`rfq_pdf_ar: ${msg}`);
      logger.warn({ err: pdfErr, to, rfqNo: opts.rfqNo }, "rfq_pdf_ar failed — trying rfq_send_ar");
    }

    // Fallback 1: rfq_send_ar (text only + button)
    try {
      const waId = await sendRfqTemplateTextOnly(to, opts);
      logger.info({ to, rfqNo: opts.rfqNo, waMessageId: waId }, "RFQ sent via rfq_send_ar template");
      return { pdfSent: false, usedTemplate: true, waMessageId: waId || null };
    } catch (textErr) {
      const msg = textErr instanceof Error ? textErr.message : String(textErr);
      methodErrors.push(`rfq_send_ar: ${msg}`);
      logger.warn({ err: textErr, to, rfqNo: opts.rfqNo }, "rfq_send_ar failed — trying rfq_utility_ar");
    }

    // Fallback 2: rfq_utility_ar
    try {
      const waId = await sendRfqTemplateUtility(to, opts);
      logger.info({ to, rfqNo: opts.rfqNo, waMessageId: waId }, "RFQ sent via rfq_utility_ar template");
      return { pdfSent: false, usedTemplate: true, waMessageId: waId || null };
    } catch (utilErr) {
      const msg = utilErr instanceof Error ? utilErr.message : String(utilErr);
      methodErrors.push(`rfq_utility_ar: ${msg}`);
      logger.warn({ err: utilErr, to, rfqNo: opts.rfqNo }, "All 3 templates failed");
    }

    // All templates failed.
    // NOTE: We intentionally do NOT fall back to plain text — plain text messages
    // are silently accepted by the WhatsApp API (returns a wamid) but are NEVER
    // delivered to recipients who haven't opened a conversation in the last 24 hours.
    // This creates a false "✓ أُرسل" in the UI while the supplier receives nothing.
    // Instead we throw so the UI correctly shows "✗ فشل" with the real error.
    const combined = methodErrors.join(" | ");
    logger.error({ to, rfqNo: opts.rfqNo, methodErrors }, "All WhatsApp templates failed — message NOT sent");
    throw new Error(`فشل إرسال واتساب. الأخطاء: ${combined}`);
  }
  
// Returns the WhatsApp message ID (wamid) so callers can store it for later deletion.
export async function sendWhatsAppText(phone: string, text: string): Promise<string | null> {
  const to = normalizePhone(phone);
  const result = await postMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text, preview_url: false },
  });
  logger.info({ to }, "WhatsApp text sent");
  return result?.messages?.[0]?.id ?? null;
}

export async function markWhatsAppRead(messageId: string): Promise<void> {
  if (!PHONE_NUMBER_ID || !TOKEN) return;
  try {
    await fetch(apiUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
    });
  } catch {
    // non-critical
  }
}
