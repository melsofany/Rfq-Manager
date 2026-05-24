import { db, rfqTable, rfqItemsTable, suppliersTable, employeesTable, offersTable, offerItemsTable } from "@workspace/db";
import { inArray, eq } from "drizzle-orm";
import { pushToMirrorSheet, readMirrorSheetIds, type MirrorData } from "./googleSheets";
import { logger } from "./logger";

export interface SyncStatus {
  lastSyncAt: string | null;
  lastSyncResult: "success" | "error" | null;
  lastSyncError: string | null;
  lastSyncStats: { rfqs: number; items: number; suppliers: number; offerItems: number } | null;
  deleted: { rfqs: number; items: number; suppliers: number } | null;
  inProgress: boolean;
}

let status: SyncStatus = {
  lastSyncAt: null,
  lastSyncResult: null,
  lastSyncError: null,
  lastSyncStats: null,
  deleted: null,
  inProgress: false,
};

export function getSyncStatus(): SyncStatus {
  return { ...status };
}

async function buildMirrorData(): Promise<MirrorData> {
  const rfqRows = await db
    .select({ rfq: rfqTable, employeeName: employeesTable.name })
    .from(rfqTable)
    .leftJoin(employeesTable, eq(rfqTable.employeeId, employeesTable.id));

  const rfqIds = rfqRows.map((r) => r.rfq.id);

  const [itemRows, supplierRows, offerRows] = await Promise.all([
    rfqIds.length > 0
      ? db.select().from(rfqItemsTable).where(inArray(rfqItemsTable.rfqId, rfqIds))
      : Promise.resolve([]),
    db.select().from(suppliersTable),
    rfqIds.length > 0
      ? db.select({
          oi: offerItemsTable,
          offer: offersTable,
        })
          .from(offerItemsTable)
          .innerJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
          .where(inArray(offersTable.rfqId, rfqIds))
      : Promise.resolve([]),
  ]);

  // Maps for lookups
  const rfqNoMap: Record<number, string> = {};
  const rfqCustomerNoMap: Record<number, string> = {};
  for (const r of rfqRows) {
    rfqNoMap[r.rfq.id] = r.rfq.internalRfqNo;
    rfqCustomerNoMap[r.rfq.id] = r.rfq.customerRfqNo;
  }

  const supplierNameMap: Record<number, string> = {};
  for (const s of supplierRows) supplierNameMap[s.id] = s.name;

  const rfqItemMap: Record<number, typeof itemRows[0]> = {};
  for (const i of itemRows) rfqItemMap[i.id] = i;

  return {
    rfqs: rfqRows.map((r) => ({
      id: r.rfq.id,
      internalRfqNo: r.rfq.internalRfqNo,
      customerRfqNo: r.rfq.customerRfqNo,
      customerRfqDate: r.rfq.customerRfqDate,
      requiredResponseDate: r.rfq.requiredResponseDate,
      status: r.rfq.status,
      notes: r.rfq.notes,
      expiresAt: r.rfq.expiresAt,
      createdAt: r.rfq.createdAt,
    })),
    items: itemRows.map((i) => ({
      id: i.id,
      rfqId: i.rfqId,
      internalRfqNo: rfqNoMap[i.rfqId] ?? "",
      lineItem: i.lineItem,
      partNo: i.partNo,
      description: i.description,
      qty: i.qty,
      uom: i.uom,
      referencePrice: i.referencePrice,
      createdAt: i.createdAt,
    })),
    suppliers: supplierRows.map((s) => ({
      id: s.id,
      supplierId: s.supplierId,
      name: s.name,
      contactPerson: s.contactPerson,
      email: s.email,
      phone: s.phone,
      category: s.category,
      isActive: s.isActive,
      createdAt: s.createdAt,
    })),
    offerItems: offerRows.map(({ oi, offer }) => {
      const rfqItem = rfqItemMap[oi.rfqItemId];
      return {
        id: oi.id,
        offerId: oi.offerId,
        rfqId: offer.rfqId,
        internalRfqNo: rfqNoMap[offer.rfqId] ?? "",
        customerRfqNo: rfqCustomerNoMap[offer.rfqId] ?? "",
        supplierName: supplierNameMap[offer.supplierId] ?? `Supplier #${offer.supplierId}`,
        lineItem: rfqItem?.lineItem ?? null,
        partNo: rfqItem?.partNo ?? null,
        description: rfqItem?.description ?? "",
        qty: rfqItem?.qty ?? null,
        uom: rfqItem?.uom ?? null,
        price: oi.price,
        taxIncluded: oi.taxIncluded,
        deliveryDays: oi.deliveryDays,
        notes: oi.notes,
        submittedAt: oi.createdAt,
      };
    }),
  };
}

