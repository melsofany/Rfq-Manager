import { Router } from "express";
import { db, rfqTable, rfqItemsTable, sentLogTable, suppliersTable, employeesTable, offersTable, offerItemsTable, auditLogTable } from "@workspace/db";
import { eq, and, ilike, or, count, inArray, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { generateToken } from "../lib/token";
import { generateOffersPdf } from "../lib/offersPdf.js";
import { sendRfqEmail } from "../lib/email";
import { sendRfqWhatsApp } from "../lib/whatsapp";
import { whatsappChatsTable } from "@workspace/db";
import { lookupRfqFromSheet, listSheetRfqNumbers, listSheetTabs } from "../lib/googleSheets";

const router = Router();

// Generate internal RFQ number: CRQ-YYYY-XXXXXX
async function generateInternalRfqNo(): Promise<string> {
  const year = new Date().getFullYear();
  const [result] = await db.select({ cnt: count() }).from(rfqTable);
  const seq = String((result?.cnt ?? 0) + 1).padStart(6, "0");
  return `CRQ-${year}-${seq}`;
}

router.get("/rfq", requireAuth, async (req, res): Promise<void> => {
  const { status, employeeId, search } = req.query as Record<string, string>;

  const rows = await db.select({
    rfq: rfqTable,
    employeeName: employeesTable.name,
  }).from(rfqTable)
    .leftJoin(employeesTable, eq(rfqTable.employeeId, employeesTable.id))
    .orderBy(sql`${rfqTable.createdAt} DESC`);

  let filtered = rows;
  if (status) filtered = filtered.filter(r => r.rfq.status === status);
  if (employeeId) filtered = filtered.filter(r => r.rfq.employeeId === parseInt(employeeId, 10));
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(r =>
      r.rfq.internalRfqNo.toLowerCase().includes(s) ||
      r.rfq.customerRfqNo.toLowerCase().includes(s)
    );
  }

  const rfqIds = filtered.map(r => r.rfq.id);
  const itemCounts = rfqIds.length > 0 ? await db.select({ rfqId: rfqItemsTable.rfqId, cnt: count() })
    .from(rfqItemsTable).where(inArray(rfqItemsTable.rfqId, rfqIds)).groupBy(rfqItemsTable.rfqId) : [];
  const sentCounts = rfqIds.length > 0 ? await db.select({ rfqId: sentLogTable.rfqId, cnt: count() })
    .from(sentLogTable).where(inArray(sentLogTable.rfqId, rfqIds)).groupBy(sentLogTable.rfqId) : [];
  const offerCounts = rfqIds.length > 0 ? await db.select({ rfqId: offersTable.rfqId, cnt: count() })
    .from(offersTable).where(inArray(offersTable.rfqId, rfqIds)).groupBy(offersTable.rfqId) : [];

  const itemMap = Object.fromEntries(itemCounts.map(r => [r.rfqId, r.cnt]));
  const sentMap = Object.fromEntries(sentCounts.map(r => [r.rfqId, r.cnt]));
  const offerMap = Object.fromEntries(offerCounts.map(r => [r.rfqId, r.cnt]));

  res.json(filtered.map(r => ({
    id: r.rfq.id,
    internalRfqNo: r.rfq.internalRfqNo,
    customerRfqNo: r.rfq.customerRfqNo,
    customerRfqDate: r.rfq.customerRfqDate,
    requiredResponseDate: r.rfq.requiredResponseDate,
    status: r.rfq.status,
    employeeId: r.rfq.employeeId,
    employeeName: r.employeeName,
    notes: r.rfq.notes,
    expiresAt: r.rfq.expiresAt?.toISOString() ?? null,
    itemCount: itemMap[r.rfq.id] ?? 0,
    supplierCount: sentMap[r.rfq.id] ?? 0,
    offerCount: offerMap[r.rfq.id] ?? 0,
    createdAt: r.rfq.createdAt.toISOString(),
    updatedAt: r.rfq.updatedAt.toISOString(),
  })));
});

