/**
 * خدمة التكامل مع أنظمة ERP
 * تستخدم Drizzle ORM بدلاً من raw SQL
 */

import { eq, or, sql } from "drizzle-orm";
import {
  getDb,
  erpIntegrationsTable,
  suppliersTable,
  rfqTable,
  purchaseOrdersTable,
  type ErpIntegration as DbErpIntegration,
} from "@workspace/db";
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

// ─── Row → DTO ────────────────────────────────────────────────────────────────

function toDto(row: DbErpIntegration): ErpIntegration {
  return {
    id: row.id,
    name: row.name,
    type: row.type as ErpType,
    config: (row.config as Record<string, unknown>) ?? {},
    isActive: row.isActive,
    lastSyncAt: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
    lastSyncStatus: row.lastSyncStatus as "success" | "error" | "partial" | null,
    lastSyncError: row.lastSyncError ?? null,
    lastSyncStats: row.lastSyncStats as Record<string, number> | null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function listIntegrations(): Promise<ErpIntegration[]> {
  const db = getDb();
  const rows = await db.select().from(erpIntegrationsTable).orderBy(erpIntegrationsTable.id);
  return rows.map(toDto);
}

export async function getIntegration(id: number): Promise<ErpIntegration | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(erpIntegrationsTable)
    .where(eq(erpIntegrationsTable.id, id))
    .limit(1);
  return rows.length ? toDto(rows[0]) : null;
}

export async function createIntegration(data: {
  name: string;
  type: ErpType;
  config: Record<string, unknown>;
}): Promise<ErpIntegration> {
  const db = getDb();
  const rows = await db
    .insert(erpIntegrationsTable)
    .values({ name: data.name, type: data.type, config: data.config })
    .returning();
  return toDto(rows[0]);
}

export async function updateIntegration(
  id: number,
  data: Partial<{
    name: string;
    type: ErpType;
    config: Record<string, unknown>;
    isActive: boolean;
  }>,
): Promise<ErpIntegration | null> {
  const db = getDb();
  const rows = await db
    .update(erpIntegrationsTable)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(erpIntegrationsTable.id, id))
    .returning();
  return rows.length ? toDto(rows[0]) : null;
}

export async function deleteIntegration(id: number): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .delete(erpIntegrationsTable)
    .where(eq(erpIntegrationsTable.id, id))
    .returning({ id: erpIntegrationsTable.id });
  return rows.length > 0;
}