/** Full bidirectional sync:
 *  1. Read DB → push to mirror sheet (all 4 tabs)
 *  2. Read sheet IDs → delete DB rows that are no longer in the sheet
 */
export async function runFullSync(): Promise<SyncStatus> {
  if (status.inProgress) {
    logger.warn("Sheet sync already in progress — skipping");
    return getSyncStatus();
  }

  status.inProgress = true;
  logger.info("Sheet sync started");

  try {
    // ── 1. Build data and push to sheet ──────────────────────────────────────
    const data = await buildMirrorData();
    const stats = {
      rfqs: data.rfqs.length,
      items: data.items.length,
      suppliers: data.suppliers.length,
      offerItems: data.offerItems.length,
    };

    await pushToMirrorSheet(data);

    // ── 2. Read sheet IDs and apply deletions ─────────────────────────────────
    const sheetIds = await readMirrorSheetIds();
    const deleted = { rfqs: 0, items: 0, suppliers: 0 };

    if (sheetIds.rfqIds.length > 0) {
      const toDelete = data.rfqs.map((r) => r.id).filter((id) => !sheetIds.rfqIds.includes(id));
      if (toDelete.length > 0) {
        await db.delete(rfqTable).where(inArray(rfqTable.id, toDelete));
        deleted.rfqs = toDelete.length;
        logger.info({ deleted: toDelete }, "Deleted RFQs not found in sheet");
      }
    }

    if (sheetIds.itemIds.length > 0) {
      const toDelete = data.items.map((i) => i.id).filter((id) => !sheetIds.itemIds.includes(id));
      if (toDelete.length > 0) {
        await db.delete(rfqItemsTable).where(inArray(rfqItemsTable.id, toDelete));
        deleted.items = toDelete.length;
        logger.info({ deleted: toDelete }, "Deleted items not found in sheet");
      }
    }

    if (sheetIds.supplierIds.length > 0) {
      const toDelete = data.suppliers.map((s) => s.id).filter((id) => !sheetIds.supplierIds.includes(id));
      if (toDelete.length > 0) {
        await db.delete(suppliersTable).where(inArray(suppliersTable.id, toDelete));
        deleted.suppliers = toDelete.length;
        logger.info({ deleted: toDelete }, "Deleted suppliers not found in sheet");
      }
    }

    // ── 3. Re-push if anything was deleted ────────────────────────────────────
    if (deleted.rfqs + deleted.items + deleted.suppliers > 0) {
      const freshData = await buildMirrorData();
      await pushToMirrorSheet(freshData);
    }

    status = {
      lastSyncAt: new Date().toISOString(),
      lastSyncResult: "success",
      lastSyncError: null,
      lastSyncStats: stats,
      deleted,
      inProgress: false,
    };

    logger.info({ stats, deleted }, "Sheet sync completed");
  } catch (err) {
    status = {
      ...status,
      lastSyncAt: new Date().toISOString(),
      lastSyncResult: "error",
      lastSyncError: (err as Error).message,
      inProgress: false,
    };
    logger.error({ err }, "Sheet sync failed");
  }

  return getSyncStatus();
}