router.post("/rfq", requireAuth, async (req, res): Promise<void> => {
  const { customerRfqNo, notes, items, expiresAt } = req.body as {
    customerRfqNo?: string;
    notes?: string;
    expiresAt?: string | null;
    items?: Array<{
      lineItem?: string;
      partNo?: string;
      description: string;
      uom?: string;
      qty?: string | number | null;
      referencePrice?: string | number | null;
    }>;
  };

  if (!customerRfqNo) {
    res.status(400).json({ error: "customerRfqNo required" });
    return;
  }

  const internalRfqNo = await generateInternalRfqNo();
  const [rfq] = await db.insert(rfqTable).values({
    internalRfqNo,
    customerRfqNo,
    status: "draft",
    employeeId: req.session.employeeId,
    notes,
    expiresAt: expiresAt ? new Date(expiresAt) : undefined,
  }).returning();

  let itemCount = 0;
  if (items && items.length > 0) {
    const validItems = items.filter((it) => it.description?.trim());
    if (validItems.length > 0) {
      await db.insert(rfqItemsTable).values(
        validItems.map((it) => ({
          rfqId: rfq.id,
          lineItem: it.lineItem || null,
          partNo: it.partNo || null,
          description: it.description.trim(),
          uom: it.uom || null,
          qty: it.qty != null && it.qty !== "" ? String(it.qty) : null,
          referencePrice: it.referencePrice != null && it.referencePrice !== "" ? String(it.referencePrice) : null,
        }))
      );
      itemCount = validItems.length;
    }
  }

  await db.insert(auditLogTable).values({
    action: "rfq.created",
    entityType: "rfq",
    entityId: rfq.id,
    employeeId: req.session.employeeId,
    description: `Created RFQ ${internalRfqNo} for customer RFQ ${customerRfqNo} with ${itemCount} item(s)`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.status(201).json({
    id: rfq.id,
    internalRfqNo: rfq.internalRfqNo,
    customerRfqNo: rfq.customerRfqNo,
    customerRfqDate: rfq.customerRfqDate,
    requiredResponseDate: rfq.requiredResponseDate,
    status: rfq.status,
    employeeId: rfq.employeeId,
    employeeName: null,
    notes: rfq.notes,
    expiresAt: rfq.expiresAt?.toISOString() ?? null,
    itemCount,
    supplierCount: 0,
    offerCount: 0,
    createdAt: rfq.createdAt.toISOString(),
    updatedAt: rfq.updatedAt.toISOString(),
  });
});

router.get("/rfq/lookup/:customerRfqNo", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.customerRfqNo) ? req.params.customerRfqNo[0] : req.params.customerRfqNo;
  const customerRfqNo = decodeURIComponent(raw);
  const { sheet } = req.query as Record<string, string>;

  // 1. Check DB first (already imported RFQ)
  const existingRfq = await db.select().from(rfqTable).where(eq(rfqTable.customerRfqNo, customerRfqNo));
  if (existingRfq.length > 0) {
    const items = await db.select().from(rfqItemsTable).where(eq(rfqItemsTable.rfqId, existingRfq[0].id));
    if (items.length > 0) {
      res.json(items.map(i => ({
        itemId: i.itemId,
        lineItem: i.lineItem,
        partNo: i.partNo,
        description: i.description,
        uom: i.uom,
        qty: i.qty ? parseFloat(i.qty) : null,
        referencePrice: i.referencePrice ? parseFloat(i.referencePrice) : null,
        rfqNo: customerRfqNo,
        rfqDate: existingRfq[0].customerRfqDate || "",
        requiredResponseDate: existingRfq[0].requiredResponseDate || "",
      })));
      return;
    }
  }

  // 2. Lookup from Google Sheets
  try {
    const sheetItems = await lookupRfqFromSheet(customerRfqNo, sheet || "DATA");
    res.json(sheetItems);
  } catch (err) {
    req.log.error({ err, customerRfqNo }, "Google Sheets lookup failed");
    res.status(500).json({ error: "Failed to fetch from Google Sheets", details: (err as Error).message });
  }
});

// GET /api/rfq/sheets/tabs — list all tab names in the spreadsheet
router.get("/rfq/sheets/tabs", requireAuth, async (req, res): Promise<void> => {
  try {
    const tabs = await listSheetTabs();
    res.json({ tabs });
  } catch (err) {
    req.log.error({ err }, "Failed to list sheet tabs");
    res.status(500).json({ error: "Failed to connect to Google Sheets", details: (err as Error).message });
  }
});

