/**
 * Oracle ERP Cloud Connector
 * يستخدم Oracle Procurement REST APIs
 *
 * Docs: https://docs.oracle.com/en/cloud/saas/procurement/23d/farpr/
 *
 * Base URL: https://{hostname}/fscmRestApi/resources/11.13.18.05
 */

export interface OracleConfig {
  url: string; // https://efgh-dev1.fa.em2.oraclecloud.com
  username: string; // اسم المستخدم
  password: string; // كلمة المرور
  businessUnit?: string; // وحدة الأعمال الافتراضية
}

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

const BASE = "/fscmRestApi/resources/11.13.18.05";

function headers(cfg: OracleConfig): Record<string, string> {
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
  return {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function oraGet(
  cfg: OracleConfig,
  path: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const qs = new URLSearchParams({ limit: "100", ...params }).toString();
  const res = await fetch(`${cfg.url}${BASE}/${path}?${qs}`, { headers: headers(cfg) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Oracle GET /${path} failed (${res.status}): ${txt.slice(0, 300)}`);
  }
  return res.json();
}

async function oraPost(cfg: OracleConfig, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${cfg.url}${BASE}/${path}`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Oracle POST /${path} failed (${res.status}): ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function testConnection(
  cfg: OracleConfig,
): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    // نستخدم endpoint بسيط للتحقق
    await oraGet(cfg, "supplyChainFinancialOrchestrationSuppliers", { limit: "1" });
    return { ok: true, version: "Oracle ERP Cloud" };
  } catch (e) {
    // جرب endpoint بديل
    try {
      await oraGet(cfg, "purchasingDocumentHeaders", { limit: "1" });
      return { ok: true, version: "Oracle ERP Cloud" };
    } catch {
      return { ok: false, error: (e as Error).message };
    }
  }
}

export async function importSuppliers(cfg: OracleConfig): Promise<ErpSupplier[]> {
  // Oracle Supplier REST Resource
  const data = (await oraGet(cfg, "supplierParties", {
    limit: "500",
    fields: "PartyId,SupplierName,EmailAddress,PhoneNumber,AddressLine1,City,Category",
  })) as { items?: Record<string, unknown>[] };
  const items = data.items ?? [];
  return items.map((r) => ({
    externalId: `oracle-${r.PartyId}`,
    name: String(r.SupplierName ?? ""),
    email: r.EmailAddress ? String(r.EmailAddress) : undefined,
    phone: r.PhoneNumber ? String(r.PhoneNumber) : undefined,
    address: [r.AddressLine1, r.City].filter(Boolean).join(", ") || undefined,
    category: r.Category ? String(r.Category) : undefined,
  }));
}

export async function importSupplierContacts(
  cfg: OracleConfig,
  partyId: string,
): Promise<{ name?: string; email?: string; phone?: string } | null> {
  try {
    const data = (await oraGet(cfg, `supplierParties/${partyId}/child/supplierContacts`, {
      limit: "1",
    })) as { items?: Record<string, unknown>[] };
    const c = data.items?.[0];
    if (!c) return null;
    return {
      name: c.FullName ? String(c.FullName) : undefined,
      email: c.EmailAddress ? String(c.EmailAddress) : undefined,
      phone: c.PhoneNumber ? String(c.PhoneNumber) : undefined,
    };
  } catch {
    return null;
  }
}

export async function exportPurchaseOrder(
  cfg: OracleConfig,
  po: {
    internalPoNo: string;
    supplierPartyId?: string;
    supplierName?: string;
    businessUnit?: string;
    notes?: string;
    lines: { description: string; qty: number; price: number; uom?: string }[];
  },
): Promise<string> {
  const body = {
    POHeaderId: null,
    OrderType: "STANDARD",
    BusinessUnit: po.businessUnit ?? cfg.businessUnit ?? "US1 Business Unit",
    Supplier: po.supplierName ?? "",
    Description: po.notes ?? po.internalPoNo,
    lines: po.lines.map((l, i) => ({
      LineNumber: i + 1,
      ItemDescription: l.description,
      Quantity: l.qty,
      Price: l.price,
      UOMCode: l.uom ?? "Ea",
    })),
  };
  const result = (await oraPost(cfg, "purchasingDocumentHeaders", body)) as {
    POHeaderId?: string;
    OrderNumber?: string;
  };
  return String(result.OrderNumber ?? result.POHeaderId ?? "created");
}

export async function importPurchaseOrders(cfg: OracleConfig): Promise<ErpPurchaseOrder[]> {
  const data = (await oraGet(cfg, "purchasingDocumentHeaders", {
    limit: "100",
    fields: "OrderNumber,Supplier,Status,Description",
  })) as { items?: Record<string, unknown>[] };
  return (data.items ?? []).map((r) => ({
    externalId: `oracle-po-${r.OrderNumber}`,
    name: String(r.OrderNumber ?? ""),
    supplierName: String(r.Supplier ?? ""),
    status: String(r.Status ?? ""),
    lines: [],
  }));
}
