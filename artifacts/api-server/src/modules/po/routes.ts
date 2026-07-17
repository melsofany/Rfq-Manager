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
  whatsappChatsTable,
  rfqTable,
} from "@workspace/db";
import { eq, count, inArray, sql, and } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { lookupPoFromSheet, listSheetPoNumbers } from "../../shared/google-sheets";
import { generatePoPdf } from "./po-pdf";
import { sendPoWhatsApp, isWhatsAppConfigured } from "../communications/service";
import { sendPoEmail } from "../../shared/email";

const router = Router();

function normalizePhone(phone: string): string {
  let cleaned = phone.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);
  if (cleaned.length === 11 && cleaned.startsWith("0")) cleaned = "2" + cleaned;
  if (cleaned.length === 10 && cleaned.startsWith("1")) cleaned = "20" + cleaned;
  return cleaned;
}

// Arbitrary advisory lock key used to serialize PO number generation.
// Only one transaction at a time can hold this lock, preventing duplicate
// internalPoNo values even under concurrent creates.
const PO_LOCK_KEY = 7_391_042;

/**
 * Generate the next internal PO number for the current year.
 * Must be called inside a Drizzle transaction with the advisory lock already held.
 * Uses MAX of existing numbers (not COUNT) so deletions never cause collisions.
 */
async function generateInternalPoNoInTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `PO-${year}-`;

  const [result] = await tx
    .select({ maxNo: sql<string | null>`max(${purchaseOrdersTable.internalPoNo})` })
    .from(purchaseOrdersTable)
    .where(sql`${purchaseOrdersTable.internalPoNo} like ${prefix + "%"}`);

  let seq = 1;
  if (result?.maxNo) {
    const lastSeq = parseInt(result.maxNo.slice(prefix.length), 10);
    if (!isNaN(lastSeq) && lastSeq > 0) seq = lastSeq + 1;
  }

  return `${prefix}${String(seq).padStart(6, "0")}`;
}

router.get("/po", requireAuth, async (req, res): Promise<void> => {
  const { status, search } = req.query as Record<string, string>;

  const rows = await db
    .select({
      po: purchaseOrdersTable,
      employeeName: employeesTable.name,
    })
    .from(purchaseOrdersTable)
    .leftJoin(employeesTable, eq(purchaseOrdersTable.employeeId, employeesTable.id))
    .orderBy(sql`${purchaseOrdersTable.createdAt} DESC`);

  let filtered = rows;
  if (status) filtered = filtered.filter((r) => r.po.status === status);
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        r.po.internalPoNo.toLowerCase().includes(s) || r.po.sheetPoNo.toLowerCase().includes(s),
    );
  }

  const poIds = filtered.map((r) => r.po.id);
  const itemCounts =
    poIds.length > 0
      ? await db
          .select({ poId: purchaseOrderItemsTable.poId, cnt: count() })
          .from(purchaseOrderItemsTable)
          .where(inArray(purchaseOrderItemsTable.poId, poIds))
          .groupBy(purchaseOrderItemsTable.poId)
      : [];
  const itemMap = Object.fromEntries(itemCounts.map((r) => [r.poId, r.cnt]));

  res.json(
    filtered.map((r) => ({
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
    })),
  );
});

