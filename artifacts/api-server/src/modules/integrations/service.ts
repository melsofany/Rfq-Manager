/**
 * خدمة التكامل مع أنظمة ERP
 * تدير الإعدادات وتنفّذ عمليات المزامنة
 */

import { pool } from "@workspace/db";
import { logger } from "../../shared/logger";
import * as OdooConnector from "./connectors/odoo";
import * as SapConnector from "./connectors/sap";
import * as OracleConnector from "./connectors/oracle";
import * as GoogleSheetsErp from "./connectors/google-sheets-erp";

export type ErpType = "odoo" | "sap-b1" | "sap-s4hana" | "oracle" | "google-sheets";

export interface ErpIntegration {
  id: number;
  name: string;
  type: ErpType;
  config: Record<string, unknown>;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: "success" | "error" | "partial" | null;
  lastSyncError: string | null;
  lastSyncStats: Record<string, number> | null;
  createdAt: string;
  updatedAt: string;
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

export async function listIntegrations(): Promise<ErpIntegration[]> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, name, type, config, is_active, last_sync_at, last_sync_status,
              last_sync_error, last_sync_stats, created_at, updated_at
       FROM erp_integrations ORDER BY id`
    );
    return rows.map(mapRow);
  } finally { client.release(); }
}

export async function getIntegration(id: number): Promise<ErpIntegration | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT * FROM erp_integrations WHERE id = $1`, [id]
    );
    return rows.length ? mapRow(rows[0]) : null;
  } finally { client.release(); }
}

export async function createIntegration(data: {
  name: string; type: ErpType; config: Record<string, unknown>;
}): Promise<ErpIntegration> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `INSERT INTO erp_integrations (name, type, config) VALUES ($1, $2, $3) RETURNING *`,
      [data.name, data.type, JSON.stringify(data.config)]
    );
    return mapRow(rows[0]);
  } finally { client.release(); }
}

export async function updateIntegration(id: number, data: Partial<{
  name: string; type: ErpType; config: Record<string, unknown>; isActive: boolean;
}>): Promise<ErpIntegration | null> {
  const client = await pool.connect();
  try {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (data.name !== undefined) { sets.push(`name = $${i++}`); vals.push(data.name); }
    if (data.type !== undefined) { sets.push(`type = $${i++}`); vals.push(data.type); }
    if (data.config !== undefined) { sets.push(`config = $${i++}`); vals.push(JSON.stringify(data.config)); }
    if (data.isActive !== undefined) { sets.push(`is_active = $${i++}`); vals.push(data.isActive); }
    if (!sets.length) return getIntegration(id);
    sets.push(`updated_at = NOW()`);
    vals.push(id);
    const { rows } = await client.query(
      `UPDATE erp_integrations SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`, vals
    );
    return rows.length ? mapRow(rows[0]) : null;
  } finally { client.release(); }
}

export async function deleteIntegration(id: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    const { rowCount } = await client.query(`DELETE FROM erp_integrations WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  } finally { client.release(); }
}

async function updateSyncResult(id: number, status: "success" | "error" | "partial", stats?: Record<string, number>, error?: string) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE erp_integrations SET
         last_sync_at = NOW(), last_sync_status = $2,
         last_sync_stats = $3, last_sync_error = $4, updated_at = NOW()
       WHERE id = $1`,
      [id, status, stats ? JSON.stringify(stats) : null, error ?? null]
    );
  } finally { client.release(); }
}

