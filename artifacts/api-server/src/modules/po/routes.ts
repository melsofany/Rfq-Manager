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
  workOrderAssignmentsTable,
  customerPosTable,
  customerPoItemsTable,
  poItemReceiptsTable,
  WORK_ORDER_KIND,
} from "@workspace/db";
import { eq, count, inArray, sql, and, ilike, ne, desc } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { lookupPoFromSheet, listSheetPoNumbers } from "../../shared/google-sheets";
import { generatePoPdf } from "./po-pdf";
import {
  sendPoWhatsApp,
  isWhatsAppConfigured,
  sendRepPoDispatchWhatsApp,
  formatQty as formatWaQty,
  sendPoCancelWhatsApp,
} from "../communications/service";
import { sendPoEmail } from "../../shared/email";

const router = Router();

export function normalizePhone(phone: string): string {
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

router.get("/po/progress", requireAuth, async (req, res): Promise<void> => {
  // Batched receipt progress per PO: total items, fulfilled, rejected.
  // Used by the PO list tab to show a "received/total" badge + rejected count.
  // Cancelled POs are excluded — their lines were reset to "pending" and a
  // cancelled order should not surface a (now meaningless) receipt badge.
  const rows = await db
    .select({
      poId: purchaseOrderItemsTable.poId,
      lineStatus: purchaseOrderItemsTable.lineStatus,
    })
    .from(purchaseOrderItemsTable)
    .innerJoin(purchaseOrdersTable, eq(purchaseOrderItemsTable.poId, purchaseOrdersTable.id))
    .where(ne(purchaseOrdersTable.status, "cancelled"));
  const byPo = new Map<number, { total: number; received: number; rejected: number }>();
  for (const r of rows) {
    const e = byPo.get(r.poId) ?? { total: 0, received: 0, rejected: 0 };
    // Cancelled supplier lines are excluded from the badge entirely (they no
    // longer await receipt and are not a success/failure outcome).
    if (r.lineStatus === "cancelled") continue;
    e.total++;
    if (r.lineStatus === "fulfilled") e.received++;
    else if (r.lineStatus === "rejected") e.rejected++;
    byPo.set(r.poId, e);
  }
  res.json(
    Array.from(byPo.entries()).map(([poId, v]) => ({ poId, ...v })),
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
      customerPoItemId?: number | null;
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
          customerPoItemId: it.customerPoItemId ?? null,
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

  // Automatic source selection: prefer a matching customer PO (entered on
  // /customer-po) over Google Sheets. If no customer PO matches, fall back to
  // the sheet so legacy PO numbers still resolve.
  try {
    const [po] = await db
      .select()
      .from(customerPosTable)
      .where(ilike(customerPosTable.customerPoNo, poNo))
      .limit(1);
    if (po) {
      const items = await db
        .select()
        .from(customerPoItemsTable)
        .where(eq(customerPoItemsTable.customerPoId, po.id));
      if (items.length > 0) {
        res.json(
          items.map((i) => ({
            itemId: i.id != null ? String(i.id) : null,
            customerPoItemId: i.id ?? null,
            lineItem: i.lineItem,
            partNo: i.partNo,
            description: i.description ?? "",
            uom: i.uom,
            qty: i.qty != null ? Number(i.qty) : null,
            referencePrice: i.unitPrice != null ? Number(i.unitPrice) : null,
            poNo: po.customerPoNo,
          })),
        );
        return;
      }
    }
  } catch (err) {
    req.log.warn({ err, poNo }, "Customer PO lookup failed, falling back to Google Sheets");
  }

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

// ── Customer PO numbers ─────────────────────────────────────────────────────
// Customer PO numbers feed the purchase-order combobox. The actual item
// lookup is handled by /po/lookup/:poNo above (which prefers a matching
// customer PO and falls back to Google Sheets automatically).

// GET /api/po/customer-po-numbers — list customer PO numbers for the combobox.
router.get("/po/customer-po-numbers", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: customerPosTable.id,
      customerPoNo: customerPosTable.customerPoNo,
      internalPoNo: customerPosTable.internalPoNo,
      customerName: customerPosTable.customerName,
      status: customerPosTable.status,
    })
    .from(customerPosTable)
    .orderBy(sql`${customerPosTable.createdAt} DESC`);
  res.json({
    poNumbers: rows.map((r) => ({
      value: r.customerPoNo,
      label: r.customerPoNo,
      internalNo: r.internalPoNo,
      customerName: r.customerName,
      status: r.status,
    })),
  });
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
        try {
          await db.insert(whatsappChatsTable).values({
            waMessageId: wamid ?? null,
            direction: "outbound",
            phone: chatPhone,
            supplierId,
            body: `[أمر شراء PDF: ${poNo}]`,
            mediaType: "document",
            filename: `PO-${poNo}.pdf`,
            isRead: true,
          });
        } catch (saveErr) {
          req.log.error(
            { err: saveErr, supplierId, poNo, chatPhone, wamid },
            "PO dispatch: failed to save WhatsApp chat record",
          );
        }
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

  let workOrderSent = false;
  let workOrderError: string | null = null;
  if (receiverName?.trim() && receiverPhone?.trim()) {
    if (!isWhatsAppConfigured) {
      workOrderError = "WhatsApp not configured";
    } else {
      // Send the representative ONE consolidated receipt notification per
      // supplier (not one message per item). The message lists the supplier
      // (name / address / phone), the PO number, and ALL pending line items
      // with clean quantities, plus a «بدء الاستلام» button that opens the rep
      // bot receipt menu. Assignment rows are created up front for every
      // pending item so the menu shows all items even if the WhatsApp send
      // is rate-limited or fails — this was the root cause of items going
      // missing (a failed second send also skipped its assignment insert).
      const repName = receiverName.trim();
      const repPhone = normalizePhone(receiverPhone.trim());
      let sentCount = 0;
      let firstError: string | null = null;

      // Group pending items by supplier (reuse the bySupplier map).
      for (const [supplierId, { supplier, items }] of bySupplier) {
        const pending = items.filter(
          (r) => r.item.lineStatus !== "fulfilled" && r.item.lineStatus !== "rejected",
        );
        if (pending.length === 0) continue;

        // Create assignment rows for ALL pending items first (independent of WA).
        // Idempotent: skip items that already have an active receipt assignment
        // (so re-dispatching doesn't pile up duplicate rows).
        for (const r of pending) {
          const [existing] = await db
            .select({ id: workOrderAssignmentsTable.id })
            .from(workOrderAssignmentsTable)
            .where(
              and(
                eq(workOrderAssignmentsTable.poItemId, r.item.id),
                eq(workOrderAssignmentsTable.kind, WORK_ORDER_KIND.RECEIPT),
                ne(workOrderAssignmentsTable.status, "received"),
                ne(workOrderAssignmentsTable.status, "rejected"),
              ),
            )
            .limit(1);
          if (existing) continue;
          try {
            await db.insert(workOrderAssignmentsTable).values({
              poId: id,
              poItemId: r.item.id,
              representativeName: repName,
              representativePhone: repPhone,
              status: "sent",
              kind: WORK_ORDER_KIND.RECEIPT,
            });
          } catch (err) {
            req.log.warn({ err, poItemId: r.item.id }, "Rep receipt assignment insert failed");
          }
        }

        try {
          const waId = await sendRepPoDispatchWhatsApp({
            phone: repPhone,
            poNo,
            supplierName: supplier.name,
            supplierAddress: supplier.address,
            supplierPhone: supplier.phone,
            items: pending.map((r) => ({
              lineItem: r.item.lineItem,
              description: r.item.description,
              qty: formatWaQty(r.item.qty),
              uom: r.item.uom,
            })),
          });
          if (waId) {
            sentCount++;
          } else {
            if (!firstError) firstError = "WhatsApp send returned no message id";
          }
        } catch (err) {
          if (!firstError) firstError = err instanceof Error ? err.message : String(err);
          req.log.warn(
            { err, supplierId, poNo },
            "Representative consolidated receipt notification failed",
          );
        }
      }
      workOrderSent = sentCount > 0;
      workOrderError = firstError;
    }
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

  res.json({ poNo, results, workOrderSent, workOrderError });
});

// POST /api/po/:id/cancel — cancel a single supplier's lines within a
// dispatched ("sent") purchase order (per-supplier cancellation, NOT the
// whole PO). Marks that supplier's purchase_order_items lines as
// "cancelled", resets their receipt totals + wipes their work-order
// assignments so they vanish from the rep bot's receipt/delivery lists and
// the analytics receipt counters. Sends a WhatsApp cancellation notice to
// that supplier only (best-effort). If the supplier was the LAST active one
// (no non-cancelled lines remain), the whole PO is flipped to "cancelled".
//
// Body: { supplierId: number, reason?: string | null }
router.post("/po/:id/cancel", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const { supplierId, reason } = (req.body ?? {}) as { supplierId?: number; reason?: string | null };

  if (supplierId == null || !Number.isFinite(supplierId)) {
    res.status(400).json({ error: "يجب تحديد المورد المراد إلغاؤه" });
    return;
  }

  const [poRow] = await db
    .select()
    .from(purchaseOrdersTable)
    .where(eq(purchaseOrdersTable.id, id));
  if (!poRow) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }
  if (poRow.status === "draft") {
    res.status(400).json({ error: "لا يمكن إلغاء أمر شراء في حالة Draft — احذفه بدلاً من ذلك" });
    return;
  }
  if (poRow.status === "cancelled") {
    res.status(400).json({ error: "أمر الشراء ملغي بالفعل" });
    return;
  }

  // The supplier whose lines we are cancelling + the items that belong to it.
  const [supplier] = await db
    .select({
      id: suppliersTable.id,
      name: suppliersTable.name,
      phone: suppliersTable.phone,
      contactPerson: suppliersTable.contactPerson,
      email: suppliersTable.email,
    })
    .from(suppliersTable)
    .where(eq(suppliersTable.id, supplierId));
  if (!supplier) {
    res.status(404).json({ error: "المورد غير موجود" });
    return;
  }

  const itemRows = await db
    .select({
      id: purchaseOrderItemsTable.id,
      lineStatus: purchaseOrderItemsTable.lineStatus,
    })
    .from(purchaseOrderItemsTable)
    .where(
      and(
        eq(purchaseOrderItemsTable.poId, id),
        eq(purchaseOrderItemsTable.supplierId, supplierId),
      ),
    );
  if (itemRows.length === 0) {
    res.status(400).json({ error: "لا توجد بنود لهذا المورد في أمر الشراء" });
    return;
  }
  // Block cancelling a supplier whose lines have already been received/delivered
  // (fulfilled|partial|rejected) — doing so would wipe real receipt data. Only
  // pending/postponed lines (no receipt recorded yet) may be cancelled.
  const RECEIVED_STATES = ["fulfilled", "partial", "rejected"];
  if (itemRows.some((r) => RECEIVED_STATES.includes((r.lineStatus ?? "pending")))) {
    res.status(400).json({
      error: "لا يمكن إلغاء مورد تم استلام أو تسليم بنوده فعلياً — أعد ضبط البنود يدوياً إن لزم",
    });
    return;
  }
  const itemIds = itemRows.map((r) => r.id);

  const poNo = poRow.internalPoNo;
  const cancelReason = (reason ?? "").trim() || null;

  // Notify only this supplier via WhatsApp (best-effort — a failed send never
  // blocks the cancellation itself).
  let whatsappSent = false;
  let whatsappError: string | null = null;
  if (supplier.phone?.trim() && isWhatsAppConfigured) {
    try {
      const waId = await sendPoCancelWhatsApp({
        phone: supplier.phone.trim(),
        supplierName: supplier.name,
        contactPerson: supplier.contactPerson,
        poNo,
        reason: cancelReason,
      });
      whatsappSent = Boolean(waId);
      if (!waId) whatsappError = "WhatsApp send returned no message id";
      try {
        await db.insert(whatsappChatsTable).values({
          waMessageId: waId ?? null,
          direction: "outbound",
          phone: normalizePhone(supplier.phone.trim()),
          supplierId: supplier.id,
          body: `[إلغاء أمر شراء: ${poNo} — ${supplier.name}]${cancelReason ? ` — ${cancelReason}` : ""}`,
          isRead: true,
        });
      } catch (saveErr) {
        req.log.error({ err: saveErr, supplierId: supplier.id, poNo }, "PO cancel: failed to save WhatsApp chat record");
      }
    } catch (err) {
      whatsappError = err instanceof Error ? err.message : String(err);
      req.log.error({ err, supplierId: supplier.id, phone: supplier.phone }, "PO cancel: WhatsApp failed");
    }
  } else {
    whatsappError = !isWhatsAppConfigured ? "WhatsApp not configured" : "No phone number";
  }

  try {
    // If this supplier was the LAST active one (every remaining non-cancelled
    // line belongs to it), the whole PO becomes "cancelled"; otherwise it stays
    // "sent" with the other suppliers' lines intact.
    const allItems = await db
      .select({ id: purchaseOrderItemsTable.id, lineStatus: purchaseOrderItemsTable.lineStatus, supplierId: purchaseOrderItemsTable.supplierId })
      .from(purchaseOrderItemsTable)
      .where(eq(purchaseOrderItemsTable.poId, id));
    const remainingActive = allItems.filter(
      (r) => r.lineStatus !== "cancelled" && !(r.supplierId === supplierId && itemIds.includes(r.id)),
    );
    const wholePoCancelled = remainingActive.length === 0;

    await db.transaction(async (tx) => {
      // Reset this supplier's lines to "cancelled" + zeroed receipt totals so
      // they no longer count as received/success anywhere.
      await tx
        .update(purchaseOrderItemsTable)
        .set({
          lineStatus: "cancelled",
          totalReceivedQty: null,
          totalAcceptedQty: null,
          totalRejectedQty: null,
          finalActualCost: null,
        })
        .where(inArray(purchaseOrderItemsTable.id, itemIds));
      // Wipe the rep-bot receipt/delivery assignments for these lines only.
      await tx
        .delete(workOrderAssignmentsTable)
        .where(inArray(workOrderAssignmentsTable.poItemId, itemIds));
      if (wholePoCancelled) {
        await tx
          .update(purchaseOrdersTable)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(purchaseOrdersTable.id, id));
      }

      await tx.insert(auditLogTable).values({
        action: "po.supplier_cancelled",
        entityType: "po",
        entityId: id,
        employeeId: req.session.employeeId,
        description: `Cancelled supplier ${supplier.name} (id ${supplierId}) on PO ${poNo}${cancelReason ? ` — ${cancelReason}` : ""}${wholePoCancelled ? " (whole PO now cancelled)" : ""}`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });
    });

    res.json({
      ok: true,
      id,
      poStatus: wholePoCancelled ? "cancelled" : poRow.status,
      cancelledSupplier: { id: supplier.id, name: supplier.name },
      cancelledItemIds: itemIds,
      whatsapp: { whatsappSent, whatsappError },
    });
  } catch (err) {
    req.log.error({ err, id, supplierId }, "Failed to cancel supplier on purchase order");
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Failed to cancel supplier on purchase order", details: message });
  }
});

