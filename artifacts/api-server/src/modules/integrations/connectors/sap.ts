/**
 * SAP Connector
 * يدعم:
 *   - SAP Business One  — Service Layer REST API (port 50000)
 *   - SAP S/4HANA Cloud — OData v4 API
 *
 * Docs SAP B1:  https://help.sap.com/doc/b1/latest/en-US/
 * Docs S/4HANA: https://api.sap.com/
 */

export type SapVariant = "sap-b1" | "sap-s4hana";

export interface SapConfig {
  url: string;          // https://sap-server:50000  أو  https://myXXXXXX.s4hana.ondemand.com
  username: string;
  password: string;
  companyDB?: string;   // SAP B1 فقط: اسم قاعدة البيانات
  variant: SapVariant;
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

// ─── SAP Business One — Service Layer ────────────────────────────────────────

let b1SessionCookie = "";
let b1SessionExpiry = 0;

async function b1Login(cfg: SapConfig): Promise<string> {
  if (b1SessionCookie && Date.now() < b1SessionExpiry) return b1SessionCookie;

  const res = await fetch(`${cfg.url}/b1s/v1/Login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ CompanyDB: cfg.companyDB ?? "", UserName: cfg.username, Password: cfg.password }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`SAP B1 Login failed (${res.status}): ${txt}`);
  }
  const cookie = res.headers.get("set-cookie") ?? "";
  b1SessionCookie = cookie.split(";")[0];
  b1SessionExpiry = Date.now() + 25 * 60 * 1000; // 25 دقيقة
  return b1SessionCookie;
}

async function b1Get(cfg: SapConfig, path: string): Promise<unknown> {
  const cookie = await b1Login(cfg);
  const res = await fetch(`${cfg.url}/b1s/v1/${path}`, {
    headers: { Cookie: cookie, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`SAP B1 GET /${path} failed: ${res.status}`);
  return res.json();
}

async function b1Post(cfg: SapConfig, path: string, body: unknown): Promise<unknown> {
  const cookie = await b1Login(cfg);
  const res = await fetch(`${cfg.url}/b1s/v1/${path}`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`SAP B1 POST /${path} failed (${res.status}): ${txt}`);
  }
  return res.json();
}

// ─── SAP S/4HANA — OData v4 ──────────────────────────────────────────────────

function s4Headers(cfg: SapConfig): Record<string, string> {
  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
  return { Authorization: `Basic ${auth}`, Accept: "application/json" };
}

async function s4Get(cfg: SapConfig, path: string): Promise<unknown> {
  const res = await fetch(`${cfg.url}/sap/opu/odata4/sap/${path}`, {
    headers: s4Headers(cfg),
  });
  if (!res.ok) throw new Error(`SAP S/4HANA GET failed: ${res.status}`);
  return res.json();
}

async function s4Post(cfg: SapConfig, entity: string, body: unknown): Promise<unknown> {
  // الحصول على CSRF token أولاً
  const csrfRes = await fetch(`${cfg.url}/sap/opu/odata4/sap/api_purchaseorder_2/srvd_a2x/sap/purchaseorder/0001/`, {
    method: "GET",
    headers: { ...s4Headers(cfg), "x-csrf-token": "Fetch" },
  });
  const csrfToken = csrfRes.headers.get("x-csrf-token") ?? "";

  const res = await fetch(`${cfg.url}/sap/opu/odata4/sap/api_purchaseorder_2/srvd_a2x/sap/purchaseorder/0001/${entity}`, {
    method: "POST",
    headers: { ...s4Headers(cfg), "Content-Type": "application/json", "x-csrf-token": csrfToken },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`SAP S/4HANA POST failed (${res.status}): ${txt}`);
  }
  return res.json();
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function testConnection(cfg: SapConfig): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    if (cfg.variant === "sap-b1") {
      await b1Login(cfg);
      const info = await b1Get(cfg, "CompanyService_GetCompanyInfo") as Record<string, unknown>;
      return { ok: true, version: `SAP Business One — ${cfg.companyDB ?? ""}` };
    } else {
      // S/4HANA: ping metadata
      const res = await fetch(`${cfg.url}/sap/opu/odata4/sap/api_supplier/srvd_a2x/sap/supplier/0001/$metadata`, {
        headers: s4Headers(cfg),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true, version: "SAP S/4HANA" };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function importSuppliers(cfg: SapConfig): Promise<ErpSupplier[]> {
  if (cfg.variant === "sap-b1") {
    const data = await b1Get(cfg, "BusinessPartners?$select=CardCode,CardName,EmailAddress,Phone1,FullAddress&$filter=CardType eq 'cSupplier' and Active eq 'tYES'&$top=500") as { value: Record<string, unknown>[] };
    return (data.value ?? []).map((r) => ({
      externalId: `sap-b1-${r.CardCode}`,
      name: String(r.CardName ?? ""),
      email: r.EmailAddress ? String(r.EmailAddress) : undefined,
      phone: r.Phone1 ? String(r.Phone1) : undefined,
      address: r.FullAddress ? String(r.FullAddress) : undefined,
    }));
  } else {
    // S/4HANA Supplier API
    const data = await s4Get(cfg, "api_supplier/srvd_a2x/sap/supplier/0001/Supplier?$top=500&$select=Supplier,SupplierFullName,EmailAddress,PhoneNumber") as { value: Record<string, unknown>[] };
    return (data.value ?? []).map((r) => ({
      externalId: `sap-s4-${r.Supplier}`,
      name: String(r.SupplierFullName ?? r.Supplier ?? ""),
      email: r.EmailAddress ? String(r.EmailAddress) : undefined,
      phone: r.PhoneNumber ? String(r.PhoneNumber) : undefined,
    }));
  }
}

export async function exportPurchaseOrder(cfg: SapConfig, po: {
  supplierCode: string;
  lines: { itemCode?: string; description: string; qty: number; price: number; uom?: string }[];
  notes?: string;
}): Promise<string> {
  if (cfg.variant === "sap-b1") {
    const result = await b1Post(cfg, "PurchaseOrders", {
      CardCode: po.supplierCode,
      Comments: po.notes ?? "",
      DocumentLines: po.lines.map((l, i) => ({
        LineNum: i,
        ItemDescription: l.description,
        Quantity: l.qty,
        UnitPrice: l.price,
        UoMCode: l.uom ?? "EA",
      })),
    }) as { DocNum: number };
    return String(result.DocNum);
  } else {
    const result = await s4Post(cfg, "PurchaseOrder", {
      Supplier: po.supplierCode,
      PurchaseOrderItem: po.lines.map((l, i) => ({
        PurchaseOrderItem: String((i + 1) * 10).padStart(5, "0"),
        PurchaseOrderItemText: l.description,
        OrderQuantity: l.qty,
        NetPriceAmount: l.price,
      })),
    }) as { PurchaseOrder: string };
    return result.PurchaseOrder;
  }
}

export async function importPurchaseOrders(cfg: SapConfig): Promise<ErpPurchaseOrder[]> {
  if (cfg.variant === "sap-b1") {
    const data = await b1Get(cfg, "PurchaseOrders?$select=DocNum,CardName,DocStatus&$top=100&$orderby=DocNum desc") as { value: Record<string, unknown>[] };
    return (data.value ?? []).map((r) => ({
      externalId: `sap-b1-po-${r.DocNum}`,
      name: `PO-${r.DocNum}`,
      supplierName: String(r.CardName ?? ""),
      status: String(r.DocStatus ?? ""),
      lines: [],
    }));
  } else {
    const data = await s4Get(cfg, "api_purchaseorder_2/srvd_a2x/sap/purchaseorder/0001/PurchaseOrder?$top=100&$select=PurchaseOrder,Supplier,PurchaseOrderStatus") as { value: Record<string, unknown>[] };
    return (data.value ?? []).map((r) => ({
      externalId: `sap-s4-po-${r.PurchaseOrder}`,
      name: String(r.PurchaseOrder ?? ""),
      supplierName: String(r.Supplier ?? ""),
      status: String(r.PurchaseOrderStatus ?? ""),
      lines: [],
    }));
  }
}