async function updateSyncResult(
  id: number,
  status: "success" | "error" | "partial",
  stats?: Record<string, number>,
  error?: string,
) {
  const db = getDb();
  await db
    .update(erpIntegrationsTable)
    .set({
      lastSyncAt: new Date(),
      lastSyncStatus: status,
      lastSyncStats: stats ?? null,
      lastSyncError: error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(erpIntegrationsTable.id, id));
}

// ─── Test Connection ──────────────────────────────────────────────────────────

export async function testConnection(
  integration: ErpIntegration,
): Promise<{ ok: boolean; version?: string; error?: string }> {
  const cfg = integration.config;
  try {
    switch (integration.type) {
      case "odoo":
        return await OdooConnector.testConnection(cfg as OdooConnector.OdooConfig);
      case "sap-b1":
        return await SapConnector.testConnection({
          ...cfg,
          variant: "sap-b1",
        } as SapConnector.SapConfig);
      case "sap-s4hana":
        return await SapConnector.testConnection({
          ...cfg,
          variant: "sap-s4hana",
        } as SapConnector.SapConfig);
      case "oracle":
        return await OracleConnector.testConnection(cfg as OracleConnector.OracleConfig);
      case "google-sheets":
        return await GoogleSheetsErp.testConnection({
          serviceAccountBase64: String(
            cfg.serviceAccountBase64 ?? process.env.GOOGLE_ACCOUNT_BASE_64 ?? "",
          ),
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

export async function syncSuppliers(
  integration: ErpIntegration,
): Promise<{ imported: number; updated: number; skipped: number }> {
  const cfg = integration.config;
  let erpSuppliers: OdooConnector.ErpSupplier[] = [];

  switch (integration.type) {
    case "odoo":
      erpSuppliers = await OdooConnector.importSuppliers(cfg as OdooConnector.OdooConfig);
      break;
    case "sap-b1":
      erpSuppliers = await SapConnector.importSuppliers({
        ...cfg,
        variant: "sap-b1",
      } as SapConnector.SapConfig);
      break;
    case "sap-s4hana":
      erpSuppliers = await SapConnector.importSuppliers({
        ...cfg,
        variant: "sap-s4hana",
      } as SapConnector.SapConfig);
      break;
    case "oracle":
      erpSuppliers = await OracleConnector.importSuppliers(cfg as OracleConnector.OracleConfig);
      break;
    case "google-sheets":
      erpSuppliers = await GoogleSheetsErp.importSuppliers({
        serviceAccountBase64: String(
          cfg.serviceAccountBase64 ?? process.env.GOOGLE_ACCOUNT_BASE_64 ?? "",
        ),
        spreadsheetId: String(cfg.spreadsheetId ?? process.env.GOOGLE_MIRROR_SHEET_ID ?? ""),
        dataSheetName: String(cfg.dataSheetName ?? "Suppliers"),
      });
      break;
    default:
      throw new Error("نوع التكامل غير مدعوم");
  }

  const db = getDb();
  let imported = 0,
    updated = 0,
    skipped = 0;

  for (const s of erpSuppliers) {
    if (!s.name?.trim()) {
      skipped++;
      continue;
    }

    // ابحث عن مورد موجود بنفس الاسم (case-insensitive) أو الإيميل
    const existing = await db
      .select({ id: suppliersTable.id })
      .from(suppliersTable)
      .where(
        or(
          sql`LOWER(${suppliersTable.name}) = LOWER(${s.name.trim()})`,
          s.email?.trim()
            ? sql`(${suppliersTable.email} IS NOT NULL AND ${suppliersTable.email} != '' AND LOWER(${suppliersTable.email}) = LOWER(${s.email.trim()}))`
            : sql`false`,
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      // حدّث فقط الحقول الفارغة
      await db
        .update(suppliersTable)
        .set({
          contactPerson: sql`COALESCE(NULLIF(${suppliersTable.contactPerson}, ''), ${s.contactPerson ?? null})`,
          email: sql`COALESCE(NULLIF(${suppliersTable.email},         ''), ${s.email ?? null})`,
          phone: sql`COALESCE(NULLIF(${suppliersTable.phone},         ''), ${s.phone ?? null})`,
          address: sql`COALESCE(NULLIF(${suppliersTable.address},       ''), ${s.address ?? null})`,
          updatedAt: new Date(),
        })
        .where(eq(suppliersTable.id, existing[0].id));
      updated++;
    } else {
      await db.insert(suppliersTable).values({
        name: s.name.trim(),
        contactPerson: s.contactPerson ?? null,
        email: s.email ?? null,
        phone: s.phone ?? null,
        address: s.address ?? null,
        category: s.category ?? "general",
        isActive: true,
      });
      imported++;
    }
  }

  logger.info(
    { integration: integration.name, imported, updated, skipped },
    "ERP supplier sync done",
  );
  return { imported, updated, skipped };
}

// ─── Export to Google Sheets ──────────────────────────────────────────────────

export async function syncToErp(
  integration: ErpIntegration,
): Promise<{ rfqs: number; pos: number; suppliers: number }> {
  const cfg = integration.config;
  let rfqsCount = 0,
    posCount = 0,
    suppliersCount = 0;

  if (integration.type !== "google-sheets") {
    return { rfqs: 0, pos: 0, suppliers: 0 };
  }

  const gCfg: GoogleSheetsErp.GoogleSheetsErpConfig = {
    serviceAccountBase64: String(
      cfg.serviceAccountBase64 ?? process.env.GOOGLE_ACCOUNT_BASE_64 ?? "",
    ),
    spreadsheetId: String(cfg.spreadsheetId ?? process.env.GOOGLE_MIRROR_SHEET_ID ?? ""),
  };

  const db = getDb();

  // ── 1. تصدير الموردين ────────────────────────────────────────────────────
  const supplierRows = await db
    .select({
      name: suppliersTable.name,
      email: suppliersTable.email,
      phone: suppliersTable.phone,
      address: suppliersTable.address,
      category: suppliersTable.category,
    })
    .from(suppliersTable)
    .where(eq(suppliersTable.isActive, true))
    .orderBy(suppliersTable.name);

  await GoogleSheetsErp.exportSuppliers(
    gCfg,
    supplierRows.map((s) => ({
      name: s.name,
      email: s.email ?? undefined,
      phone: s.phone ?? undefined,
      address: s.address ?? undefined,
      category: s.category ?? undefined,
    })),
  );
  suppliersCount = supplierRows.length;

  // ── 2. تصدير الـ RFQs ────────────────────────────────────────────────────
  const rfqRows = await db
    .select({
      internalRfqNo: rfqTable.internalRfqNo,
      customerRfqNo: rfqTable.customerRfqNo,
      status: rfqTable.status,
      createdAt: rfqTable.createdAt,
      supplierCount: sql<number>`(SELECT COUNT(*) FROM sent_log sl WHERE sl.rfq_id = ${rfqTable.id})`,
      offerCount: sql<number>`(SELECT COUNT(*) FROM offers o   WHERE o.rfq_id  = ${rfqTable.id})`,
    })
    .from(rfqTable)
    .orderBy(sql`${rfqTable.createdAt} DESC`)
    .limit(500);

  await GoogleSheetsErp.exportRfqs(
    gCfg,
    rfqRows.map((r) => ({
      internalRfqNo: r.internalRfqNo,
      customerRfqNo: r.customerRfqNo,
      status: r.status,
      supplierCount: Number(r.supplierCount),
      offerCount: Number(r.offerCount),
      createdAt: r.createdAt.toISOString().split("T")[0],
    })),
  );
  rfqsCount = rfqRows.length;

  // ── 3. تصدير أوامر الشراء ────────────────────────────────────────────────
  const poRows = await db
    .select({
      internalPoNo: purchaseOrdersTable.internalPoNo,
      sheetPoNo: purchaseOrdersTable.sheetPoNo,
      status: purchaseOrdersTable.status,
      createdAt: purchaseOrdersTable.createdAt,
      itemCount: sql<number>`(SELECT COUNT(*) FROM purchase_order_items poi WHERE poi.po_id = ${purchaseOrdersTable.id})`,
      supplierName: sql<string | null>`(
        SELECT s.name FROM purchase_order_items poi2
        JOIN suppliers s ON s.id = poi2.supplier_id
        WHERE poi2.po_id = ${purchaseOrdersTable.id}
        LIMIT 1
      )`,
    })
    .from(purchaseOrdersTable)
    .orderBy(sql`${purchaseOrdersTable.createdAt} DESC`)
    .limit(200);

  await GoogleSheetsErp.exportPurchaseOrders(
    gCfg,
    poRows.map((p) => ({
      internalPoNo: p.internalPoNo,
      sheetPoNo: p.sheetPoNo,
      supplierName: p.supplierName ?? undefined,
      status: p.status,
      itemCount: Number(p.itemCount),
      createdAt: p.createdAt.toISOString().split("T")[0],
    })),
  );
  posCount = poRows.length;

  return { rfqs: rfqsCount, pos: posCount, suppliers: suppliersCount };
}

// ─── Full Sync ────────────────────────────────────────────────────────────────

export async function runSync(
  id: number,
): Promise<{ success: boolean; stats?: Record<string, number>; error?: string }> {
  const integration = await getIntegration(id);
  if (!integration) return { success: false, error: "التكامل غير موجود" };
  if (!integration.isActive) return { success: false, error: "التكامل غير مفعّل" };

  try {
    logger.info({ id, type: integration.type }, "ERP sync started");

    const supplierStats = await syncSuppliers(integration);
    const exportStats =
      integration.type === "google-sheets"
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
