/**
 * Odoo XML-RPC Connector
 * يتصل بـ Odoo عبر XML-RPC API (Odoo 14+)
 * Docs: https://www.odoo.com/documentation/17.0/developer/reference/external_api.html
 */

export interface OdooConfig {
  url: string; // https://mycompany.odoo.com
  db: string; // اسم قاعدة البيانات في Odoo
  username: string; // البريد الإلكتروني
  apiKey: string; // API Key من إعدادات المستخدم
}

// ─── XML-RPC Client بسيط بدون مكتبات خارجية ───────────────────────────────

function xmlValue(val: unknown): string {
  if (val === null || val === undefined) return `<value><boolean>0</boolean></value>`;
  if (typeof val === "boolean") return `<value><boolean>${val ? 1 : 0}</boolean></value>`;
  if (typeof val === "number")
    return Number.isInteger(val)
      ? `<value><int>${val}</int></value>`
      : `<value><double>${val}</double></value>`;
  if (typeof val === "string") return `<value><string>${escXml(val)}</string></value>`;
  if (Array.isArray(val)) {
    return `<value><array><data>${val.map(xmlValue).join("")}</data></array></value>`;
  }
  if (typeof val === "object") {
    const members = Object.entries(val as Record<string, unknown>)
      .map(([k, v]) => `<member><name>${escXml(k)}</name>${xmlValue(v)}</member>`)
      .join("");
    return `<value><struct>${members}</struct></value>`;
  }
  return `<value><string>${escXml(String(val))}</string></value>`;
}

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildCall(method: string, params: unknown[]): string {
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params
    .map((p) => `<param>${xmlValue(p)}</param>`)
    .join("")}</params></methodCall>`;
}

function parseXmlValue(node: string): unknown {
  const inner = node
    .replace(/^\s*<value>\s*/, "")
    .replace(/\s*<\/value>\s*$/, "")
    .trim();
  if (inner.startsWith("<int>") || inner.startsWith("<i4>"))
    return parseInt(inner.replace(/<\/?(?:int|i4)>/g, ""), 10);
  if (inner.startsWith("<double>")) return parseFloat(inner.replace(/<\/?double>/g, ""));
  if (inner.startsWith("<boolean>")) return inner.includes("1");
  if (inner.startsWith("<string>"))
    return inner
      .replace(/<\/?string>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  if (inner.startsWith("<array>")) {
    const matches = inner.match(/<value>[\s\S]*?<\/value>/g) ?? [];
    return matches.map(parseXmlValue);
  }
  if (inner.startsWith("<struct>")) {
    const result: Record<string, unknown> = {};
    const memberRe = /<member><name>([^<]+)<\/name>([\s\S]*?)<\/member>/g;
    let m: RegExpExecArray | null;
    while ((m = memberRe.exec(inner)) !== null) {
      const valueMatch = m[2].match(/<value>[\s\S]*?<\/value>/);
      result[m[1]] = valueMatch ? parseXmlValue(valueMatch[0]) : null;
    }
    return result;
  }
  // raw text (untyped string)
  return inner.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function xmlRpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const body = buildCall(method, params);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/xml", "User-Agent": "RFQ-Manager/1.0" },
    body,
  });
  if (!res.ok) throw new Error(`XML-RPC HTTP error ${res.status} at ${url}`);
  const xml = await res.text();
  if (xml.includes("<fault>")) {
    const msgMatch = xml.match(/<name>faultString<\/name>\s*<value><string>([^<]+)<\/string>/);
    throw new Error(`Odoo fault: ${msgMatch?.[1] ?? "unknown"}`);
  }
  const valueMatch = xml.match(/<params><param>(<value>[\s\S]*?<\/value>)<\/param>/);
  if (!valueMatch) throw new Error("Could not parse XML-RPC response");
  return parseXmlValue(valueMatch[1]);
}

// ─── Odoo Client ────────────────────────────────────────────────────────────

async function authenticate(cfg: OdooConfig): Promise<number> {
  const uid = await xmlRpcCall(`${cfg.url}/xmlrpc/2/common`, "authenticate", [
    cfg.db,
    cfg.username,
    cfg.apiKey,
    {},
  ]);
  if (typeof uid !== "number" || uid === 0)
    throw new Error("Odoo authentication failed — تحقق من الـ URL والـ API Key");
  return uid;
}

async function callObject(
  cfg: OdooConfig,
  uid: number,
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
): Promise<unknown> {
  return xmlRpcCall(`${cfg.url}/xmlrpc/2/object`, "execute_kw", [
    cfg.db,
    uid,
    cfg.apiKey,
    model,
    method,
    args,
    kwargs,
  ]);
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ErpSupplier {
  externalId: string;
  name: string;
  contactPerson?: string;
  email?: string;
  phone?: string;
  address?: string;
  category?: string;
}

export interface ErpPurchaseOrder {
  externalId: string;
  name: string;
  supplierName: string;
  status: string;
  lines: { description: string; qty: number; price: number; uom?: string }[];
}

/** اختبار الاتصال */
export async function testConnection(
  cfg: OdooConfig,
): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const info = (await xmlRpcCall(`${cfg.url}/xmlrpc/2/common`, "version", [])) as Record<
      string,
      unknown
    >;
    await authenticate(cfg);
    return { ok: true, version: String(info.server_version ?? "") };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** استيراد الموردين من Odoo */
export async function importSuppliers(cfg: OdooConfig): Promise<ErpSupplier[]> {
  const uid = await authenticate(cfg);
  // فلترة على الشركاء الموردين فقط (supplier_rank > 0)
  const ids = (await callObject(
    cfg,
    uid,
    "res.partner",
    "search",
    [
      [
        ["supplier_rank", ">", 0],
        ["active", "=", true],
      ],
    ],
    { limit: 500 },
  )) as number[];

  if (!ids.length) return [];

  const records = (await callObject(cfg, uid, "res.partner", "read", [ids], {
    fields: ["id", "name", "email", "phone", "street", "city", "category_id", "child_ids"],
  })) as Record<string, unknown>[];

  return records.map((r) => ({
    externalId: `odoo-${r.id}`,
    name: String(r.name ?? ""),
    email: r.email ? String(r.email) : undefined,
    phone: r.phone ? String(r.phone) : undefined,
    address: [r.street, r.city].filter(Boolean).join(", ") || undefined,
    category:
      Array.isArray(r.category_id) && r.category_id.length > 1
        ? String(r.category_id[1])
        : undefined,
  }));
}

/** تصدير RFQ كـ Purchase Request إلى Odoo */
export async function exportRfq(
  cfg: OdooConfig,
  rfq: {
    name: string;
    notes?: string;
    lines: { description: string; qty?: number; uom?: string; price?: number }[];
    supplierOdooId?: number;
  },
): Promise<string> {
  const uid = await authenticate(cfg);
  // في Odoo، نُنشئ Purchase Order بحالة draft
  const poId = (await callObject(cfg, uid, "purchase.order", "create", [
    {
      partner_id: rfq.supplierOdooId ?? 1,
      notes: rfq.notes ?? `RFQ: ${rfq.name}`,
      order_line: rfq.lines.map((l) => [
        0,
        0,
        {
          name: l.description,
          product_qty: l.qty ?? 1,
          price_unit: l.price ?? 0,
        },
      ]),
    },
  ])) as number;
  return String(poId);
}

/** تصدير أمر شراء إلى Odoo */
export async function exportPurchaseOrder(
  cfg: OdooConfig,
  po: {
    name: string;
    supplierOdooId?: number;
    lines: { description: string; qty?: number; price?: number }[];
  },
): Promise<string> {
  const uid = await authenticate(cfg);
  const poId = (await callObject(cfg, uid, "purchase.order", "create", [
    {
      partner_id: po.supplierOdooId ?? 1,
      state: "purchase",
      order_line: po.lines.map((l) => [
        0,
        0,
        {
          name: l.description,
          product_qty: l.qty ?? 1,
          price_unit: l.price ?? 0,
        },
      ]),
    },
  ])) as number;
  // تأكيد الأمر
  await callObject(cfg, uid, "purchase.order", "button_confirm", [[poId]]);
  return String(poId);
}

/** استيراد أوامر الشراء من Odoo */
export async function importPurchaseOrders(cfg: OdooConfig): Promise<ErpPurchaseOrder[]> {
  const uid = await authenticate(cfg);
  const ids = (await callObject(
    cfg,
    uid,
    "purchase.order",
    "search",
    [[["state", "in", ["draft", "sent", "purchase"]]]],
    { limit: 200 },
  )) as number[];
  if (!ids.length) return [];
  const records = (await callObject(cfg, uid, "purchase.order", "read", [ids], {
    fields: ["id", "name", "partner_id", "state", "order_line"],
  })) as Record<string, unknown>[];
  return records.map((r) => ({
    externalId: `odoo-po-${r.id}`,
    name: String(r.name ?? ""),
    supplierName: Array.isArray(r.partner_id) ? String(r.partner_id[1]) : "",
    status: String(r.state ?? ""),
    lines: [],
  }));
}