function mapRow(r: Record<string, unknown>): ErpIntegration {
  return {
    id: Number(r.id),
    name: String(r.name ?? ""),
    type: String(r.type ?? "") as ErpType,
    config: (typeof r.config === "object" ? r.config : {}) as Record<string, unknown>,
    isActive: Boolean(r.is_active),
    lastSyncAt: r.last_sync_at ? String(r.last_sync_at) : null,
    lastSyncStatus: (r.last_sync_status as "success" | "error" | "partial" | null) ?? null,
    lastSyncError: r.last_sync_error ? String(r.last_sync_error) : null,
    lastSyncStats: (r.last_sync_stats as Record<string, number> | null) ?? null,
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

// ─── Test Connection ──────────────────────────────────────────────────────────

export async function testConnection(integration: ErpIntegration): Promise<{ ok: boolean; version?: string; error?: string }> {
  const cfg = integration.config;
  try {
    switch (integration.type) {
      case "odoo":
        return await OdooConnector.testConnection(cfg as OdooConnector.OdooConfig);
      case "sap-b1":
        return await SapConnector.testConnection({ ...cfg, variant: "sap-b1" } as SapConnector.SapConfig);
      case "sap-s4hana":
        return await SapConnector.testConnection({ ...cfg, variant: "sap-s4hana" } as SapConnector.SapConfig);
      case "oracle":
        return await OracleConnector.testConnection(cfg as OracleConnector.OracleConfig);
      case "google-sheets":
        return await GoogleSheetsErp.testConnection({
          serviceAccountBase64: String(cfg.serviceAccountBase64 ?? process.env.GOOGLE_ACCOUNT_BASE_64 ?? ""),
          spreadsheetId: String(cfg.spreadsheetId ?? process.env.GOOGLE_MIRROR_SHEET_ID ?? ""),
        });
      default:
        return { ok: false, error: "نوع التكامل غير مدعوم" };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ─── Import Suppliers from ERP ───────────────────────────────────────────────

export async function syncSuppliers(integration: ErpIntegration): Promise<{ imported: number; updated: number; skipped: number }> {
  const cfg = integration.config;
  let erpSuppliers: OdooConnector.ErpSupplier[] = [];

  switch (integration.type) {
    case "odoo":
      erpSuppliers = await OdooConnector.importSuppliers(cfg as OdooConnector.OdooConfig);
      break;
    case "sap-b1":
      erpSuppliers = await SapConnector.importSuppliers({ ...cfg, variant: "sap-b1" } as SapConnector.SapConfig);
      break;
    case "sap-s4hana":
      erpSuppliers = await SapConnector.importSuppliers({ ...cfg, variant: "sap-s4hana" } as SapConnector.SapConfig);
      break;
    case "oracle":
      erpSuppliers = await OracleConnector.importSuppliers(cfg as OracleConnector.OracleConfig);
      break;
    case "google-sheets":
      erpSuppliers = await GoogleSheetsErp.importSuppliers({
        serviceAccountBase64: String(cfg.serviceAccountBase64 ?? process.env.GOOGLE_ACCOUNT_BASE_64 ?? ""),
        spreadsheetId: String(cfg.spreadsheetId ?? process.env.GOOGLE_MIRROR_SHEET_ID ?? ""),
        dataSheetName: String(cfg.dataSheetName ?? "Suppliers"),
      });
      break;
    default:
      throw new Error("نوع التكامل غير مدعوم");
  }

  const client = await pool.connect();
  let imported = 0, updated = 0, skipped = 0;

  try {
    for (const s of erpSuppliers) {
      if (!s.name?.trim()) { skipped++; continue; }

      // البحث عن مورد موجود بنفس الاسم أو الإيميل
      const existing = await client.query(
        `SELECT id FROM suppliers WHERE
           (LOWER(name) = LOWER($1))
           OR (email IS NOT NULL AND email != '' AND LOWER(email) = LOWER($2))
         LIMIT 1`,
        [s.name.trim(), s.email?.trim() ?? ""]
      );

      if (existing.rows.length > 0) {
        // تحديث البيانات المفقودة فقط
        await client.query(
          `UPDATE suppliers SET
             contact_person = COALESCE(NULLIF(contact_person, ''), $2),
             email  = COALESCE(NULLIF(email,  ''), $3),
             phone  = COALESCE(NULLIF(phone,  ''), $4),
             address = COALESCE(NULLIF(address, ''), $5),
             updated_at = NOW()
           WHERE id = $1`,
          [existing.rows[0].id, s.contactPerson ?? null, s.email ?? null, s.phone ?? null, s.address ?? null]
        );
        updated++;
      } else {
        await client.query(
          `INSERT INTO suppliers (name, contact_person, email, phone, address, category, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, true)`,
          [s.name.trim(), s.contactPerson ?? null, s.email ?? null, s.phone ?? null, s.address ?? null, s.category ?? "general"]
        );
        imported++;
      }
    }
  } finally { client.release(); }

  logger.info({ integration: integration.name, imported, updated, skipped }, "ERP supplier sync done");
  return { imported, updated, skipped };
}

// ─── Export to ERP ────────────────────────────────────────────────────────────

export async function syncToErp(integration: ErpIntegration): Promise<{ rfqs: number; pos: number; suppliers: number }> {
  const cfg = integration.config;
  const client = await pool.connect();
  let rfqs = 0, pos = 0, suppliers = 0;

  try {
    if (integration.type === "google-sheets") {
      const gCfg: GoogleSheetsErp.GoogleSheetsErpConfig = {
        serviceAccountBase64: String(cfg.serviceAccountBase64 ?? process.env.GOOGLE_ACCOUNT_BASE_64 ?? ""),
        spreadsheetId: String(cfg.spreadsheetId ?? process.env.GOOGLE_MIRROR_SHEET_ID ?? ""),
      };

      // تصدير الموردين
      const supplierRows = await client.query(`SELECT name, email, phone, address, category FROM suppliers WHERE is_active = true ORDER BY name`);
      // جلب التقييم لكل مورد
      const suppliersData = supplierRows.rows.map((s: Record<string, unknown>) => ({
        name: String(s.name), email: s.email ? String(s.email) : undefined,
        phone: s.phone ? String(s.phone) : undefined, address: s.address ? String(s.address) : undefined,
        category: s.category ? String(s.category) : undefined,
      }));
      await GoogleSheetsErp.exportSuppliers(gCfg, suppliersData);
      suppliers = suppliersData.length;

      // تصدير الـ RFQs
      const rfqRows = await client.query(
        `SELECT r.internal_rfq_no, r.customer_rfq_no, r.status, r.created_at,
                (SELECT COUNT(*) FROM sent_log sl WHERE sl.rfq_id = r.id) AS supplier_count,
                (SELECT COUNT(*) FROM offers o WHERE o.rfq_id = r.id) AS offer_count
         FROM rfq r ORDER BY r.created_at DESC LIMIT 500`
      );
      await GoogleSheetsErp.exportRfqs(gCfg, rfqRows.rows.map((r: Record<string, unknown>) => ({
        internalRfqNo: String(r.internal_rfq_no),
        customerRfqNo: String(r.customer_rfq_no),
        status: String(r.status),
        supplierCount: Number(r.supplier_count),
        offerCount: Number(r.offer_count),
        createdAt: String(r.created_at).split("T")[0],
      })));
      rfqs = rfqRows.rows.length;

      // تصدير أوامر الشراء
      const poRows = await client.query(
        `SELECT po.internal_po_no, po.sheet_po_no, po.status, po.created_at,
                (SELECT COUNT(*) FROM purchase_order_items poi WHERE poi.po_id = po.id) AS item_count,
                s.name AS supplier_name
         FROM purchase_orders po
         LEFT JOIN (
           SELECT DISTINCT ON (poi2.po_id) poi2.po_id, sup.name
           FROM purchase_order_items poi2
           JOIN suppliers sup ON poi2.supplier_id = sup.id
         ) s ON s.po_id = po.id
         ORDER BY po.created_at DESC LIMIT 200`
      );
      await GoogleSheetsErp.exportPurchaseOrders(gCfg, poRows.rows.map((p: Record<string, unknown>) => ({
        internalPoNo: String(p.internal_po_no),
        sheetPoNo: String(p.sheet_po_no),
        supplierName: p.supplier_name ? String(p.supplier_name) : undefined,
        status: String(p.status),
        itemCount: Number(p.item_count),
        createdAt: String(p.created_at).split("T")[0],
      })));
      pos = poRows.rows.length;
    }
    // لـ Odoo/SAP/Oracle: تُنفَّذ العمليات حسب الطلب من الـ routes
  } finally { client.release(); }

  return { rfqs, pos, suppliers };
}

// ─── Full Sync ────────────────────────────────────────────────────────────────

export async function runSync(id: number): Promise<{ success: boolean; stats?: Record<string, number>; error?: string }> {
  const integration = await getIntegration(id);
  if (!integration) return { success: false, error: "التكامل غير موجود" };
  if (!integration.isActive) return { success: false, error: "التكامل غير مفعّل" };

  try {
    logger.info({ id, type: integration.type }, "ERP sync started");

    // 1. استيراد الموردين
    const supplierStats = await syncSuppliers(integration);

    // 2. تصدير البيانات (Google Sheets فقط حالياً)
    const exportStats = integration.type === "google-sheets"
      ? await syncToErp(integration)
      : { rfqs: 0, pos: 0, suppliers: 0 };

    const stats = {
      suppliersImported: supplierStats.imported,
      suppliersUpdated: supplierStats.updated,
      suppliersSkipped: supplierStats.skipped,
      rfqsExported: exportStats.rfqs,
      posExported: exportStats.pos,
    };

    await updateSyncResult(id, "success", stats);
    logger.info({ id, stats }, "ERP sync completed");
    return { success: true, stats };
  } catch (err) {
    const error = (err as Error).message;
    await updateSyncResult(id, "error", undefined, error);
    logger.error({ id, error }, "ERP sync failed");
    return { success: false, error };
  }
}