// GET /api/rfq/sheets/rfq-numbers?sheet=Sheet1 — list unique RFQ numbers in the sheet
router.get("/rfq/sheets/rfq-numbers", requireAuth, async (req, res): Promise<void> => {
  const { sheet } = req.query as Record<string, string>;
  try {
    const numbers = await listSheetRfqNumbers(sheet || "DATA");
    res.json({ rfqNumbers: numbers });
  } catch (err) {
    req.log.error({ err }, "Failed to list RFQ numbers from sheet");
    res.status(500).json({ error: "Failed to connect to Google Sheets", details: (err as Error).message });
  }
});

router.get("/rfq/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const [row] = await db.select({ rfq: rfqTable, employeeName: employeesTable.name })
    .from(rfqTable)
    .leftJoin(employeesTable, eq(rfqTable.employeeId, employeesTable.id))
    .where(eq(rfqTable.id, id));

  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  const [itemCount] = await db.select({ cnt: count() }).from(rfqItemsTable).where(eq(rfqItemsTable.rfqId, id));
  const [sentCount] = await db.select({ cnt: count() }).from(sentLogTable).where(eq(sentLogTable.rfqId, id));
  const [offerCount] = await db.select({ cnt: count() }).from(offersTable).where(eq(offersTable.rfqId, id));

  res.json({
    id: row.rfq.id,
    internalRfqNo: row.rfq.internalRfqNo,
    customerRfqNo: row.rfq.customerRfqNo,
    customerRfqDate: row.rfq.customerRfqDate,
    requiredResponseDate: row.rfq.requiredResponseDate,
    status: row.rfq.status,
    employeeId: row.rfq.employeeId,
    employeeName: row.employeeName,
    notes: row.rfq.notes,
    expiresAt: row.rfq.expiresAt?.toISOString() ?? null,
    itemCount: itemCount?.cnt ?? 0,
    supplierCount: sentCount?.cnt ?? 0,
    offerCount: offerCount?.cnt ?? 0,
    createdAt: row.rfq.createdAt.toISOString(),
    updatedAt: row.rfq.updatedAt.toISOString(),
  });
});

router.patch("/rfq/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const updates: Record<string, unknown> = {};
  if (req.body.status) updates.status = req.body.status;
  if (req.body.notes !== undefined) updates.notes = req.body.notes;

  const [rfq] = await db.update(rfqTable).set(updates).where(eq(rfqTable.id, id)).returning();
  if (!rfq) { res.status(404).json({ error: "Not found" }); return; }

  res.json({
    id: rfq.id, internalRfqNo: rfq.internalRfqNo, customerRfqNo: rfq.customerRfqNo,
    customerRfqDate: rfq.customerRfqDate, requiredResponseDate: rfq.requiredResponseDate,
    status: rfq.status, employeeId: rfq.employeeId, employeeName: null, notes: rfq.notes,
    expiresAt: rfq.expiresAt?.toISOString() ?? null,
    itemCount: 0, supplierCount: 0, offerCount: 0,
    createdAt: rfq.createdAt.toISOString(), updatedAt: rfq.updatedAt.toISOString(),
  });
});

router.get("/rfq/:id/items", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const items = await db.select().from(rfqItemsTable).where(eq(rfqItemsTable.rfqId, id)).orderBy(rfqItemsTable.id);
  res.json(items.map(i => ({
    id: i.id, rfqId: i.rfqId, itemId: i.itemId, lineItem: i.lineItem,
    partNo: i.partNo, description: i.description, uom: i.uom,
    qty: i.qty ? parseFloat(i.qty) : null,
    referencePrice: i.referencePrice ? parseFloat(i.referencePrice) : null,
  })));
});

