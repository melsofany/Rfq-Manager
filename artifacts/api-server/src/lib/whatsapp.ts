import { logger } from "./logger";

const WHATSAPP_API_VERSION = "v19.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

function apiUrl(): string {
  return `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${PHONE_NUMBER_ID}/messages`;
}

async function postMessage(body: object): Promise<void> {
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WhatsApp API error ${res.status}: ${text}`);
  }
}

// Normalize phone: strip spaces/dashes, ensure starts with country code (no +)
function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-()]/g, "").replace(/^\+/, "");
}

export async function sendRfqWhatsApp(opts: {
  phone: string;
  toName: string;
  rfqNo: string;
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
}): Promise<void> {
  const to = normalizePhone(opts.phone);

  const itemLines = opts.items
    .map((item, i) => {
      const line = item.lineItem || String(i + 1);
      const part = item.partNo ? ` [${item.partNo}]` : "";
      const qty = item.qty ? ` — الكمية: ${item.qty}${item.uom ? " " + item.uom : ""}` : "";
      return `${line}. ${item.description}${part}${qty}`;
    })
    .join("\n");

  const message = [
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

  await postMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: message, preview_url: false },
  });

  logger.info({ to, rfqNo: opts.rfqNo }, "RFQ WhatsApp sent");
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
