import { WhatsAppAPI } from "whatsapp-api-js";
import {
  Text,
  Template,
  Language,
  HeaderComponent,
  HeaderParameter,
  BodyComponent,
  BodyParameter,
  URLComponent,
  PayloadComponent,
  Interactive,
  ActionButtons,
  Button,
  Body,
  Document as WADocument,
} from "whatsapp-api-js/messages";
import { logger } from "../../shared/logger";
import { generateRfqPdf } from "../rfq/rfq-pdf";
import { generatePoPdf } from "../po/po-pdf";

// ─── Official WhatsApp Business (Meta) Cloud API client ──────────────────────
// This module is built on top of the open-source "whatsapp-api-js" library
// (https://github.com/Secreto31126/whatsapp-api-js), a TypeScript wrapper
// around Meta's official WhatsApp Cloud API. It replaces the previous
// hand-rolled `fetch()` calls to graph.facebook.com with typed message
// builders and a single authenticated client.

export const PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER || "";
const TOKEN = process.env.WHATSAPP_TOKEN || "";
// Optional but recommended: enables verification of Meta's X-Hub-Signature-256
// header on incoming webhooks. Without it the client runs in "insecure" mode
// (still functional, just skips signature verification).
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
export const WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

const TEMPLATE_TEXT = process.env.WHATSAPP_TEMPLATE_TEXT || "rfq_send_ar";
const TEMPLATE_UTILITY = process.env.WHATSAPP_TEMPLATE_UTILITY || "rfq_utility_ar";
const TEMPLATE_PDF = process.env.WHATSAPP_TEMPLATE_PDF || "rfq_pdf_ar";
const TEMPLATE_PO_PDF = process.env.WHATSAPP_TEMPLATE_PO_PDF || "po_pdf_ar";
export const TEMPLATE_WORK_ORDER = process.env.WHATSAPP_TEMPLATE_WORK_ORDER || "representative_work_order_ar";
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || "ar";

const BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "";
export const isWhatsAppConfigured = Boolean(PHONE_NUMBER_ID && TOKEN);

export async function ensureWorkOrderTemplate(): Promise<void> {
  if (!TOKEN || !BUSINESS_ACCOUNT_ID) {
    logger.warn("WhatsApp template provisioning skipped: missing token or business account id");
    return;
  }
  const base = `https://graph.facebook.com/v22.0/${BUSINESS_ACCOUNT_ID}/message_templates`;
  const existing = await fetch(`${base}?name=${encodeURIComponent(TEMPLATE_WORK_ORDER)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!existing.ok) throw new Error(`Template lookup failed: ${existing.status} ${await existing.text()}`);
  const found = (await existing.json()) as { data?: Array<{ name?: string; status?: string }> };
  if (found.data?.some((t) => t.name === TEMPLATE_WORK_ORDER)) {
    logger.info({ template: TEMPLATE_WORK_ORDER }, "WhatsApp work-order template already exists");
    return;
  }
  const response = await fetch(base, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: TEMPLATE_WORK_ORDER,
      language: TEMPLATE_LANG,
      category: "UTILITY",
      components: [
        {
          type: "BODY",
          text: "أمر شغل جديد من قرطبة للتوريدات.\nالمندوب: {{1}}\nرقم أمر الشراء: {{2}}\nالمورد: {{3}}\nالأصناف: {{4}}\nموعد الاستلام: {{5}}\nيرجى اختيار أحد الأزرار أدناه لتأكيد الاستلام أو الرفض.",
          example: { body_text: [["أحمد محمد علي", "PO-2026-000001", "شركة النور", "1. صنف x2", "2026-08-15"]] },
        },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "تم الاستلام" },
            { type: "QUICK_REPLY", text: "مرفوض" },
          ],
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Template creation failed: ${response.status} ${await response.text()}`);
  logger.info({ template: TEMPLATE_WORK_ORDER }, "WhatsApp work-order template submitted to Meta for approval");
}

export const Whatsapp = APP_SECRET
  ? new WhatsAppAPI({
      token: TOKEN || "unconfigured",
      appSecret: APP_SECRET,
      webhookVerifyToken: WEBHOOK_VERIFY_TOKEN,
      secure: true,
    })
  : new WhatsAppAPI({
      token: TOKEN || "unconfigured",
      webhookVerifyToken: WEBHOOK_VERIFY_TOKEN,
      secure: false,
    });

class WhatsAppApiError extends Error {
  waCode?: number;
  constructor(message: string, waCode?: number) {
    super(message);
    this.name = "WhatsAppApiError";
    this.waCode = waCode;
  }
}

