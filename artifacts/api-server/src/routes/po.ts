import { Router } from "express";
import {
  db,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
  suppliersTable,
  employeesTable,
  auditLogTable,
  offersTable,
  offerItemsTable,
  rfqItemsTable,
} from "@workspace/db";
import { eq, count, inArray, sql, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { lookupPoFromSheet, listSheetPoNumbers } from "../lib/googleSheets";

const router = Router();

// Generate internal PO number: PO-YYYY-XXXXXX
async function generateInternalPoNo(): Promise<string> {
  const year = new Date().getFullYear();
  const [result] = await db.select({ cnt: count() }).from(purchaseOrdersTable);
  const seq = String((result?.cnt ?? 0) + 1).padStart(6, "0");
  return `PO-${year}-${seq}`;
}

router.get("/po", requireAuth, async (req, res): Promise<void> => {
  const { status, search } = req.query as Record<string, string>;

  const rows = await db.select({
    po: purchaseOrdersTable,
    employeeName: employeesTable.name,
  }).from(purchaseOrdersTable)
    .leftJoin(employeesTable, eq(purchaseOrdersTable.employeeId, employeesTable.id))
    .orderBy(sql`${purchaseOrdersTable.createdAt} DESC`);

  let filtered = rows;
  if (status) filtered = filtered.filter(r => r.po.status === status);
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(r =>
      r.po.internalPoNo.toLowerCase().includes(s) ||
      r.po.sheetPoNo.toLowerCase().includes(s)
    );
  }

  const poIds = filtered.map(r => r.po.id);
  const itemCounts = poIds.length > 0 ? await db.select({ poId: purchaseOrderItemsTable.poId, cnt: count() })
    .from(purchaseOrderItemsTable).where(inArray(purchaseOrderItemsTable.poId, poIds)).groupBy(purchaseOrderItemsTable.poId) : [];
  const itemMap = Object.fromEntries(itemCounts.map(r => [r.poId, r.cnt]));

  res.json(filtered.map(r => ({
    id: r.po.id,
    internalPoNo: r.po.internalPoNo,
    sheetPoNo: r.po.sheetPoNo,
    receiverName: r.po.receiverName,
    receiverPhone: r.po.receiverPhone,
    status: r.po.status,
    employeeId: r.po.employeeId,
    employeeName: r.employeeName,
    notes: r.po.notes,
    itemCount: itemMap[r.po.id] ?? 0,
    createdAt: r.po.createdAt.toISOString(),
    updatedAt: r.po.updatedAt.toISOString(),
  })));
});

router.post("/po", requireAuth, async (req, res): Promise<void> => {
  const { sheetPoNo, receiverName, receiverPhone, notes, items } = req.body as {
    sheetPoNo?: string;
    receiverName?: string;
    receiverPhone?: string;
    notes?: string;
    items?: Array<{
      itemId?: string | null;
      lineItem?: string;
      partNo?: string;
      description: string;
      uom?: string;
      qty?: string | number | null;
      referencePrice?: string | number | null;
      supplierId?: number | null;
    }>;
  };

  if (!sheetPoNo) {
    res.status(400).json({ error: "sheetPoNo required" });
    return;
  }
  const validItems = (items ?? []).filter((it) => it.description?.trim());
  if (validItems.length === 0) {
    res.status(400).json({ error: "At least one item is required" });
    return;
  }

  const internalPoNo = await generateInternalPoNo();
  const [po] = await db.insert(purchaseOrdersTable).values({
    internalPoNo,
    sheetPoNo,
    receiverName: receiverName || null,
    receiverPhone: receiverPhone || null,
    status: "draft",
    employeeId: req.session.employeeId,
    notes: notes || null,
  }).returning();

  await db.insert(purchaseOrderItemsTable).values(
    validItems.map((it) => ({
      poId: po.id,
      itemId: it.itemId || null,
      lineItem: it.lineItem || null,
      partNo: it.partNo || null,
      description: it.description.trim(),
      uom: it.uom || null,
      qty: it.qty != null && it.qty !== "" ? String(it.qty) : null,
      referencePrice: it.referencePrice != null && it.referencePrice !== "" ? String(it.referencePrice) : null,
      supplierId: it.supplierId ?? null,
    }))
  );

  await db.insert(auditLogTable).values({
    action: "po.created",
    entityType: "po",
    entityId: po.id,
    employeeId: req.session.employeeId,
    description: `Created purchase order ${internalPoNo} for PO ${sheetPoNo} with ${validItems.length} item(s)`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.status(201).json({
    id: po.id,
    internalPoNo: po.internalPoNo,
    sheetPoNo: po.sheetPoNo,
    receiverName: po.receiverName,
    receiverPhone: po.receiverPhone,
    status: po.status,
    employeeId: po.employeeId,
    employeeName: null,
    notes: po.notes,
    itemCount: validItems.length,
    createdAt: po.createdAt.toISOString(),
    updatedAt: po.updatedAt.toISOString(),
  });
});

router.get("/po/lookup/:poNo", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.poNo) ? req.params.poNo[0] : req.params.poNo;
  const poNo = decodeURIComponent(raw);
  const { sheet } = req.query as Record<string, string>;

  try {
    const sheetItems = await lookupPoFromSheet(poNo, sheet || "DATA");
    res.json(sheetItems);
  } catch (err) {
    req.log.error({ err, poNo }, "Google Sheets PO lookup failed");
    res.status(500).json({ error: "Failed to fetch from Google Sheets", details: (err as Error).message });
  }
});

