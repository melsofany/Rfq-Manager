import { logger } from "./logger";
import { generateRfqPdf } from "./rfqPdf";

const WHATSAPP_API_VERSION = "v22.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

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

// WhatsApp error 131047 = "Re-engagement message" = outside 24-hour window
function isOutsideWindowError(err: unknown): boolean {
  return err instanceof WhatsAppApiError && err.waCode === 131047;
}

async function postMessage(body: object): Promise<object> {
  if (!PHONE_NUMBER_ID || !TOKEN) {
    throw new Error("WhatsApp credentials not configured (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TOKEN)");
  }
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as WaApiError;
  if (!res.ok) {
    const code = json?.error?.code;
    throw new WhatsAppApiError(
      `WhatsApp API error ${res.status}: ${JSON.stringify(json)}`,
      code,
    );
  }
  return json as object;
}

// Normalize phone: strip spaces/dashes, ensure starts with country code (no +)
function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-()]/g, "").replace(/^\+/, "");
}

// Upload a PDF buffer to WhatsApp media API and return the media ID
async function uploadWhatsAppMedia(pdfBuffer: Buffer, filename: string): Promise<string> {
  if (!PHONE_NUMBER_ID || !TOKEN) {
    throw new Error("WhatsApp credentials not configured");
  }

  const blob = new Blob([pdfBuffer], { type: "application/pdf" });
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "application/pdf");
  form.append("file", blob, filename);

  const res = await fetch(mediaUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
  });

  const json = (await res.json()) as { id?: string; error?: object };
  if (!res.ok || !json.id) {
    throw new Error(`WhatsApp media upload error ${res.status}: ${JSON.stringify(json)}`);
  }

  logger.info({ mediaId: json.id, filename }, "WhatsApp media uploaded");
  return json.id;
}

interface SendRfqOpts {
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

function buildTextMessage(opts: SendRfqOpts): string {
  const itemLines = opts.items
    .map((item, i) => {
      const line = item.lineItem || String(i + 1);
      const part = item.partNo ? ` [${item.partNo}]` : "";
      const qty = item.qty ? ` — الكمية: ${item.qty}${item.uom ? " " + item.uom : ""}` : "";
      return `${line}. ${item.description}${part}${qty}`;
    })
    .join("\n");

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
    `للاستفسار: ${opts.employeeName}${opts.employeePhone ? " — " + opts.employeePhone : ""}`,
  ].join("\n");
}

/**
 * Send via an approved WhatsApp template message.
 *
 * Expected template: "rfq_notification" (or WHATSAPP_TEMPLATE_NAME env var)
 * Language: ar
 * Category: UTILITY
 * Body variables (5):
 *   {{1}} = supplier name
 *   {{2}} = RFQ number
 *   {{3}} = close date
 *   {{4}} = pricing URL
 *   {{5}} = employee name + phone
 *
 * Sample template body:
 *   عزيزنا {{1}}،
 *
 *   لديكم طلب عرض سعر رقم {{2}} من شركة قرطبة للتوريدات.
 *
 *   تاريخ الإغلاق: {{3}}
 *
 *   لتقديم عرضكم: {{4}}
 *
 *   للاستفسار: {{5}}
 */
async function sendRfqTemplate(to: string, opts: SendRfqOpts): Promise<void> {
  const templateName = process.env.WHATSAPP_TEMPLATE_NAME || "rfq_send_ar";
  const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || "ar";

  await postMessage({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: templateLang },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: opts.toName },
            { type: "text", text: opts.rfqNo },
            { type: "text", text: opts.closeDate },
            { type: "text", text: opts.pricingUrl },
            {
              type: "text",
              text: `${opts.employeeName}${opts.employeePhone ? " — " + opts.employeePhone : ""}`,
            },
          ],
        },
      ],
    },
  });
}

export async function sendRfqWhatsApp(
  opts: SendRfqOpts,
): Promise<{ pdfSent: boolean; usedTemplate: boolean }> {
  const to = normalizePhone(opts.phone);
  let pdfSent = false;
  let usedTemplate = false;

  // ── 1. Try to generate & send PDF (only works inside 24-hour window) ──────
    try {
      const pdfBuffer = await Promise.race<Buffer>([
        generateRfqPdf({
          rfqNo: opts.rfqNo,
          customerRfqNo: opts.customerRfqNo,
          rfqDate: opts.rfqDate,
          closeDate: opts.closeDate,
          supplierName: opts.toName,
          items: opts.items,
          pricingUrl: opts.pricingUrl,
          employeeName: opts.employeeName,
          employeePhone: opts.employeePhone,
          notes: opts.notes,
        }),
        new Promise<Buffer>((_, rej) =>
          setTimeout(() => rej(new Error("PDF generation timed out")), 15000),
        ),
      ]);

      const filename = `RFQ-${opts.rfqNo}.pdf`;
      const mediaId = await uploadWhatsAppMedia(pdfBuffer, filename);

      await postMessage({
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: {
          id: mediaId,
          filename,
          caption: `طلب عرض سعر — ${opts.rfqNo}`,
        },
      });

      logger.info({ to, rfqNo: opts.rfqNo }, "RFQ PDF document sent via WhatsApp");
      pdfSent = true;
    } catch (pdfErr) {
      if (isOutsideWindowError(pdfErr)) {
        logger.info(
          { to, rfqNo: opts.rfqNo },
          "PDF skipped — outside 24-hour window (no prior conversation)",
        );
      } else {
        logger.warn(
          { err: pdfErr, to, rfqNo: opts.rfqNo },
          "PDF generation/upload failed — falling back to text only",
        );
      }
    }

    // ── 2. Send text message; fall back to template if outside 24-hour window ─
  const message = buildTextMessage(opts);
  try {
    await postMessage({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message, preview_url: false },
    });
    logger.info({ to, rfqNo: opts.rfqNo }, "RFQ WhatsApp text sent");
  } catch (textErr) {
    if (isOutsideWindowError(textErr)) {
      // First contact — use pre-approved template
      logger.info(
        { to, rfqNo: opts.rfqNo },
        "Outside 24-hour window — sending via WhatsApp template",
      );
      await sendRfqTemplate(to, opts);
      usedTemplate = true;
      logger.info({ to, rfqNo: opts.rfqNo }, "RFQ WhatsApp template sent successfully");
    } else {
      throw textErr;
    }
  }

  return { pdfSent, usedTemplate };
}

export async function sendWhatsAppText(phone: string, text: string): Promise<void> {
  const to = normalizePhone(phone);
  await postMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text, preview_url: false },
  });
  logger.info({ to }, "WhatsApp text sent");
}

export async function markWhatsAppRead(messageId: string): Promise<void> {
  if (!PHONE_NUMBER_ID || !TOKEN) return;
  try {
    await fetch(apiUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    });
  } catch {
    // non-critical
  }
}
