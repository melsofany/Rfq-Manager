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

async function postMessage(body: object): Promise<object> {
  if (!PHONE_NUMBER_ID || !TOKEN) {
    throw new Error("WhatsApp credentials not configured (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TOKEN)");
  }
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as WaApiError;
  if (!res.ok) {
    const code = json?.error?.code;
    throw new WhatsAppApiError(`WhatsApp API error ${res.status}: ${JSON.stringify(json)}`, code);
  }
  return json as object;
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
  const summary = opts.items
    .slice(0, 5)
    .map((item, i) => {
      const line = item.lineItem || String(i + 1);
      const qty = item.qty ? ` x${item.qty}` : "";
      return `${line}. ${sanitizeWaParam(item.description)}${qty}`;
    })
    .join("، ") + (opts.items.length > 5 ? `، وغيرها (${opts.items.length} صنف)` : "");
  return sanitizeWaParam(summary);
}

function buildContactText(opts: SendRfqOpts): string {
  return sanitizeWaParam(`${opts.employeeName}${opts.employeePhone ? " — " + opts.employeePhone : ""}`);
}

async function sendRfqTemplateUtility(to: string, opts: SendRfqOpts): Promise<void> {
  const pricingToken = extractPricingToken(opts.pricingUrl);
  await postMessage({
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
  logger.info({ to, rfqNo: opts.rfqNo }, "RFQ UTILITY template sent via WhatsApp");
}

async function sendRfqTemplateWithPdf(to: string, opts: SendRfqOpts): Promise<void> {
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
  await postMessage({
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
  logger.info({ to, rfqNo: opts.rfqNo }, "RFQ PDF template sent via WhatsApp");
}

async function sendRfqTemplateTextOnly(to: string, opts: SendRfqOpts): Promise<void> {
  const pricingToken = extractPricingToken(opts.pricingUrl);
  await postMessage({
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
  logger.info({ to, rfqNo: opts.rfqNo }, "RFQ text-only template sent via WhatsApp");
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

export async function sendRfqWhatsApp(opts: SendRfqOpts): Promise<{ pdfSent: boolean; usedTemplate: boolean }> {
  const to = normalizePhone(opts.phone);
  let pdfSent = false;
  let usedTemplate = false;

  // Primary: rfq_pdf_ar (PDF attachment + button)
  try {
    await sendRfqTemplateWithPdf(to, opts);
    pdfSent = true; usedTemplate = true;
    return { pdfSent, usedTemplate };
  } catch (pdfErr) {
    const pdfErrMsg = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
      logger.warn({ err: pdfErr, errMsg: pdfErrMsg, to, rfqNo: opts.rfqNo }, "rfq_pdf_ar failed — trying text-only template");
  }

  // Fallback 1: rfq_send_ar (text only + button)
  try {
    await sendRfqTemplateTextOnly(to, opts);
    usedTemplate = true;
    return { pdfSent: false, usedTemplate };
  } catch (textErr) {
    const textErrMsg = textErr instanceof Error ? textErr.message : String(textErr);
      logger.warn({ err: textErr, errMsg: textErrMsg, to, rfqNo: opts.rfqNo }, "rfq_send_ar failed — trying UTILITY template");
  }

  try {
    await sendRfqTemplateUtility(to, opts);
    usedTemplate = true;
    return { pdfSent: false, usedTemplate };
  } catch (utilErr) {
    const utilErrMsg = utilErr instanceof Error ? utilErr.message : String(utilErr);
      logger.warn({ err: utilErr, errMsg: utilErrMsg, to, rfqNo: opts.rfqNo }, "UTILITY template failed — trying plain text");
  }

  try {
    const message = buildTextMessage(opts);
    await postMessage({ messaging_product: "whatsapp", to, type: "text", text: { body: message, preview_url: false } });
    logger.info({ to, rfqNo: opts.rfqNo }, "RFQ WhatsApp plain text sent (fallback)");
  } catch (err) {
    const allFailedMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err, errMsg: allFailedMsg, to, rfqNo: opts.rfqNo }, "All WhatsApp send methods failed — message NOT delivered");
    throw err;
  }

  return { pdfSent, usedTemplate };
}

// Returns the WhatsApp message ID (wamid) so callers can store it for later deletion.
export async function sendWhatsAppText(phone: string, text: string): Promise<string | null> {
  const to = normalizePhone(phone);
  const result = await postMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text, preview_url: false },
  }) as { messages?: { id: string }[] };
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