// GET /api/po/:id/pdf/:supplierId — download PO PDF for a specific supplier
router.get("/po/:id/pdf/:supplierId", requireAuth, async (req, res): Promise<void> => {
  const poId = parseInt(req.params.id as string, 10);
  const supplierId = parseInt(req.params.supplierId as string, 10);

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

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await generatePoPdf({
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
  } catch (err) {
    req.log.error({ err, poId, supplierId }, "Failed to generate PO PDF");
    res.status(500).json({ error: "Failed to generate PDF" });
    return;
  }

  // Use a plain ASCII base filename for old browsers, plus RFC 5987 encoded
  // full filename (may include Arabic supplier name) for modern browsers.
  const baseFilename = `PO-${poRow.po.internalPoNo}.pdf`;
  const fullFilename = `PO-${poRow.po.internalPoNo}-${supplierRow.name}.pdf`;
  const encodedFilename = encodeURIComponent(fullFilename);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", pdfBuffer.length);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${baseFilename}"; filename*=UTF-8''${encodedFilename}`,
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

// PUT /api/po/:id — update a DRAFT purchase order (PO-level fields + full items replacement).
// Only POs still in "draft" status may be edited. Once dispatched ("sent") the PO is locked.
router.put("/po/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const { sheetPoNo, receiverName, receiverPhone, notes, employeeId, items } = req.body as {
    sheetPoNo?: string;
    receiverName?: string;
    receiverPhone?: string;
    notes?: string;
    employeeId?: number | null;
    items?: Array<{
      itemId?: string | null;
      customerPoItemId?: number | null;
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

  const [existing] = await db
    .select()
    .from(purchaseOrdersTable)
    .where(eq(purchaseOrdersTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }
  if (existing.status !== "draft") {
    res
      .status(400)
      .json({ error: "لا يمكن تعديل أمر الشراء بعد إرساله — فقط الأوامر في حالة Draft قابلة للتعديل" });
    return;
  }

  if (!sheetPoNo || !sheetPoNo.trim()) {
    res.status(400).json({ error: "sheetPoNo required" });
    return;
  }
  const validItems = (items ?? []).filter((it) => it.description?.trim());
  if (validItems.length === 0) {
    res.status(400).json({ error: "At least one item is required" });
    return;
  }

  try {
    const updated = await db.transaction(async (tx) => {
      const [po] = await tx
        .update(purchaseOrdersTable)
        .set({
          sheetPoNo: sheetPoNo.trim(),
          receiverName: receiverName?.trim() || null,
          receiverPhone: receiverPhone?.trim() || null,
          notes: notes?.trim() || null,
          employeeId: employeeId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(purchaseOrdersTable.id, id))
        .returning();

      // Full replacement of items: delete then re-insert. Keeps add/edit/remove trivial.
      await tx.delete(purchaseOrderItemsTable).where(eq(purchaseOrderItemsTable.poId, id));
      await tx.insert(purchaseOrderItemsTable).values(
        validItems.map((it) => ({
          poId: id,
          itemId: it.itemId || null,
          customerPoItemId: it.customerPoItemId ?? null,
          lineItem: it.lineItem || null,
          partNo: it.partNo || null,
          description: it.description.trim(),
          uom: it.uom || null,
          qty: it.qty != null && it.qty !== "" ? String(it.qty) : null,
          referencePrice:
            it.referencePrice != null && it.referencePrice !== "" ? String(it.referencePrice) : null,
          supplierId: it.supplierId ?? null,
          taxIncluded: it.taxIncluded ?? false,
        })),
      );

      await tx.insert(auditLogTable).values({
        action: "po.updated",
        entityType: "po",
        entityId: id,
        employeeId: req.session.employeeId,
        description: `Updated draft purchase order ${po.internalPoNo} (${validItems.length} item(s))`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });

      return po;
    });

    const [{ cnt: itemCount }] = await db
      .select({ cnt: count() })
      .from(purchaseOrderItemsTable)
      .where(eq(purchaseOrderItemsTable.poId, id));

    let linkedRfq: { id: number; internalRfqNo: string; status: string } | null = null;
    if (updated.rfqId) {
      const [rfqRow] = await db
        .select({ id: rfqTable.id, internalRfqNo: rfqTable.internalRfqNo, status: rfqTable.status })
        .from(rfqTable)
        .where(eq(rfqTable.id, updated.rfqId));
      if (rfqRow) linkedRfq = rfqRow;
    }

    let employeeName: string | null = null;
    if (updated.employeeId) {
      const [empRow] = await db
        .select({ name: employeesTable.name })
        .from(employeesTable)
        .where(eq(employeesTable.id, updated.employeeId));
      employeeName = empRow?.name ?? null;
    }

    res.json({
      id: updated.id,
      internalPoNo: updated.internalPoNo,
      sheetPoNo: updated.sheetPoNo,
      receiverName: updated.receiverName,
      receiverPhone: updated.receiverPhone,
      status: updated.status,
      employeeId: updated.employeeId,
      employeeName,
      rfqId: updated.rfqId ?? null,
      linkedRfq,
      notes: updated.notes,
      itemCount,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err, id }, "Failed to update purchase order");
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Failed to update purchase order", details: message });
  }
});

// DELETE /api/po/:id — delete a DRAFT purchase order and all its line items.
router.delete("/po/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const [existing] = await db
    .select()
    .from(purchaseOrdersTable)
    .where(eq(purchaseOrdersTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }
  if (existing.status !== "draft") {
    res
      .status(400)
      .json({ error: "لا يمكن حذف أمر الشراء بعد إرساله — فقط الأوامر في حالة Draft قابلة للحذف" });
    return;
  }

  try {
    await db.transaction(async (tx) => {
      // Child rows are onDelete: cascade, but delete explicitly for clarity + transactional safety.
      await tx.delete(purchaseOrderItemsTable).where(eq(purchaseOrderItemsTable.poId, id));
      await tx.delete(workOrderAssignmentsTable).where(eq(workOrderAssignmentsTable.poId, id));
      await tx.delete(purchaseOrdersTable).where(eq(purchaseOrdersTable.id, id));

      await tx.insert(auditLogTable).values({
        action: "po.deleted",
        entityType: "po",
        entityId: id,
        employeeId: req.session.employeeId,
        description: `Deleted draft purchase order ${existing.internalPoNo}`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });
    });

    res.json({ ok: true, id });
  } catch (err) {
    req.log.error({ err, id }, "Failed to delete purchase order");
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Failed to delete purchase order", details: message });
  }
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

  // Load the latest receipt row per item so the portal can show the rejection
  // reason alongside the line status (the item row itself only carries totals).
  const itemIds = rows.map((r) => r.item.id);
  const receiptRows =
    itemIds.length > 0
      ? await db
          .select({
            poItemId: poItemReceiptsTable.poItemId,
            rejectionReason: poItemReceiptsTable.rejectionReason,
            receiptStatus: poItemReceiptsTable.receiptStatus,
            receivedAt: poItemReceiptsTable.receivedAt,
          })
          .from(poItemReceiptsTable)
          .where(inArray(poItemReceiptsTable.poItemId, itemIds))
          .orderBy(desc(poItemReceiptsTable.receivedAt))
      : [];
  // Most recent receipt per item (first after desc ordering).
  const latestReceipt = new Map<number, (typeof receiptRows)[number]>();
  for (const rc of receiptRows) {
    if (!latestReceipt.has(rc.poItemId)) latestReceipt.set(rc.poItemId, rc);
  }

  res.json(
    rows.map((r) => {
      const rc = latestReceipt.get(r.item.id);
      return {
        id: r.item.id,
        poId: r.item.poId,
        supplierId: r.item.supplierId,
        supplierName: r.supplierName,
        itemId: r.item.itemId,
        customerPoItemId: r.item.customerPoItemId ?? null,
        lineItem: r.item.lineItem,
        partNo: r.item.partNo,
        description: r.item.description,
        uom: r.item.uom,
        qty: r.item.qty ? parseFloat(r.item.qty) : null,
        referencePrice: r.item.referencePrice ? parseFloat(r.item.referencePrice) : null,
        taxIncluded: r.item.taxIncluded ?? false,
        totalReceivedQty: r.item.totalReceivedQty ? parseFloat(r.item.totalReceivedQty) : null,
        totalAcceptedQty: r.item.totalAcceptedQty ? parseFloat(r.item.totalAcceptedQty) : null,
        totalRejectedQty: r.item.totalRejectedQty ? parseFloat(r.item.totalRejectedQty) : null,
        finalActualCost: r.item.finalActualCost ? parseFloat(r.item.finalActualCost) : null,
        lineStatus: r.item.lineStatus,
        rejectionReason: rc?.rejectionReason ?? null,
      };
    }),
  );
});

export default router;
