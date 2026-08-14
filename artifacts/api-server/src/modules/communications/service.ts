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
  ActionList,
  ListSection,
  Row,
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
export const TEMPLATE_WORK_ORDER = process.env.WHATSAPP_TEMPLATE_WORK_ORDER || "representative_work_order_ar_v2";
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
          text: "أمر شغل جديد من قرطبة للتوريدات.\nالمندوب: {{1}}\nرقم أمر الشراء: {{2}}\nالمورد: {{3}}\nهاتف المورد: {{4}}\nعنوان المورد: {{5}}\nالأصناف: {{6}}\nموعد الاستلام: {{7}}\nيرجى اختيار أحد الأزرار أدناه لتأكيد الاستلام أو الرفض.",
          example: { body_text: [["أحمد محمد علي", "PO-2026-000001", "شركة النور", "+201000000000", "القاهرة، مصر", "1. صنف x2", "2026-08-15"]] },
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

/** Trim a NUMERIC qty string so "3.0000" → "3", "3.50" → "3.5". */
export function formatQty(qty: string | null | undefined): string | null {
  if (qty == null) return null;
  const s = String(qty).trim();
  if (s === "") return null;
  if (!s.includes(".")) return s;
  const trimmed = s.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" ? "0" : trimmed;
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
  supplierPhone?: string | null;
  supplierAddress?: string | null;
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
      new BodyParameter(sanitizeWaParam(opts.supplierPhone || "غير مسجل")),
      new BodyParameter(sanitizeWaParam(opts.supplierAddress || "غير مسجل")),
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

/**
 * Consolidated per-PO representative dispatch notification. Sends ONE interactive
 * message listing the supplier (name / address / phone), the PO number, and ALL
 * its pending line items (with clean quantities). A single «بدء الاستلام» button
 * opens the rep-bot receipt menu (payload rep_menu:receipt), where the PO picker
 * → item picker shows every pending item. This replaces the old per-item prompts
 * (which could drop items when a rapid second WhatsApp send was rate-limited) and
 * guarantees all items appear because the assignment rows are created up front by
 * the dispatch route regardless of send success.
 */
export async function sendRepPoDispatchWhatsApp(opts: {
  phone: string;
  poNo: string;
  supplierName: string;
  supplierAddress?: string | null;
  supplierPhone?: string | null;
  items: Array<{ lineItem?: string | null; description?: string | null; qty?: string | null; uom?: string | null }>;
}): Promise<string | null> {
  requireConfigured();
  const to = normalizePhone(opts.phone);
  const lines: string[] = [];
  lines.push(`أمر شراء جديد للمندوب`);
  lines.push(`رقم الأمر: ${opts.poNo}`);
  lines.push(`المورد: ${opts.supplierName}`);
  if (opts.supplierAddress?.trim()) lines.push(`عنوان المورد: ${opts.supplierAddress.trim()}`);
  if (opts.supplierPhone?.trim()) lines.push(`هاتف المورد: ${opts.supplierPhone.trim()}`);
  lines.push("");
  lines.push("البنود:");
  opts.items.slice(0, 20).forEach((it, i) => {
    const label = [it.lineItem || String(i + 1), it.description].filter(Boolean).join(" — ") || `بند ${i + 1}`;
    const qty = formatQty(it.qty);
    const qtyText = qty ? ` × ${qty}${it.uom ? " " + it.uom : ""}` : "";
    lines.push(`${i + 1}. ${label}${qtyText}`);
  });
  if (opts.items.length > 20) lines.push(`…و ${opts.items.length - 20} بند آخر`);
  lines.push("");
  lines.push("اضغط «بدء الاستلام» لتأكيد استلام البنود.");
  const body = lines.join("\n");
  const message = new Interactive(
    new ActionButtons(new Button("rep_menu:receipt", "بدء الاستلام")),
    new Body(body),
  );
  const result = await Whatsapp.sendMessage(PHONE_NUMBER_ID, to, message);
  if ("error" in result && result.error) {
    throw new WhatsAppApiError(`WhatsApp API error: ${JSON.stringify(result.error)}`);
  }
  return result.messages?.[0]?.id ?? null;
}

/**
 * Per-item goods-receipt prompt. Sends a simple interactive-button message for
 * ONE supplier PO line so the representative can confirm receipt or rejection
 * directly from WhatsApp. The payload encodes the poItemId so the inbound
 * handler can record the receipt against the exact line:
 *   work_order_item:<poNo>:<poItemId>:received
 *   work_order_item:<poNo>:<poItemId>:rejected
 */
export async function sendRepresentativeItemReceiptWhatsApp(opts: {
  phone: string;
  poNo: string;
  poItemId: number;
  lineLabel: string; // e.g. "بند 3 - وصف البند"
  qty?: string | null;
}): Promise<string | null> {
  requireConfigured();
  const to = normalizePhone(opts.phone);
  const qtyText = opts.qty ? ` — الكمية: ${opts.qty}` : "";
  const body = `استلام التوريدات\nأمر الشراء: ${opts.poNo}\n${opts.lineLabel}${qtyText}\nهل تم الاستلام؟`;
  const message = new Interactive(
    new ActionButtons(
      new Button(`work_order_item:${opts.poNo}:${opts.poItemId}:received`, "تم الاستلام"),
      new Button(`work_order_item:${opts.poNo}:${opts.poItemId}:rejected`, "رفض"),
    ),
    new Body(body),
  );
  const result = await Whatsapp.sendMessage(PHONE_NUMBER_ID, to, message);
  if ("error" in result && result.error) {
    throw new WhatsAppApiError(`WhatsApp API error: ${JSON.stringify(result.error)}`);
  }
  return result.messages?.[0]?.id ?? null;
}

/**
 * Sends the rejection-reason picker as an interactive list after the
 * representative taps "رفض" on a line. Payload per option:
 *   work_order_reason:<poNo>:<poItemId>:<reason>
 */
export async function sendRejectionReasonOptions(
  phone: string,
  poNo: string,
  poItemId: number,
  reasons: readonly string[],
): Promise<string | null> {
  requireConfigured();
  const to = normalizePhone(phone);
  const rows = reasons.map(
    (r, i) =>
      new Row(
        `work_order_reason:${poNo}:${poItemId}:${encodeURIComponent(r)}`,
        `${i + 1}. ${r}`,
        "",
      ),
  );
  // ListSection expects AtLeastOne<Row> ([T, ...T[]]); split into a guaranteed
  // non-empty tuple so the spread type-checks.
  const [firstRow, ...restRows] = rows;
  const message = new Interactive(
    new ActionList(
      "اختر سبب الرفض",
      new ListSection("أسباب الرفض", firstRow, ...restRows),
    ),
    new Body(`تم اختيار الرفض لبند في أمر الشراء ${poNo}.\nاختر سبب الرفض:`),
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

// ─── Representative bot (interactive list menus) ───────────────────────────
// The rep bot is a menu-driven conversation: the rep opens the WhatsApp list
// (or sends any text), gets a main menu, then drills into POs → items → action.
// Payloads are prefixed `rep_` so they never collide with work_order_* flows.

/** Main menu shown when a registered representative sends any text/taps the list.
 * Two action buttons: استلام (receipt from supplier) / تسليم (delivery to customer). */
export async function sendRepMainMenu(phone: string, counts?: {
  receipt: number;
  delivery: number;
}): Promise<string | null> {
  requireConfigured();
  const to = normalizePhone(phone);
  const r = counts?.receipt ?? 0;
  const d = counts?.delivery ?? 0;
  const body = `مرحباً 👋\nاختر المهمة للبدء.${r || d ? `\nاستلام: ${r} — تسليم: ${d}` : ""}`;
  const message = new Interactive(
    new ActionButtons(
      new Button("rep_menu:receipt", "استلام"),
      new Button("rep_menu:delivery", "تسليم"),
    ),
    new Body(body),
  );
  const result = await Whatsapp.sendMessage(PHONE_NUMBER_ID, to, message);
  if ("error" in result && result.error) {
    throw new WhatsAppApiError(`WhatsApp API error: ${JSON.stringify(result.error)}`);
  }
  return result.messages?.[0]?.id ?? null;
}

/**
 * List the POs assigned to this representative that still have pending lines
 * of the given kind. Each row opens the item picker for that PO. A «رجوع» row
 * returns to the main menu. Uses buttons (≤3 POs) or a list (4–10 POs).
 */
export async function sendRepPoPicker(
  phone: string,
  kind: "receipt" | "delivery",
  pos: Array<{ id: number; no: string; label: string; pendingItems: number }>,
): Promise<string | null> {
  requireConfigured();
  const to = normalizePhone(phone);
  const emptyMsg = kind === "receipt"
    ? "لا توجد أوامر شراء بانتظار الاستلام حالياً."
    : "لا توجد بنود بانتظار التسليم للعميل حالياً.";
  if (pos.length === 0) {
    return sendWhatsAppText(phone, emptyMsg);
  }
  const title = kind === "receipt" ? "أوامر شراء بانتظار الاستلام" : "أوامر شراء العميل بانتظار التسليم";
  // ≤2 POs → buttons (plus a رجوع button = max 3 total WhatsApp allows).
  if (pos.length <= 2) {
    const back = new Button("rep_back:menu", "رجوع");
    const p0 = new Button(`rep_po:${kind}:${pos[0].id}`, pos[0].no.slice(0, 20));
    const message =
      pos.length === 1
        ? new Interactive(new ActionButtons(p0, back), new Body(`${title}:\nاختر الأمر.`))
        : new Interactive(
            new ActionButtons(p0, new Button(`rep_po:${kind}:${pos[1].id}`, pos[1].no.slice(0, 20)), back),
            new Body(`${title}:\nاختر الأمر.`),
          );
    const result = await Whatsapp.sendMessage(PHONE_NUMBER_ID, to, message);
    if ("error" in result && result.error) throw new WhatsAppApiError(`WhatsApp API error: ${JSON.stringify(result.error)}`);
    return result.messages?.[0]?.id ?? null;
  }
  // >2 POs → list (each row tappable) + a رجوع row.
  const rows = pos.slice(0, 9).map(
    (p) => new Row(`rep_po:${kind}:${p.id}`, `${p.no} — ${p.label}`, `${p.pendingItems} بند بانتظار`),
  );
  rows.push(new Row("rep_back:menu", "رجوع للقائمة الرئيسية", ""));
  const [first, ...rest] = rows;
  const message = new Interactive(
    new ActionList("اختر أمر شغل", new ListSection(title, first, ...rest)),
    new Body(`اختر الأمر الذي تريد العمل عليه:`),
  );
  const result = await Whatsapp.sendMessage(PHONE_NUMBER_ID, to, message);
  if ("error" in result && result.error) {
    throw new WhatsAppApiError(`WhatsApp API error: ${JSON.stringify(result.error)}`);
  }
  return result.messages?.[0]?.id ?? null;
}

/**
 * List the line items of one PO awaiting the representative's action. A «رجوع»
 * row returns to the PO picker. Buttons (≤2 items) or a list (3–10 items).
 */
export async function sendRepItemPicker(
  phone: string,
  kind: "receipt" | "delivery",
  poId: number,
  items: Array<{ id: number; label: string; qty: string | null; statusHint: string }>,
): Promise<string | null> {
  requireConfigured();
  const to = normalizePhone(phone);
  if (items.length === 0) {
    return sendWhatsAppText(phone, "لا توجد بنود بانتظار الإجراء في هذا الأمر.");
  }
  const title = kind === "receipt" ? "بنود بانتظار الاستلام" : "بنود بانتظار التسليم";
  if (items.length <= 2) {
    const back = new Button(`rep_back:po:${kind}`, "رجوع");
    const i0 = new Button(`rep_item:${kind}:${poId}:${items[0].id}`, items[0].label.slice(0, 20));
    const message =
      items.length === 1
        ? new Interactive(new ActionButtons(i0, back), new Body(`${title}:\nاختر البند.`))
        : new Interactive(
            new ActionButtons(i0, new Button(`rep_item:${kind}:${poId}:${items[1].id}`, items[1].label.slice(0, 20)), back),
            new Body(`${title}:\nاختر البند.`),
          );
    const result = await Whatsapp.sendMessage(PHONE_NUMBER_ID, to, message);
    if ("error" in result && result.error) throw new WhatsAppApiError(`WhatsApp API error: ${JSON.stringify(result.error)}`);
    return result.messages?.[0]?.id ?? null;
  }
  const rows = items.slice(0, 9).map(
    (it) =>
      new Row(
        `rep_item:${kind}:${poId}:${it.id}`,
        it.label.slice(0, 24),
        `${it.qty ? `الكمية: ${it.qty} — ` : ""}${it.statusHint}`,
      ),
  );
  rows.push(new Row(`rep_back:po:${kind}`, "رجوع لقائمة الأوامر", ""));
  const [first, ...rest] = rows;
  const message = new Interactive(
    new ActionList("اختر بند", new ListSection(title, first, ...rest)),
    new Body("اختر البند الذي تريد تسجيل إجراء له:"),
  );
  const result = await Whatsapp.sendMessage(PHONE_NUMBER_ID, to, message);
  if ("error" in result && result.error) {
    throw new WhatsAppApiError(`WhatsApp API error: ${JSON.stringify(result.error)}`);
  }
  return result.messages?.[0]?.id ?? null;
}

/**
 * Action buttons for a single line item:
 *  - receipt: «تم الاستلام» / «رفض» / «رجوع»
 *  - delivery: «تم التسليم» / «رفض العميل» / «رجوع»
 * Payloads reuse work_order_item: (receipt) / work_order_delivery: (delivery)
 * so the existing handlers record them. The «رجوع» button re-sends the item
 * picker for the same PO (payload rep_back:item:<kind>:<poId>).
 */
export async function sendRepItemAction(
  phone: string,
  opts: {
    kind: "receipt" | "delivery";
    no: string;          // poNo (receipt) or customerPoNo (delivery)
    itemId: number;      // poItemId (receipt) or customerPoItemId (delivery)
    poId: number;        // for the رجوع button (re-send item picker)
    label: string;
    qty?: string | null;
  },
): Promise<string | null> {
  requireConfigured();
  const to = normalizePhone(phone);
  const qtyText = opts.qty ? ` — الكمية: ${opts.qty}` : "";
  const back = new Button(`rep_back:item:${opts.kind}:${opts.poId}`, "رجوع");
  if (opts.kind === "receipt") {
    const body = `استلام من مورد\nأمر الشراء: ${opts.no}\n${opts.label}${qtyText}\nهل تم الاستلام؟`;
    const message = new Interactive(
      new ActionButtons(
        new Button(`work_order_item:${opts.no}:${opts.itemId}:received`, "تم الاستلام"),
        new Button(`work_order_item:${opts.no}:${opts.itemId}:rejected`, "رفض"),
        back,
      ),
      new Body(body),
    );
    const result = await Whatsapp.sendMessage(PHONE_NUMBER_ID, to, message);
    if ("error" in result && result.error) {
      throw new WhatsAppApiError(`WhatsApp API error: ${JSON.stringify(result.error)}`);
    }
    return result.messages?.[0]?.id ?? null;
  }
  // delivery
  const body = `تسليم للعميل\nأمر شراء العميل: ${opts.no}\n${opts.label}${qtyText}\nهل تم التسليم للعميل؟`;
  const message = new Interactive(
    new ActionButtons(
      new Button(`work_order_delivery:${opts.no}:${opts.itemId}:delivered`, "تم التسليم"),
      new Button(`work_order_delivery:${opts.no}:${opts.itemId}:customer_rejected`, "رفض العميل"),
      back,
    ),
    new Body(body),
  );
  const result = await Whatsapp.sendMessage(PHONE_NUMBER_ID, to, message);
  if ("error" in result && result.error) {
    throw new WhatsAppApiError(`WhatsApp API error: ${JSON.stringify(result.error)}`);
  }
  return result.messages?.[0]?.id ?? null;
}

/**
 * Confirmation message for a receipt/delivery action: «تأكيد» records the
 * action, «تراجع» returns to the item's action buttons (re-sent by the
 * cancel handler, which looks up the PO from the item id).
 *   receipt:  work_order_confirm_item:<poNo>:<poItemId>:received / work_order_cancel_item:<poNo>:<poItemId>
 *   delivery: work_order_confirm_delivery:<customerPoNo>:<customerPoItemId>:delivered / work_order_cancel_delivery:<customerPoNo>:<customerPoItemId>
 */
export async function sendRepConfirm(
  phone: string,
  opts: {
    kind: "receipt" | "delivery";
    no: string;
    itemId: number;
    action: "received" | "delivered";
  },
): Promise<string | null> {
  requireConfigured();
  const to = normalizePhone(phone);
  const body =
    opts.kind === "receipt"
      ? `هل تؤكد استلام البند في أمر الشراء ${opts.no}؟`
      : `هل تؤكد تسليم البند للعميل في أمر شراء العميل ${opts.no}؟`;
  const confirmPayload =
    opts.kind === "receipt"
      ? `work_order_confirm_item:${opts.no}:${opts.itemId}:${opts.action}`
      : `work_order_confirm_delivery:${opts.no}:${opts.itemId}:${opts.action}`;
  const cancelPayload =
    opts.kind === "receipt"
      ? `work_order_cancel_item:${opts.no}:${opts.itemId}`
      : `work_order_cancel_delivery:${opts.no}:${opts.itemId}`;
  const message = new Interactive(
    new ActionButtons(
      new Button(confirmPayload, "تأكيد"),
      new Button(cancelPayload, "تراجع"),
    ),
    new Body(body),
  );
  const result = await Whatsapp.sendMessage(PHONE_NUMBER_ID, to, message);
  if ("error" in result && result.error) {
    throw new WhatsAppApiError(`WhatsApp API error: ${JSON.stringify(result.error)}`);
  }
  return result.messages?.[0]?.id ?? null;
}

/**
 * Delivery rejection-reason picker (reasons the *customer* refused), shown after
 * the rep taps "رفض العميل". Payload per option:
 *   work_order_delivery_reason:<customerPoNo>:<customerPoItemId>:<reason>
 */
export const CUSTOMER_REJECTION_REASONS = [
  "تالف",
  "خطأ في الصنف",
  "كمية أقل",
  "متأخر عن الموعد",
  "مواصفات غير مطابقة",
] as const;

export async function sendDeliveryRejectionReasonOptions(
  phone: string,
  customerPoNo: string,
  customerPoItemId: number,
  reasons: readonly string[] = CUSTOMER_REJECTION_REASONS,
): Promise<string | null> {
  requireConfigured();
  const to = normalizePhone(phone);
  const rows = reasons.map(
    (r, i) =>
      new Row(
        `work_order_delivery_reason:${customerPoNo}:${customerPoItemId}:${encodeURIComponent(r)}`,
        `${i + 1}. ${r}`,
        "",
      ),
  );
  const [firstRow, ...restRows] = rows;
  const message = new Interactive(
    new ActionList(
      "اختر سبب الرفض",
      new ListSection("أسباب رفض العميل", firstRow, ...restRows),
    ),
    new Body(`تم اختيار رفض العميل لبند في أمر شراء العميل ${customerPoNo}.\nاختر سبب الرفض:`),
  );
  const result = await Whatsapp.sendMessage(PHONE_NUMBER_ID, to, message);
  if ("error" in result && result.error) {
    throw new WhatsAppApiError(`WhatsApp API error: ${JSON.stringify(result.error)}`);
  }
  return result.messages?.[0]?.id ?? null;
}