// GET /api/po/sheets/po-numbers?sheet=Sheet1 — list unique PO numbers in the sheet (column K)
router.get("/po/sheets/po-numbers", requireAuth, async (req, res): Promise<void> => {
  const { sheet } = req.query as Record<string, string>;
  try {
    const numbers = await listSheetPoNumbers(sheet || "DATA");
    res.json({ poNumbers: numbers });
  } catch (err) {
    req.log.error({ err }, "Failed to list PO numbers from sheet");
    res.status(500).json({ error: "Failed to connect to Google Sheets", details: (err as Error).message });
  }
});

// GET /api/po/supplier-price?supplierId=X&description=Y&partNo=Z
// Looks up the most recent quoted price from a supplier for an item matching description or partNo
router.get("/po/supplier-price", requireAuth, async (req, res): Promise<void> => {
  const { supplierId, description, partNo } = req.query as Record<string, string>;

  if (!supplierId || !description) {
    res.status(400).json({ error: "supplierId and description required" });
    return;
  }

  const supplierIdInt = parseInt(supplierId, 10);
  if (isNaN(supplierIdInt)) {
    res.status(400).json({ error: "Invalid supplierId" });
    return;
  }

  const descNorm = description.trim().toLowerCase();

  // Search by description (case-insensitive) first
  const byDesc = await db
    .select({ price: offerItemsTable.price })
    .from(offerItemsTable)
    .innerJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
    .innerJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
    .where(
      and(
        eq(offersTable.supplierId, supplierIdInt),
        sql`lower(${rfqItemsTable.description}) = ${descNorm}`
      )
    )
    .orderBy(sql`${offersTable.createdAt} DESC`)
    .limit(1);

  if (byDesc.length > 0) {
    res.json({ price: parseFloat(byDesc[0].price) });
    return;
  }

  // Fallback: search by part number if provided
  if (partNo && partNo.trim()) {
    const byPart = await db
      .select({ price: offerItemsTable.price })
      .from(offerItemsTable)
      .innerJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
      .innerJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
      .where(
        and(
          eq(offersTable.supplierId, supplierIdInt),
          eq(rfqItemsTable.partNo, partNo.trim())
        )
      )
      .orderBy(sql`${offersTable.createdAt} DESC`)
      .limit(1);

    if (byPart.length > 0) {
      res.json({ price: parseFloat(byPart[0].price) });
      return;
    }
  }

  res.json({ price: null });
});

router.get("/po/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const [row] = await db.select({
    po: purchaseOrdersTable,
    employeeName: employeesTable.name,
  }).from(purchaseOrdersTable)
    .leftJoin(employeesTable, eq(purchaseOrdersTable.employeeId, employeesTable.id))
    .where(eq(purchaseOrdersTable.id, id));

  if (!row) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const [{ cnt: itemCount }] = await db.select({ cnt: count() })
    .from(purchaseOrderItemsTable).where(eq(purchaseOrderItemsTable.poId, id));

  res.json({
    id: row.po.id,
    internalPoNo: row.po.internalPoNo,
    sheetPoNo: row.po.sheetPoNo,
    receiverName: row.po.receiverName,
    receiverPhone: row.po.receiverPhone,
    status: row.po.status,
    employeeId: row.po.employeeId,
    employeeName: row.employeeName,
    notes: row.po.notes,
    itemCount,
    createdAt: row.po.createdAt.toISOString(),
    updatedAt: row.po.updatedAt.toISOString(),
  });
});

router.get("/po/:id/items", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const rows = await db.select({
    item: purchaseOrderItemsTable,
    supplierName: suppliersTable.name,
  }).from(purchaseOrderItemsTable)
    .leftJoin(suppliersTable, eq(purchaseOrderItemsTable.supplierId, suppliersTable.id))
    .where(eq(purchaseOrderItemsTable.poId, id));

  res.json(rows.map((r) => ({
    id: r.item.id,
    poId: r.item.poId,
    supplierId: r.item.supplierId,
    supplierName: r.supplierName,
    itemId: r.item.itemId,
    lineItem: r.item.lineItem,
    partNo: r.item.partNo,
    description: r.item.description,
    uom: r.item.uom,
    qty: r.item.qty ? parseFloat(r.item.qty) : null,
    referencePrice: r.item.referencePrice ? parseFloat(r.item.referencePrice) : null,
  })));
});

export default router;