router.post("/rfq/:id/send", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rfqId = parseInt(raw, 10);
  const { supplierIds, closeDate, notes: sendNotes } = req.body as {
    supplierIds: number[];
    closeDate?: string;
    notes?: string;
  };

  if (!supplierIds?.length) {
    res.status(400).json({ error: "supplierIds required" });
    return;
  }

  const [rfq] = await db.select().from(rfqTable).where(eq(rfqTable.id, rfqId));
  if (!rfq) { res.status(404).json({ error: "RFQ not found" }); return; }

  const items = await db.select().from(rfqItemsTable).where(eq(rfqItemsTable.rfqId, rfqId));
  const suppliers = await db.select().from(suppliersTable).where(inArray(suppliersTable.id, supplierIds));
  const [employee] = req.session.employeeId
    ? await db.select().from(employeesTable).where(eq(employeesTable.id, req.session.employeeId!))
    : [];

  const results: Array<{ supplierId: number; supplierName: string; status: string; reason: string | null }> = [];
  let sent = 0;
  let skipped = 0;

  const baseUrl =
    process.env.BASE_URL ??
    (process.env.REPLIT_DOMAINS
      ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}`
      : `http://localhost:${process.env.PORT}`);

  for (const supplier of suppliers) {
    // Duplicate check
    const [existing] = await db.select().from(sentLogTable)
      .where(and(eq(sentLogTable.rfqId, rfqId), eq(sentLogTable.supplierId, supplier.id)));

    if (existing) {
      skipped++;
      results.push({ supplierId: supplier.id, supplierName: supplier.name, status: "skipped", reason: "Already sent" });
      continue;
    }

    const token = generateToken();
    await db.insert(sentLogTable).values({
      rfqId,
      supplierId: supplier.id,
      employeeId: req.session.employeeId,
      token,
      closeDate,
    });

    const pricingUrl = `${baseUrl}/q/${token}`;

    const rfqItems = items.map(i => ({
      lineItem: i.lineItem,
      partNo: i.partNo,
      description: i.description,
      qty: i.qty,
      uom: i.uom,
    }));

    // Send email if supplier has email
    let emailStatus: "sent" | "failed" | "no_email" = "no_email";
    let emailError: string | null = null;

    if (supplier.email) {
      try {
        await sendRfqEmail({
          to: supplier.email,
          toName: supplier.contactPerson || supplier.name,
          rfqNo: rfq.internalRfqNo,
          items: rfqItems,
          pricingUrl,
          closeDate: closeDate || "To be confirmed",
          employeeName: employee?.name || "Procurement Team",
          employeePhone: employee?.phone,
        });
        emailStatus = "sent";
      } catch (err) {
        emailStatus = "failed";
        emailError = err instanceof Error ? err.message : String(err);
        req.log.error({ err, supplierId: supplier.id, email: supplier.email }, "Failed to send RFQ email");
      }
    }

    // Send WhatsApp if supplier has phone
    let whatsappStatus: "sent" | "failed" | "no_phone" = "no_phone";
    let whatsappError: string | null = null;

    if (supplier.phone) {
      try {
        const { pdfSent } = await sendRfqWhatsApp({
          phone: supplier.phone,
          toName: supplier.contactPerson || supplier.name,
          rfqNo: rfq.internalRfqNo,
          customerRfqNo: rfq.customerRfqNo,
          rfqDate: rfq.customerRfqDate ?? null,
          items: rfqItems,
          pricingUrl,
          closeDate: closeDate || "To be confirmed",
          employeeName: employee?.name || "Procurement Team",
          employeePhone: employee?.phone,
          notes: rfq.notes ?? null,
        });
        whatsappStatus = "sent";
        // Save outbound messages to chat log
        const normalizedPhone = supplier.phone.replace(/[\s\-()]/g, "").replace(/^\+/, "");
        if (pdfSent) {
          await db.insert(whatsappChatsTable).values({
            direction: "outbound",
            phone: normalizedPhone,
            supplierId: supplier.id,
            body: `[PDF] RFQ-${rfq.internalRfqNo}.pdf — طلب عرض سعر`,
            isRead: true,
          });
        }
        await db.insert(whatsappChatsTable).values({
          direction: "outbound",
          phone: normalizedPhone,
          supplierId: supplier.id,
          body: `[RFQ ${rfq.internalRfqNo}] تم إرسال طلب عرض السعر — ${pricingUrl}`,
          isRead: true,
        });
      } catch (err) {
        whatsappStatus = "failed";
        whatsappError = err instanceof Error ? err.message : String(err);
        req.log.error({ err, supplierId: supplier.id, phone: supplier.phone }, "Failed to send WhatsApp");
      }
    }

    sent++;
    results.push({
      supplierId: supplier.id,
      supplierName: supplier.name,
      status: "sent",
      reason: null,
      email: { status: emailStatus, error: emailError },
      whatsapp: { status: whatsappStatus, error: whatsappError },
    });
  }

  // Update RFQ status to sent if it was draft
  if (rfq.status === "draft" && sent > 0) {
    await db.update(rfqTable).set({ status: "sent" }).where(eq(rfqTable.id, rfqId));
  }

  await db.insert(auditLogTable).values({
    action: "rfq.sent",
    entityType: "rfq",
    entityId: rfqId,
    employeeId: req.session.employeeId,
    description: `RFQ ${rfq.internalRfqNo} sent to ${sent} suppliers, ${skipped} skipped`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.json({ sent, skipped, details: results });
});

router.get("/rfq/:id/sent-log", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const rows = await db.select({
    log: sentLogTable,
    supplierName: suppliersTable.name,
    contactPerson: suppliersTable.contactPerson,
    email: suppliersTable.email,
    phone: suppliersTable.phone,
    employeeName: employeesTable.name,
    internalRfqNo: rfqTable.internalRfqNo,
  }).from(sentLogTable)
    .leftJoin(suppliersTable, eq(sentLogTable.supplierId, suppliersTable.id))
    .leftJoin(employeesTable, eq(sentLogTable.employeeId, employeesTable.id))
    .leftJoin(rfqTable, eq(sentLogTable.rfqId, rfqTable.id))
    .where(eq(sentLogTable.rfqId, id));

  res.json(rows.map(r => ({
    id: r.log.id,
    rfqId: r.log.rfqId,
    internalRfqNo: r.internalRfqNo || "",
    supplierId: r.log.supplierId,
    supplierName: r.supplierName || "",
    contactPerson: r.contactPerson,
    email: r.email,
    phone: r.phone,
    employeeId: r.log.employeeId,
    employeeName: r.employeeName,
    token: r.log.token,
    closeDate: r.log.closeDate,
    linkOpened: r.log.linkOpened,
    openCount: r.log.openCount,
    firstOpenedAt: r.log.firstOpenedAt?.toISOString() ?? null,
    lastOpenedAt: r.log.lastOpenedAt?.toISOString() ?? null,
    offerSubmitted: r.log.offerSubmitted,
    createdAt: r.log.createdAt.toISOString(),
  })));
});