router.post("/po", requireAuth, async (req, res): Promise<void> => {
  const { sheetPoNo, receiverName, receiverPhone, notes, items, rfqId } = req.body as {
    sheetPoNo?: string;
    receiverName?: string;
    receiverPhone?: string;
    notes?: string;
    rfqId?: number | null;
    items?: Array<{
      itemId?: string | null;
      lineItem?: string;
      partNo?: string;
      description: string;
      uom?: string;
      qty?: string | number | null;
      referencePrice?: string | number | null;
      supplierId?: number | null;
      taxIncluded?: boolean;
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

  try {
    const created = await db.transaction(async (tx) => {
      // Acquire a transaction-level advisory lock so concurrent PO creates
      // are serialized and cannot generate duplicate internalPoNo values.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PO_LOCK_KEY})`);

      const internalPoNo = await generateInternalPoNoInTx(tx);

      const [po] = await tx
        .insert(purchaseOrdersTable)
        .values({
          internalPoNo,
          sheetPoNo,
          receiverName: receiverName || null,
          receiverPhone: receiverPhone || null,
          status: "draft",
          employeeId: req.session.employeeId,
          notes: notes || null,
        })
        .returning();

      await tx.insert(purchaseOrderItemsTable).values(
        validItems.map((it) => ({
          poId: po.id,
          itemId: it.itemId || null,
          lineItem: it.lineItem || null,
          partNo: it.partNo || null,
          description: it.description.trim(),
          uom: it.uom || null,
          qty: it.qty != null && it.qty !== "" ? String(it.qty) : null,
          referencePrice:
            it.referencePrice != null && it.referencePrice !== ""
              ? String(it.referencePrice)
              : null,
          supplierId: it.supplierId ?? null,
          taxIncluded: it.taxIncluded ?? false,
        })),
      );

      await tx.insert(auditLogTable).values({
        action: "po.created",
        entityType: "po",
        entityId: po.id,
        employeeId: req.session.employeeId,
        description: `Created purchase order ${internalPoNo} for PO ${sheetPoNo} with ${validItems.length} item(s)`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });

      // If linked to an RFQ, mark it as SUCCESS
      if (rfqId) {
        await tx.update(rfqTable).set({ status: "SUCCESS" }).where(eq(rfqTable.id, rfqId));
        await tx.insert(auditLogTable).values({
          action: "rfq.success",
          entityType: "rfq",
          entityId: rfqId,
          employeeId: req.session.employeeId,
          description: `RFQ marked SUCCESS — PO ${internalPoNo} created`,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        });
      }

      return po;
    });

    res.status(201).json({
      id: created.id,
      internalPoNo: created.internalPoNo,
      sheetPoNo: created.sheetPoNo,
      receiverName: created.receiverName,
      receiverPhone: created.receiverPhone,
      status: created.status,
      employeeId: created.employeeId,
      employeeName: null,
      notes: created.notes,
      itemCount: validItems.length,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to create purchase order");
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Failed to create purchase order", details: message });
  }
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
    res
      .status(500)
      .json({ error: "Failed to fetch from Google Sheets", details: (err as Error).message });
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
    res
      .status(500)
      .json({ error: "Failed to connect to Google Sheets", details: (err as Error).message });
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
        sql`lower(${rfqItemsTable.description}) = ${descNorm}`,
      ),
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
        and(eq(offersTable.supplierId, supplierIdInt), eq(rfqItemsTable.partNo, partNo.trim())),
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

// POST /api/po/:id/dispatch — generate PDF per supplier and send via WhatsApp + email
router.post("/po/:id/dispatch", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  // Fetch PO + employee
  const [poRow] = await db
    .select({
      po: purchaseOrdersTable,
      employeeName: employeesTable.name,
      employeePhone: employeesTable.phone,
    })
    .from(purchaseOrdersTable)
    .leftJoin(employeesTable, eq(purchaseOrdersTable.employeeId, employeesTable.id))
    .where(eq(purchaseOrdersTable.id, id));

  if (!poRow) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  // Fetch all items with supplier info
  const itemRows = await db
    .select({ item: purchaseOrderItemsTable, supplier: suppliersTable })
    .from(purchaseOrderItemsTable)
    .leftJoin(suppliersTable, eq(purchaseOrderItemsTable.supplierId, suppliersTable.id))
    .where(eq(purchaseOrderItemsTable.poId, id));

  // Group items by supplierId (skip items without a supplier)
  const bySupplier = new Map<
    number,
    { supplier: typeof suppliersTable.$inferSelect; items: typeof itemRows }
  >();
  for (const row of itemRows) {
    if (!row.item.supplierId || !row.supplier) continue;
    const sid = row.item.supplierId;
    if (!bySupplier.has(sid)) bySupplier.set(sid, { supplier: row.supplier, items: [] });
    bySupplier.get(sid)!.items.push(row);
  }

  if (bySupplier.size === 0) {
    res.status(400).json({ error: "No items have a supplier assigned" });
    return;
  }

  const results: Array<{
    supplierId: number;
    supplierName: string;
    emailSent: boolean;
    emailError: string | null;
    whatsappSent: boolean;
    whatsappError: string | null;
  }> = [];

  const poNo = poRow.po.internalPoNo;
  const poDate = poRow.po.createdAt.toISOString();
  const employeeName = poRow.employeeName ?? "Cortoba Supplies";
  const employeePhone = poRow.employeePhone ?? null;
  const receiverName = poRow.po.receiverName ?? null;
  const receiverPhone = poRow.po.receiverPhone ?? null;
  const notes = poRow.po.notes ?? null;

  for (const [supplierId, { supplier, items }] of bySupplier) {
    const pdfItems = items.map((r) => ({
      lineItem: r.item.lineItem,
      partNo: r.item.partNo,
      description: r.item.description,
      qty: r.item.qty,
      uom: r.item.uom,
      unitPrice: r.item.referencePrice,
      taxIncluded: r.item.taxIncluded ?? false,
    }));

    // Generate PDF once per supplier
    let pdfBuffer: Buffer | null = null;
    try {
      pdfBuffer = await generatePoPdf({
        poNo,
        poDate,
        supplierName: supplier.name,
        contactPerson: supplier.contactPerson,
        receiverName,
        receiverPhone,
        employeeName,
        employeePhone,
        notes,
        items: pdfItems,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        supplierId,
        supplierName: supplier.name,
        emailSent: false,
        emailError: `PDF error: ${msg}`,
        whatsappSent: false,
        whatsappError: `PDF error: ${msg}`,
      });
      continue;
    }

    let emailSent = false;
    let emailError: string | null = null;
    let whatsappSent = false;
    let whatsappError: string | null = null;

    // Send email if supplier has email
    if (supplier.email?.trim()) {
      try {
        await sendPoEmail({
          to: supplier.email.trim(),
          toName: supplier.contactPerson ?? supplier.name,
          poNo,
          poDate,
          receiverName,
          receiverPhone,
          employeeName,
          employeePhone,
          notes,
          items: pdfItems,
          pdfBuffer,
        });
        emailSent = true;
      } catch (err) {
        emailError = err instanceof Error ? err.message : String(err);
        req.log.error({ err, supplierId, email: supplier.email }, "PO dispatch: email failed");
      }
    }

    // Send WhatsApp if supplier has phone and WhatsApp is configured
    if (supplier.phone?.trim() && isWhatsAppConfigured) {
      try {
        const wamid = await sendPoWhatsApp({
          phone: supplier.phone.trim(),
          supplierName: supplier.name,
          contactPerson: supplier.contactPerson,
          poNo,
          poDate,
          receiverName,
          receiverPhone,
          employeeName,
          employeePhone,
          notes,
          items: pdfItems,
        });
        whatsappSent = true;

        // Save to whatsapp_chats so the message appears in the chat history
        const chatPhone = normalizePhone(supplier.phone.trim());
        await db
          .insert(whatsappChatsTable)
          .values({
            waMessageId: wamid ?? null,
            direction: "outbound",
            phone: chatPhone,
            supplierId,
            body: `[أمر شراء PDF: ${poNo}]`,
            mediaType: "document",
            filename: `PO-${poNo}.pdf`,
            isRead: true,
          })
          .catch((saveErr) => {
            req.log.error(
              { err: saveErr, supplierId, poNo },
              "PO dispatch: failed to save WhatsApp chat record",
            );
          });
      } catch (err) {
        whatsappError = err instanceof Error ? err.message : String(err);
        req.log.error({ err, supplierId, phone: supplier.phone }, "PO dispatch: WhatsApp failed");
      }
    } else if (!isWhatsAppConfigured) {
      whatsappError = "WhatsApp not configured";
    } else if (!supplier.phone?.trim()) {
      whatsappError = "No phone number";
    }

    results.push({
      supplierId,
      supplierName: supplier.name,
      emailSent,
      emailError,
      whatsappSent,
      whatsappError,
    });
  }

  // Update PO status to "sent" if at least one message went through
  const anySent = results.some((r) => r.emailSent || r.whatsappSent);
  if (anySent) {
    await db
      .update(purchaseOrdersTable)
      .set({ status: "sent", updatedAt: new Date() })
      .where(eq(purchaseOrdersTable.id, id));

    await db.insert(auditLogTable).values({
      action: "po.dispatched",
      entityType: "po",
      entityId: id,
      employeeId: req.session.employeeId,
      description: `Dispatched PO ${poNo} to ${results.filter((r) => r.emailSent || r.whatsappSent).length} supplier(s)`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });
  }

  res.json({ poNo, results });
});

// GET /api/po/:id/pdf/:supplierId — download PO PDF for a specific supplier
router.get("/po/:id/pdf/:supplierId", requireAuth, async (req, res): Promise<void> => {
  const poId = parseInt(req.params.id, 10);
  const supplierId = parseInt(req.params.supplierId, 10);

  const [poRow] = await db
    .select({
      po: purchaseOrdersTable,
      employeeName: employeesTable.name,
      employeePhone: employeesTable.phone,
    })
    .from(purchaseOrdersTable)
    .leftJoin(employeesTable, eq(purchaseOrdersTable.employeeId, employeesTable.id))
    .where(eq(purchaseOrdersTable.id, poId));

  if (!poRow) {
    res.status(404).json({ error: "PO not found" });
    return;
  }

  const [supplierRow] = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.id, supplierId));
  if (!supplierRow) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const items = await db
    .select({ item: purchaseOrderItemsTable })
    .from(purchaseOrderItemsTable)
    .where(
      and(
        eq(purchaseOrderItemsTable.poId, poId),
        eq(purchaseOrderItemsTable.supplierId, supplierId),
      ),
    );

  const pdfBuffer = await generatePoPdf({
    poNo: poRow.po.internalPoNo,
    poDate: poRow.po.createdAt.toISOString(),
    supplierName: supplierRow.name,
    contactPerson: supplierRow.contactPerson,
    receiverName: poRow.po.receiverName,
    receiverPhone: poRow.po.receiverPhone,
    employeeName: poRow.employeeName ?? "Cortoba Supplies",
    employeePhone: poRow.employeePhone ?? null,
    notes: poRow.po.notes,
    items: items.map((r) => ({
      lineItem: r.item.lineItem,
      partNo: r.item.partNo,
      description: r.item.description,
      qty: r.item.qty,
      uom: r.item.uom,
      unitPrice: r.item.referencePrice,
      taxIncluded: r.item.taxIncluded ?? false,
    })),
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="PO-${poRow.po.internalPoNo}-${supplierRow.name}.pdf"`,
  );
  res.send(pdfBuffer);
});

router.get("/po/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const [row] = await db
    .select({
      po: purchaseOrdersTable,
      employeeName: employeesTable.name,
    })
    .from(purchaseOrdersTable)
    .leftJoin(employeesTable, eq(purchaseOrdersTable.employeeId, employeesTable.id))
    .where(eq(purchaseOrdersTable.id, id));

  if (!row) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const [{ cnt: itemCount }] = await db
    .select({ cnt: count() })
    .from(purchaseOrderItemsTable)
    .where(eq(purchaseOrderItemsTable.poId, id));

  // Fetch linked RFQ info if present
  let linkedRfq: { id: number; internalRfqNo: string; status: string } | null = null;
  if (row.po.rfqId) {
    const [rfqRow] = await db
      .select({ id: rfqTable.id, internalRfqNo: rfqTable.internalRfqNo, status: rfqTable.status })
      .from(rfqTable)
      .where(eq(rfqTable.id, row.po.rfqId));
    if (rfqRow) linkedRfq = rfqRow;
  }

  res.json({
    id: row.po.id,
    internalPoNo: row.po.internalPoNo,
    sheetPoNo: row.po.sheetPoNo,
    receiverName: row.po.receiverName,
    receiverPhone: row.po.receiverPhone,
    status: row.po.status,
    employeeId: row.po.employeeId,
    employeeName: row.employeeName,
    rfqId: row.po.rfqId ?? null,
    linkedRfq,
    notes: row.po.notes,
    itemCount,
    createdAt: row.po.createdAt.toISOString(),
    updatedAt: row.po.updatedAt.toISOString(),
  });
});

// PATCH /api/po/:id/link-rfq — link an existing PO to an RFQ and mark the RFQ as SUCCESS
router.patch("/po/:id/link-rfq", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const poId = parseInt(raw, 10);
  const { rfqId } = req.body as { rfqId: number | null };

  const [po] = await db.select().from(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, poId));
  if (!po) {
    res.status(404).json({ error: "PO not found" });
    return;
  }

  if (rfqId != null) {
    const [rfq] = await db.select().from(rfqTable).where(eq(rfqTable.id, rfqId));
    if (!rfq) {
      res.status(404).json({ error: "RFQ not found" });
      return;
    }

    await db.transaction(async (tx) => {
      await tx.update(purchaseOrdersTable).set({ rfqId }).where(eq(purchaseOrdersTable.id, poId));
      await tx.update(rfqTable).set({ status: "SUCCESS" }).where(eq(rfqTable.id, rfqId));
      await tx.insert(auditLogTable).values({
        action: "po.linked_rfq",
        entityType: "po",
        entityId: poId,
        description: `PO ${po.internalPoNo} linked to RFQ ${rfq.internalRfqNo} — RFQ marked SUCCESS`,
      });
    });

    res.json({ ok: true, rfqId, rfqStatus: "SUCCESS" });
  } else {
    // Unlink: just clear rfqId (do NOT revert the RFQ status)
    await db
      .update(purchaseOrdersTable)
      .set({ rfqId: null })
      .where(eq(purchaseOrdersTable.id, poId));
    res.json({ ok: true, rfqId: null });
  }
});

router.get("/po/:id/items", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const rows = await db
    .select({
      item: purchaseOrderItemsTable,
      supplierName: suppliersTable.name,
    })
    .from(purchaseOrderItemsTable)
    .leftJoin(suppliersTable, eq(purchaseOrderItemsTable.supplierId, suppliersTable.id))
    .where(eq(purchaseOrderItemsTable.poId, id));

  res.json(
    rows.map((r) => ({
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
      taxIncluded: r.item.taxIncluded ?? false,
    })),
  );
});

export default router;