function requireConfigured(): void {
  if (!isWhatsAppConfigured) {
    throw new Error(
      "WhatsApp credentials not configured (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TOKEN)",
    );
  }
}

function normalizePhone(phone: string): string {
  // Strip invisible Unicode directional/formatting marks that paste in from WhatsApp/browsers
  // eslint-disable-next-line no-control-regex
  let cleaned = phone.replace(
    /[\u2066\u2067\u2068\u2069\u200e\u200f\u202a\u202b\u202c\u202d\u202e]/g,
    "",
  );
  cleaned = cleaned.replace(/[\s\-()]/g, "").replace(/\+/g, "");
  if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);
  if (cleaned.length === 11 && cleaned.startsWith("0")) cleaned = "2" + cleaned;
  if (cleaned.length === 10 && cleaned.startsWith("1")) cleaned = "20" + cleaned;
  return cleaned;
}

function extractPricingToken(pricingUrl: string): string {
  const parts = pricingUrl.split("/");
  return parts[parts.length - 1] || pricingUrl;
}

// Uploads a media buffer to Meta's Cloud API and returns the resulting media ID.
// The library doesn't expose a typed multipart-form helper for uploadMedia, so
// we use its authenticated `$$apiFetch$$` escape hatch — still the official,
// token-authenticated client, just for an operation the wrapper leaves generic.
export async function uploadWhatsAppMedia(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<string> {
  requireConfigured();
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", blob, filename);

  const res = await Whatsapp.$$apiFetch$$(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/media`,
    { method: "POST", body: form },
  );
  const json = (await res.json()) as { id?: string; error?: object };
  if (!res.ok || !json.id) {
    throw new Error(`WhatsApp media upload error ${res.status}: ${JSON.stringify(json)}`);
  }
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
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ {5,}/g, "    ")
    .trim();
}

function buildItemsSummary(opts: SendRfqOpts): string {
  const suffix = opts.items.length > 5 ? `، وغيرها (${opts.items.length} صنف)` : "";
  const summary =
    opts.items
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
  return sanitizeWaParam(
    `${opts.employeeName}${opts.employeePhone ? " — " + opts.employeePhone : ""}`,
  );
}

async function sendTemplate(to: string, template: Template): Promise<string> {
  requireConfigured();
  const result = await Whatsapp.sendMessage(PHONE_NUMBER_ID, to, template);
  if ("error" in result && result.error) {
    throw new WhatsAppApiError(`WhatsApp API error: ${JSON.stringify(result.error)}`);
  }
  return result.messages?.[0]?.id ?? "";
}

async function sendRfqTemplateUtility(to: string, opts: SendRfqOpts): Promise<string> {
  const pricingToken = extractPricingToken(opts.pricingUrl);
  const template = new Template(
    TEMPLATE_UTILITY,
    new Language(TEMPLATE_LANG),
    new BodyComponent(
      new BodyParameter(opts.toName),
      new BodyParameter(opts.rfqNo),
      new BodyParameter(buildItemsSummary(opts)),
      new BodyParameter(opts.closeDate),
      new BodyParameter(buildContactText(opts)),
    ),
    new URLComponent(pricingToken),
  );
  const waId = await sendTemplate(to, template);
  logger.info(
    { to, rfqNo: opts.rfqNo, waMessageId: waId },
    "RFQ UTILITY template sent via WhatsApp",
  );
  return waId;
}

async function sendRfqTemplateWithPdf(to: string, opts: SendRfqOpts): Promise<string> {
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
      setTimeout(() => rej(new Error("PDF generation timed out")), 12000),
    ),
  ]);
  const filename = `RFQ-${opts.rfqNo}.pdf`;
  const mediaId = await uploadWhatsAppMedia(pdfBuffer, filename, "application/pdf");
  const pricingToken = extractPricingToken(opts.pricingUrl);
  const template = new Template(
    TEMPLATE_PDF,
    new Language(TEMPLATE_LANG),
    new HeaderComponent(new HeaderParameter(new WADocument(mediaId, true, undefined, filename))),
    new BodyComponent(
      new BodyParameter(opts.toName),
      new BodyParameter(opts.rfqNo),
      new BodyParameter(opts.closeDate),
      new BodyParameter(buildContactText(opts)),
    ),
    new URLComponent(pricingToken),
  );
  const waId = await sendTemplate(to, template);
  logger.info({ to, rfqNo: opts.rfqNo, waMessageId: waId }, "RFQ PDF template sent via WhatsApp");
  return waId;
}

async function sendRfqTemplateTextOnly(to: string, opts: SendRfqOpts): Promise<string> {
  const pricingToken = extractPricingToken(opts.pricingUrl);
  const template = new Template(
    TEMPLATE_TEXT,
    new Language(TEMPLATE_LANG),
    new BodyComponent(
      new BodyParameter(opts.toName),
      new BodyParameter(opts.rfqNo),
      new BodyParameter(buildItemsSummary(opts)),
      new BodyParameter(opts.closeDate),
      new BodyParameter(buildContactText(opts)),
    ),
    new URLComponent(pricingToken),
  );
  const waId = await sendTemplate(to, template);
  logger.info(
    { to, rfqNo: opts.rfqNo, waMessageId: waId },
    "RFQ text-only template sent via WhatsApp",
  );
  return waId;
}

export async function sendRfqWhatsApp(
  opts: SendRfqOpts,
): Promise<{ pdfSent: boolean; usedTemplate: boolean; waMessageId: string | null }> {
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
    logger.warn(
      { err: textErr, to, rfqNo: opts.rfqNo },
      "rfq_send_ar failed — trying rfq_utility_ar",
    );
  }

  // Fallback 2: rfq_utility_ar
  try {
    const waId = await sendRfqTemplateUtility(to, opts);
    logger.info(
      { to, rfqNo: opts.rfqNo, waMessageId: waId },
      "RFQ sent via rfq_utility_ar template",
    );
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
  logger.error(
    { to, rfqNo: opts.rfqNo, methodErrors },
    "All WhatsApp templates failed — message NOT sent",
  );
  throw new Error(`فشل إرسال واتساب. الأخطاء: ${combined}`);
}

// ─── PO dispatch via WhatsApp ─────────────────────────────────────────────────
export interface SendPoOpts {
  phone: string;
  supplierName: string;
  contactPerson?: string | null;
  poNo: string;
  poDate?: string | null;
  receiverName?: string | null;
  receiverPhone?: string | null;
  employeeName: string;
  employeePhone?: string | null;
  notes?: string | null;
  items: Array<{
    lineItem?: string | null;
    partNo?: string | null;
    description: string;
    qty?: string | number | null;
    uom?: string | null;
    unitPrice?: string | number | null;
  }>;
}

function buildPoContactText(opts: SendPoOpts): string {
  return sanitizeWaParam(
    `${opts.employeeName}${opts.employeePhone ? " — " + opts.employeePhone : ""}`,
  );
}

/**
 * Sends a PO PDF to a supplier via WhatsApp using the `po_pdf_ar` approved template.
 * Template structure:
 *   Header  : DOCUMENT (PDF attachment)
 *   Body    : {{1}} supplier name, {{2}} PO number, {{3}} employee contact
 * Falls back to a plain document message if the template call fails
 * (works within 24-hour conversation window).
 */
export async function sendPoWhatsApp(opts: SendPoOpts): Promise<string | null> {
  requireConfigured();
  const to = normalizePhone(opts.phone);

  // Generate PDF once — shared by template attempt and fallback
  const pdfBuffer = await Promise.race<Buffer>([
    generatePoPdf({
      poNo: opts.poNo,
      poDate: opts.poDate,
      supplierName: opts.supplierName,
      contactPerson: opts.contactPerson,
      receiverName: opts.receiverName,
      receiverPhone: opts.receiverPhone,
      employeeName: opts.employeeName,
      employeePhone: opts.employeePhone,
      notes: opts.notes,
      items: opts.items,
    }),
    new Promise<Buffer>((_, rej) =>
      setTimeout(() => rej(new Error("PO PDF generation timed out")), 12000),
    ),
  ]);

  const filename = `PO-${opts.poNo}.pdf`;
  const mediaId = await uploadWhatsAppMedia(pdfBuffer, filename, "application/pdf");

  // Use || (not ??) so empty strings fall through to supplierName
  const toName = sanitizeWaParam(opts.contactPerson?.trim() || opts.supplierName);

  // Primary: po_pdf_ar approved template (works outside 24h window)
  // Template body has exactly 3 parameters:
  //   {{1}} = supplier / contact name
  //   {{2}} = PO number
  //   {{3}} = employee contact info
  try {
    const template = new Template(
      TEMPLATE_PO_PDF,
      new Language(TEMPLATE_LANG),
      new HeaderComponent(new HeaderParameter(new WADocument(mediaId, true, undefined, filename))),
      new BodyComponent(
        new BodyParameter(toName), // {{1}} supplier / contact name
        new BodyParameter(opts.poNo), // {{2}} PO number
        new BodyParameter(buildPoContactText(opts)), // {{3}} employee contact
      ),
    );
    const waId = await sendTemplate(to, template);
    logger.info({ to, poNo: opts.poNo, waId }, "PO sent via po_pdf_ar template");
    return waId || null;
  } catch (templateErr) {
    const msg = templateErr instanceof Error ? templateErr.message : String(templateErr);
    logger.error(
      { err: templateErr, to, poNo: opts.poNo },
      "po_pdf_ar template failed — message NOT sent",
    );
    // NOTE: We intentionally do NOT fall back to a direct document send.
    // Direct document messages are silently accepted by the WhatsApp API
    // (returns a wamid) but are NEVER delivered to recipients who haven't
    // had an active conversation in the last 24 hours.
    // This creates a false "✓ أُرسل" in the UI while the supplier receives nothing.
    // Instead we throw so the UI correctly shows "✗ فشل" with the real error.
    throw new Error(`فشل إرسال واتساب — قالب ${TEMPLATE_PO_PDF} فشل: ${msg}`);
  }
}

// Returns the WhatsApp message ID (wamid) so callers can store it for later deletion.
export interface SendRepresentativeWorkOrderOpts {
  phone: string;
  representativeName: string;
  poNo: string;
  supplierName: string;
  receiverName?: string | null;
  receiverPhone?: string | null;
  itemsSummary: string;
  deliveryDate?: string | null;
}

/** Sends the approved Meta template with quick-reply buttons. The template must be approved first. */
export async function sendRepresentativeWorkOrderWhatsApp(
  opts: SendRepresentativeWorkOrderOpts,
): Promise<string | null> {
  requireConfigured();
  const to = normalizePhone(opts.phone);
  const template = new Template(
    TEMPLATE_WORK_ORDER,
    new Language(TEMPLATE_LANG),
    new BodyComponent(
      new BodyParameter(opts.representativeName),
      new BodyParameter(opts.poNo),
      new BodyParameter(sanitizeWaParam(opts.supplierName)),
      new BodyParameter(sanitizeWaParam(opts.itemsSummary)),
      new BodyParameter(sanitizeWaParam(opts.deliveryDate || "غير محدد")),
    ),
    new PayloadComponent(`work_order:${opts.poNo}:received`),
    new PayloadComponent(`work_order:${opts.poNo}:rejected`),
  );
  const waId = await sendTemplate(to, template);
  logger.info({ to, poNo: opts.poNo, waId }, "Representative work order sent via WhatsApp");
  return waId || null;
}

export async function sendWhatsAppInteractiveConfirmation(
  phone: string,
  poNo: string,
  action: "received" | "rejected",
): Promise<string | null> {
  requireConfigured();
  const to = normalizePhone(phone);
  const title = action === "received" ? "تأكيد الاستلام" : "تأكيد الرفض";
  const body = action === "received"
    ? `هل تؤكد استلام أمر الشغل ${poNo}؟`
    : `هل تؤكد رفض أمر الشغل ${poNo}؟`;
  const message = new Interactive(
    new ActionButtons(
      new Button(`work_order:${poNo}:${action}:confirm`, title),
      new Button(`work_order:${poNo}:${action}:cancel`, "تراجع"),
    ),
    new Body(body),
  );
  const result = await Whatsapp.sendMessage(PHONE_NUMBER_ID, to, message);
  if ("error" in result && result.error) {
    throw new WhatsAppApiError(`WhatsApp API error: ${JSON.stringify(result.error)}`);
  }
  return result.messages?.[0]?.id ?? null;
}

export async function sendWhatsAppText(phone: string, text: string): Promise<string | null> {
  requireConfigured();
  const to = normalizePhone(phone);
  const result = await Whatsapp.sendMessage(PHONE_NUMBER_ID, to, new Text(text));
  if ("error" in result && result.error) {
    throw new WhatsAppApiError(`WhatsApp API error: ${JSON.stringify(result.error)}`);
  }
  logger.info({ to }, "WhatsApp text sent");
  return result.messages?.[0]?.id ?? null;
}

export async function markWhatsAppRead(messageId: string): Promise<void> {
  if (!isWhatsAppConfigured) return;
  try {
    await Whatsapp.markAsRead(PHONE_NUMBER_ID, messageId);
  } catch {
    // non-critical
  }
}