router.get("/rfq/:id/offers", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rfqId = parseInt(raw, 10);

  const [rfqRow] = await db.select({ rfq: rfqTable, employeeName: employeesTable.name })
    .from(rfqTable).leftJoin(employeesTable, eq(rfqTable.employeeId, employeesTable.id))
    .where(eq(rfqTable.id, rfqId));

  if (!rfqRow) { res.status(404).json({ error: "Not found" }); return; }

  const offers = await db.select({ offer: offersTable, supplierName: suppliersTable.name })
    .from(offersTable)
    .leftJoin(suppliersTable, eq(offersTable.supplierId, suppliersTable.id))
    .where(eq(offersTable.rfqId, rfqId));

  const offerIds = offers.map(o => o.offer.id);
  const offerItems = offerIds.length > 0
    ? await db.select({ item: offerItemsTable, rfqItem: rfqItemsTable })
        .from(offerItemsTable)
        .leftJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
        .where(inArray(offerItemsTable.offerId, offerIds))
    : [];

  const itemsByOffer: Record<number, typeof offerItems> = {};
  for (const oi of offerItems) {
    if (!itemsByOffer[oi.item.offerId]) itemsByOffer[oi.item.offerId] = [];
    itemsByOffer[oi.item.offerId].push(oi);
  }

  // Price analysis per rfq item
  const rfqItems = await db.select().from(rfqItemsTable).where(eq(rfqItemsTable.rfqId, rfqId));
  const itemAnalysis = rfqItems.map(rfqItem => {
    const prices: number[] = [];
    const offerDetails: Array<{
      supplierId: number; supplierName: string; price: number;
      taxIncluded: boolean; deliveryDays: number | null; deviation: number; isLowest: boolean; isAnomaly: boolean;
    }> = [];

    for (const o of offers) {
      const ois = itemsByOffer[o.offer.id] || [];
      const oi = ois.find(x => x.item.rfqItemId === rfqItem.id);
      if (oi) {
        const price = parseFloat(oi.item.price);
        prices.push(price);
        offerDetails.push({
          supplierId: o.offer.supplierId,
          supplierName: o.supplierName || "",
          price,
          taxIncluded: oi.item.taxIncluded,
          deliveryDays: oi.item.deliveryDays,
          deviation: 0,
          isLowest: false,
          isAnomaly: false,
        });
      }
    }

    if (prices.length > 0) {
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
      const fairPrice = avgPrice;

      for (const od of offerDetails) {
        od.deviation = avgPrice > 0 ? ((od.price - avgPrice) / avgPrice) * 100 : 0;
        od.isLowest = od.price === minPrice;
        od.isAnomaly = Math.abs(od.deviation) > 50;
      }

      return {
        rfqItemId: rfqItem.id,
        description: rfqItem.description,
        partNo: rfqItem.partNo,
        qty: rfqItem.qty ? parseFloat(rfqItem.qty) : null,
        uom: rfqItem.uom,
        referencePrice: rfqItem.referencePrice ? parseFloat(rfqItem.referencePrice) : null,
        minPrice, maxPrice, avgPrice, fairPrice, offers: offerDetails,
      };
    }

    return {
      rfqItemId: rfqItem.id,
      description: rfqItem.description,
      partNo: rfqItem.partNo,
      qty: rfqItem.qty ? parseFloat(rfqItem.qty) : null,
      uom: rfqItem.uom,
      referencePrice: rfqItem.referencePrice ? parseFloat(rfqItem.referencePrice) : null,
      minPrice: null, maxPrice: null, avgPrice: null, fairPrice: null, offers: [],
    };
  });

  const offersOut = offers.map(o => ({
    id: o.offer.id,
    rfqId: o.offer.rfqId,
    supplierId: o.offer.supplierId,
    supplierName: o.supplierName,
    sentLogId: o.offer.sentLogId,
    employeeId: o.offer.employeeId,
    totalPrice: o.offer.totalPrice ? parseFloat(o.offer.totalPrice) : null,
    generalNotes: o.offer.generalNotes,
    createdAt: o.offer.createdAt.toISOString(),
    items: (itemsByOffer[o.offer.id] || []).map(oi => ({
      id: oi.item.id,
      offerId: oi.item.offerId,
      rfqItemId: oi.item.rfqItemId,
      partNo: oi.rfqItem?.partNo ?? null,
      description: oi.rfqItem?.description ?? null,
      qty: oi.rfqItem?.qty ? parseFloat(oi.rfqItem.qty) : null,
      uom: oi.rfqItem?.uom ?? null,
      price: parseFloat(oi.item.price),
      taxIncluded: oi.item.taxIncluded,
      deliveryDays: oi.item.deliveryDays,
      notes: oi.item.notes,
    })),
  }));

  const rfq = {
    id: rfqRow.rfq.id, internalRfqNo: rfqRow.rfq.internalRfqNo, customerRfqNo: rfqRow.rfq.customerRfqNo,
    customerRfqDate: rfqRow.rfq.customerRfqDate, requiredResponseDate: rfqRow.rfq.requiredResponseDate,
    status: rfqRow.rfq.status, employeeId: rfqRow.rfq.employeeId, employeeName: rfqRow.employeeName,
    notes: rfqRow.rfq.notes, expiresAt: rfqRow.rfq.expiresAt?.toISOString() ?? null,
    itemCount: rfqItems.length, supplierCount: offers.length,
    offerCount: offers.length, createdAt: rfqRow.rfq.createdAt.toISOString(), updatedAt: rfqRow.rfq.updatedAt.toISOString(),
  };

  res.json({ rfq, offers: offersOut, analysis: { rfqId, itemAnalysis } });
});


  router.get("/rfq/:id/offers/pdf", requireAuth, async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const rfqId = parseInt(raw, 10);

    const [rfqRow] = await db.select({ rfq: rfqTable, employeeName: employeesTable.name })
      .from(rfqTable).leftJoin(employeesTable, eq(rfqTable.employeeId, employeesTable.id))
      .where(eq(rfqTable.id, rfqId));

    if (!rfqRow) { res.status(404).json({ error: "Not found" }); return; }

    const rfqItems = await db.select().from(rfqItemsTable).where(eq(rfqItemsTable.rfqId, rfqId));
    const offers = await db.select({ offer: offersTable, supplierName: suppliersTable.name })
      .from(offersTable)
      .leftJoin(suppliersTable, eq(offersTable.supplierId, suppliersTable.id))
      .where(eq(offersTable.rfqId, rfqId));

    const offerIds = offers.map((o) => o.offer.id);
    const offerItems = offerIds.length > 0
      ? await db.select({ item: offerItemsTable, rfqItem: rfqItemsTable })
          .from(offerItemsTable)
          .leftJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
          .where(inArray(offerItemsTable.offerId, offerIds))
      : [];

    const itemsByOffer: Record<number, typeof offerItems> = {};
    for (const oi of offerItems) {
      if (!itemsByOffer[oi.item.offerId]) itemsByOffer[oi.item.offerId] = [];
      itemsByOffer[oi.item.offerId].push(oi);
    }

    const itemAnalysis = rfqItems.map((rfqItem) => {
      const prices: number[] = [];
      const offerDetails: Array<{
        supplierName: string;
        price: number;
        taxIncluded: boolean;
        deliveryDays: number | null;
        deviation: number;
        isLowest: boolean;
        isAnomaly: boolean;
      }> = [];

      for (const o of offers) {
        const ois = itemsByOffer[o.offer.id] || [];
        const oi = ois.find((x) => x.item.rfqItemId === rfqItem.id);
        if (oi) {
          const price = parseFloat(oi.item.price);
          prices.push(price);
          offerDetails.push({
            supplierName: o.supplierName || "",
            price,
            taxIncluded: oi.item.taxIncluded,
            deliveryDays: oi.item.deliveryDays,
            deviation: 0,
            isLowest: false,
            isAnomaly: false,
          });
        }
      }

      if (prices.length > 0) {
        const minPrice = Math.min(...prices);
        const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
        const maxPrice = Math.max(...prices);
        for (const od of offerDetails) {
          od.deviation = avgPrice > 0 ? ((od.price - avgPrice) / avgPrice) * 100 : 0;
          od.isLowest = od.price === minPrice;
          od.isAnomaly = Math.abs(od.deviation) > 50;
        }
        return {
          rfqItemId: rfqItem.id,
          description: rfqItem.description,
          partNo: rfqItem.partNo,
          qty: rfqItem.qty ? parseFloat(rfqItem.qty) : null,
          uom: rfqItem.uom,
          referencePrice: rfqItem.referencePrice ? parseFloat(rfqItem.referencePrice) : null,
          minPrice, maxPrice, avgPrice,
          offers: offerDetails,
        };
      }

      return {
        rfqItemId: rfqItem.id,
        description: rfqItem.description,
        partNo: rfqItem.partNo,
        qty: rfqItem.qty ? parseFloat(rfqItem.qty) : null,
        uom: rfqItem.uom,
        referencePrice: rfqItem.referencePrice ? parseFloat(rfqItem.referencePrice) : null,
        minPrice: null, maxPrice: null, avgPrice: null,
        offers: [],
      };
    });

    const exportDate = new Date().toLocaleDateString("en-GB");

    try {
      const pdfBuffer = await generateOffersPdf({
        rfqNo: rfqRow.rfq.internalRfqNo,
        customerRfqNo: rfqRow.rfq.customerRfqNo,
        exportDate,
        itemAnalysis,
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="RFQ-Comparison-${rfqRow.rfq.internalRfqNo}.pdf"`
      );
      res.send(pdfBuffer);
    } catch (err) {
      req.log.error({ err }, "Failed to generate offers PDF");
      res.status(500).json({ error: "PDF generation failed" });
    }
  });

  export default router;
