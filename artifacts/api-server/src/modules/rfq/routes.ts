import { Router } from "express";
import {
  db,
  rfqTable,
  rfqItemsTable,
  sentLogTable,
  suppliersTable,
  employeesTable,
  offersTable,
  offerItemsTable,
  offerAttachmentsTable,
  auditLogTable,
} from "@workspace/db";
import { eq, and, ilike, or, count, inArray, sql } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { generateToken } from "../../shared/token";
import { generateOffersPdf } from "./offers-pdf.js";
import { generateDispatchReportPdf } from "../reports/dispatch-pdf.js";
import { sendRfqEmail } from "../../shared/email";
import { sendRfqWhatsApp } from "../communications/service";
import { whatsappChatsTable } from "@workspace/db";
import { lookupRfqFromSheet, listSheetRfqNumbers, listSheetTabs } from "../../shared/google-sheets";

const router = Router();

// Generate internal RFQ number: CRQ-YYYY-XXXXXX
async function generateInternalRfqNo(): Promise<string> {
  const year = new Date().getFullYear();
  const [result] = await db.select({ cnt: count() }).from(rfqTable);
  const seq = String((result?.cnt ?? 0) + 1).padStart(6, "0");
  return `CRQ-${year}-${seq}`;
}

// Auto-transition SENT RFQs with expired expiresAt and no offers → FAILED
async function autoFailExpiredRfqs(): Promise<void> {
  const now = new Date();
  // Find all SENT RFQs where expiresAt has passed
  const expiredSent = await db
    .select({ id: rfqTable.id, internalRfqNo: rfqTable.internalRfqNo })
    .from(rfqTable)
    .where(
      sql`${rfqTable.status} = 'SENT' AND ${rfqTable.expiresAt} IS NOT NULL AND ${rfqTable.expiresAt} < ${now.toISOString()}::timestamptz`,
    );

  if (expiredSent.length === 0) return;

  const expiredIds = expiredSent.map((r) => r.id);

  // Find which have at least one offer (those stay as-is or become QUOTED)
  const withOffers = await db
    .select({ rfqId: offersTable.rfqId })
    .from(offersTable)
    .where(inArray(offersTable.rfqId, expiredIds))
    .groupBy(offersTable.rfqId);

  const withOffersSet = new Set(withOffers.map((r) => r.rfqId));
  const toFail = expiredSent.filter((r) => !withOffersSet.has(r.id));

  if (toFail.length === 0) return;

  const toFailIds = toFail.map((r) => r.id);
  await db.update(rfqTable).set({ status: "FAILED" }).where(inArray(rfqTable.id, toFailIds));

  // Audit each auto-transition
  for (const rfq of toFail) {
    await db
      .insert(auditLogTable)
      .values({
        action: "rfq.auto_failed",
        entityType: "rfq",
        entityId: rfq.id,
        description: `RFQ ${rfq.internalRfqNo} auto-marked FAILED: closing date passed with no offers received`,
      })
      .catch(() => {
        /* non-fatal */
      });
  }
}

router.get("/rfq", requireAuth, async (req, res): Promise<void> => {
  const { status, employeeId, search } = req.query as Record<string, string>;

  // Auto-fail SENT RFQs whose closing date has passed with no offers received
  await autoFailExpiredRfqs().catch(() => {
    /* non-fatal */
  });

  const rows = await db
    .select({
      rfq: rfqTable,
      employeeName: employeesTable.name,
    })
    .from(rfqTable)
    .leftJoin(employeesTable, eq(rfqTable.employeeId, employeesTable.id))
    .orderBy(sql`${rfqTable.createdAt} DESC`);

  let filtered = rows;
  if (status) filtered = filtered.filter((r) => r.rfq.status === status);
  if (employeeId) filtered = filtered.filter((r) => r.rfq.employeeId === parseInt(employeeId, 10));
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        r.rfq.internalRfqNo.toLowerCase().includes(s) ||
        r.rfq.customerRfqNo.toLowerCase().includes(s),
    );
  }

  const rfqIds = filtered.map((r) => r.rfq.id);
  const itemCounts =
    rfqIds.length > 0
      ? await db
          .select({ rfqId: rfqItemsTable.rfqId, cnt: count() })
          .from(rfqItemsTable)
          .where(inArray(rfqItemsTable.rfqId, rfqIds))
          .groupBy(rfqItemsTable.rfqId)
      : [];
  const sentCounts =
    rfqIds.length > 0
      ? await db
          .select({ rfqId: sentLogTable.rfqId, cnt: count() })
          .from(sentLogTable)
          .where(inArray(sentLogTable.rfqId, rfqIds))
          .groupBy(sentLogTable.rfqId)
      : [];
  const offerCounts =
    rfqIds.length > 0
      ? await db
          .select({ rfqId: offersTable.rfqId, cnt: count() })
          .from(offersTable)
          .where(inArray(offersTable.rfqId, rfqIds))
          .groupBy(offersTable.rfqId)
      : [];

  const itemMap = Object.fromEntries(itemCounts.map((r) => [r.rfqId, r.cnt]));
  const sentMap = Object.fromEntries(sentCounts.map((r) => [r.rfqId, r.cnt]));
  const offerMap = Object.fromEntries(offerCounts.map((r) => [r.rfqId, r.cnt]));

  res.json(
    filtered.map((r) => ({
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
    })),
  );
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
  const [rfq] = await db
    .insert(rfqTable)
    .values({
      internalRfqNo,
      customerRfqNo,
      status: "DRAFT",
      employeeId: req.session.employeeId,
      notes,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    })
    .returning();

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
          referencePrice:
            it.referencePrice != null && it.referencePrice !== ""
              ? String(it.referencePrice)
              : null,
        })),
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
  const raw = Array.isArray(req.params.customerRfqNo)
    ? req.params.customerRfqNo[0]
    : req.params.customerRfqNo;
  const customerRfqNo = decodeURIComponent(raw);
  const { sheet } = req.query as Record<string, string>;

  // 1. Check DB first (already imported RFQ)
  const existingRfq = await db
    .select()
    .from(rfqTable)
    .where(eq(rfqTable.customerRfqNo, customerRfqNo));
  if (existingRfq.length > 0) {
    const items = await db
      .select()
      .from(rfqItemsTable)
      .where(eq(rfqItemsTable.rfqId, existingRfq[0].id));
    if (items.length > 0) {
      res.json(
        items.map((i) => ({
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
        })),
      );
      return;
    }
  }

  // 2. Lookup from Google Sheets
  try {
    const sheetItems = await lookupRfqFromSheet(customerRfqNo, sheet || "DATA");
    res.json(sheetItems);
  } catch (err) {
    req.log.error({ err, customerRfqNo }, "Google Sheets lookup failed");
    res
      .status(500)
      .json({ error: "Failed to fetch from Google Sheets", details: (err as Error).message });
  }
});

// GET /api/rfq/sheets/tabs — list all tab names in the spreadsheet
router.get("/rfq/sheets/tabs", requireAuth, async (req, res): Promise<void> => {
  try {
    const tabs = await listSheetTabs();
    res.json({ tabs });
  } catch (err) {
    req.log.error({ err }, "Failed to list sheet tabs");
    res
      .status(500)
      .json({ error: "Failed to connect to Google Sheets", details: (err as Error).message });
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
    res
      .status(500)
      .json({ error: "Failed to connect to Google Sheets", details: (err as Error).message });
  }
});

router.get("/rfq/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);

  const [row] = await db
    .select({ rfq: rfqTable, employeeName: employeesTable.name })
    .from(rfqTable)
    .leftJoin(employeesTable, eq(rfqTable.employeeId, employeesTable.id))
    .where(eq(rfqTable.id, id));

  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const [itemCount] = await db
    .select({ cnt: count() })
    .from(rfqItemsTable)
    .where(eq(rfqItemsTable.rfqId, id));
  const [sentCount] = await db
    .select({ cnt: count() })
    .from(sentLogTable)
    .where(eq(sentLogTable.rfqId, id));
  const [offerCount] = await db
    .select({ cnt: count() })
    .from(offersTable)
    .where(eq(offersTable.rfqId, id));

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

  // Only draft RFQs can be cancelled
  if (req.body.status === "FAILED" || req.body.status === "cancelled") {
    const [existing] = await db.select().from(rfqTable).where(eq(rfqTable.id, id));
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (existing.status === "SUCCESS" || existing.status === "completed") {
      res.status(400).json({ error: "لا يمكن تغيير حالة الطلب في هذه المرحلة" });
      return;
    }
  }

  const updates: Record<string, unknown> = {};
  if (req.body.status) updates.status = req.body.status;
  if (req.body.notes !== undefined) updates.notes = req.body.notes;

  const [rfq] = await db.update(rfqTable).set(updates).where(eq(rfqTable.id, id)).returning();
  if (!rfq) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  if (req.body.status === "FAILED" || req.body.status === "cancelled") {
    await db.insert(auditLogTable).values({
      action: "rfq.failed",
      entityType: "rfq",
      entityId: id,
      employeeId: req.session.employeeId,
      description: `Marked RFQ ${rfq.internalRfqNo} as FAILED`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });
  }

  res.json({
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
    itemCount: 0,
    supplierCount: 0,
    offerCount: 0,
    createdAt: rfq.createdAt.toISOString(),
    updatedAt: rfq.updatedAt.toISOString(),
  });
});

router.get("/rfq/:id/items", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const items = await db
    .select()
    .from(rfqItemsTable)
    .where(eq(rfqItemsTable.rfqId, id))
    .orderBy(rfqItemsTable.id);
  res.json(
    items.map((i) => ({
      id: i.id,
      rfqId: i.rfqId,
      itemId: i.itemId,
      lineItem: i.lineItem,
      partNo: i.partNo,
      description: i.description,
      uom: i.uom,
      qty: i.qty ? parseFloat(i.qty) : null,
      referencePrice: i.referencePrice ? parseFloat(i.referencePrice) : null,
    })),
  );
});

router.post("/rfq/:id/send", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rfqId = parseInt(raw, 10);
  const {
    supplierIds,
    closeDate,
    notes: sendNotes,
    force,
  } = req.body as {
    supplierIds: number[];
    closeDate?: string;
    notes?: string;
    force?: boolean;
  };

  if (!supplierIds?.length) {
    res.status(400).json({ error: "supplierIds required" });
    return;
  }

  const [rfq] = await db.select().from(rfqTable).where(eq(rfqTable.id, rfqId));
  if (!rfq) {
    res.status(404).json({ error: "RFQ not found" });
    return;
  }

  const items = await db.select().from(rfqItemsTable).where(eq(rfqItemsTable.rfqId, rfqId));
  const suppliers = await db
    .select()
    .from(suppliersTable)
    .where(inArray(suppliersTable.id, supplierIds));
  const [employee] = req.session.employeeId
    ? await db.select().from(employeesTable).where(eq(employeesTable.id, req.session.employeeId!))
    : [];

  const results: Array<{
    supplierId: number;
    supplierName: string;
    status: string;
    reason: string | null;
    email?: { status: string; error: string | null };
    whatsapp?: { status: string; error: string | null };
  }> = [];
  let sent = 0;
  let skipped = 0;

  const baseUrl =
    process.env.BASE_URL ??
    (process.env.REPLIT_DOMAINS
      ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}`
      : `http://localhost:${process.env.PORT}`);

  req.log.info(
    { rfqId, rfqNo: rfq.internalRfqNo, supplierCount: suppliers.length, force: !!force, baseUrl },
    "RFQ send: starting",
  );

  for (const supplier of suppliers) {
    // Duplicate check — bypassed when force=true (explicit resend)
    const [existing] = await db
      .select()
      .from(sentLogTable)
      .where(and(eq(sentLogTable.rfqId, rfqId), eq(sentLogTable.supplierId, supplier.id)));

    if (existing && !force) {
      skipped++;
      req.log.warn(
        { rfqId, supplierId: supplier.id, supplierName: supplier.name },
        "RFQ send: SKIPPED — already sent (pass force=true to resend)",
      );
      results.push({
        supplierId: supplier.id,
        supplierName: supplier.name,
        status: "skipped",
        reason: "Already sent",
      });
      continue;
    }

    let token: string;

    if (existing && force) {
      // Guard: if the supplier already submitted an offer referencing this sent-log row,
      // deleting it would violate the FK (offers.sent_log_id → sent_log.id). Skip instead.
      const [linkedOffer] = await db
        .select({ id: offersTable.id })
        .from(offersTable)
        .where(eq(offersTable.sentLogId, existing.id));

      if (linkedOffer) {
        skipped++;
        req.log.warn(
          { rfqId, supplierId: supplier.id, supplierName: supplier.name, offerId: linkedOffer.id },
          "RFQ send: force-resend SKIPPED — offer already submitted (FK protects sent-log row)",
        );
        results.push({
          supplierId: supplier.id,
          supplierName: supplier.name,
          status: "skipped",
          reason: "Offer already submitted",
        });
        continue;
      }

      // Atomically delete old row and insert new one with a fresh token
      token = generateToken();
      await db.transaction(async (tx) => {
        await tx
          .delete(sentLogTable)
          .where(and(eq(sentLogTable.rfqId, rfqId), eq(sentLogTable.supplierId, supplier.id)));
        await tx.insert(sentLogTable).values({
          rfqId,
          supplierId: supplier.id,
          employeeId: req.session.employeeId,
          token,
          closeDate,
        });
      });
      req.log.info(
        { rfqId, supplierId: supplier.id, supplierName: supplier.name },
        "RFQ send: force-resend — sent-log replaced atomically",
      );
    } else {
      // First-time send: insert fresh row
      token = generateToken();
      await db.insert(sentLogTable).values({
        rfqId,
        supplierId: supplier.id,
        employeeId: req.session.employeeId,
        token,
        closeDate,
      });
    }

    const pricingUrl = `${baseUrl}/q/${token}`;
    // Log only the last 6 chars of the token — never log full bearer token
    const tokenSuffix = token.slice(-6);

    req.log.info(
      {
        rfqId,
        supplierId: supplier.id,
        supplierName: supplier.name,
        hasEmail: !!supplier.email,
        hasPhone: !!supplier.phone,
        tokenSuffix,
      },
      "RFQ send: processing supplier",
    );

    const rfqItems = items.map((i) => ({
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
        req.log.info({ supplierId: supplier.id, email: supplier.email }, "RFQ send: email OK");
      } catch (err) {
        emailStatus = "failed";
        emailError = err instanceof Error ? err.message : String(err);
        req.log.error(
          { err, supplierId: supplier.id, email: supplier.email },
          "RFQ send: email FAILED",
        );
      }
    } else {
      req.log.warn(
        { supplierId: supplier.id, supplierName: supplier.name },
        "RFQ send: no email on supplier",
      );
    }

    // Send WhatsApp if supplier has phone
    let whatsappStatus: "sent" | "failed" | "no_phone" = "no_phone";
    let whatsappError: string | null = null;

    if (supplier.phone) {
      try {
        const { pdfSent, waMessageId: sentWaId } = await sendRfqWhatsApp({
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
        req.log.info(
          { supplierId: supplier.id, phone: supplier.phone, pdfSent },
          "RFQ send: WhatsApp OK",
        );

        let normalizedPhone = supplier.phone.replace(/[\s\-()]/g, "").replace(/^\+/, "");
        if (normalizedPhone.startsWith("00")) normalizedPhone = normalizedPhone.slice(2);
        if (normalizedPhone.length === 11 && normalizedPhone.startsWith("0"))
          normalizedPhone = "2" + normalizedPhone;
        if (normalizedPhone.length === 10 && normalizedPhone.startsWith("1"))
          normalizedPhone = "20" + normalizedPhone;

        try {
          if (pdfSent) {
            await db.insert(whatsappChatsTable).values({
              waMessageId: sentWaId,
              direction: "outbound",
              phone: normalizedPhone,
              supplierId: supplier.id,
              body: `[PDF] RFQ-${rfq.internalRfqNo}.pdf — طلب عرض سعر`,
              isRead: true,
            });
          }
          await db.insert(whatsappChatsTable).values({
            waMessageId: pdfSent ? null : sentWaId,
            direction: "outbound",
            phone: normalizedPhone,
            supplierId: supplier.id,
            body: `[RFQ ${rfq.internalRfqNo}] تم إرسال طلب عرض السعر — ${pricingUrl}`,
            isRead: true,
          });
        } catch (chatErr) {
          req.log.warn(
            { err: chatErr, supplierId: supplier.id },
            "RFQ send: chat log insert failed (non-fatal)",
          );
        }
      } catch (err) {
        whatsappStatus = "failed";
        whatsappError = err instanceof Error ? err.message : String(err);
        req.log.error(
          { err, supplierId: supplier.id, phone: supplier.phone },
          "RFQ send: WhatsApp FAILED",
        );
      }
    } else {
      req.log.warn(
        { supplierId: supplier.id, supplierName: supplier.name },
        "RFQ send: no phone on supplier",
      );
    }

    sent++;
    req.log.info(
      { supplierId: supplier.id, supplierName: supplier.name, emailStatus, whatsappStatus },
      "RFQ send: supplier done",
    );
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
  if (rfq.status === "DRAFT" && sent > 0) {
    await db.update(rfqTable).set({ status: "SENT" }).where(eq(rfqTable.id, rfqId));
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

  const rows = await db
    .select({
      log: sentLogTable,
      supplierName: suppliersTable.name,
      contactPerson: suppliersTable.contactPerson,
      email: suppliersTable.email,
      phone: suppliersTable.phone,
      employeeName: employeesTable.name,
      internalRfqNo: rfqTable.internalRfqNo,
    })
    .from(sentLogTable)
    .leftJoin(suppliersTable, eq(sentLogTable.supplierId, suppliersTable.id))
    .leftJoin(employeesTable, eq(sentLogTable.employeeId, employeesTable.id))
    .leftJoin(rfqTable, eq(sentLogTable.rfqId, rfqTable.id))
    .where(eq(sentLogTable.rfqId, id));

  res.json(
    rows.map((r) => ({
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
    })),
  );
});

router.get("/rfq/:id/offers", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rfqId = parseInt(raw, 10);

  const VAT_RATE = 0.14;

  const [rfqRow] = await db
    .select({ rfq: rfqTable, employeeName: employeesTable.name })
    .from(rfqTable)
    .leftJoin(employeesTable, eq(rfqTable.employeeId, employeesTable.id))
    .where(eq(rfqTable.id, rfqId));

  if (!rfqRow) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const offers = await db
    .select({ offer: offersTable, supplierName: suppliersTable.name })
    .from(offersTable)
    .leftJoin(suppliersTable, eq(offersTable.supplierId, suppliersTable.id))
    .where(eq(offersTable.rfqId, rfqId));

  const offerIds = offers.map((o) => o.offer.id);
  const offerItems =
    offerIds.length > 0
      ? await db
          .select({ item: offerItemsTable, rfqItem: rfqItemsTable })
          .from(offerItemsTable)
          .leftJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
          .where(inArray(offerItemsTable.offerId, offerIds))
      : [];

  const itemsByOffer: Record<number, typeof offerItems> = {};
  for (const oi of offerItems) {
    if (!itemsByOffer[oi.item.offerId]) itemsByOffer[oi.item.offerId] = [];
    itemsByOffer[oi.item.offerId].push(oi);
  }

  // Fetch offer attachments uploaded by suppliers via the pricing page
  // Wrapped in try/catch: if the table doesn't exist yet in production this
  // should not break the entire offers endpoint — just return no attachments.
  let offerAttachmentRows: { id: number; offerId: number; originalName: string; size: number }[] = [];
  try {
    if (offerIds.length > 0) {
      offerAttachmentRows = await db
        .select({
          id: offerAttachmentsTable.id,
          offerId: offerAttachmentsTable.offerId,
          originalName: offerAttachmentsTable.originalName,
          size: offerAttachmentsTable.size,
        })
        .from(offerAttachmentsTable)
        .where(inArray(offerAttachmentsTable.offerId, offerIds));
    }
  } catch (_e) {
    // table may not exist in older deployments — gracefully skip attachments
    offerAttachmentRows = [];
  }

  const _fmtAttSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const attachmentsByOffer = {};
  for (const a of offerAttachmentRows) {
    if (!attachmentsByOffer[a.offerId]) attachmentsByOffer[a.offerId] = [];
    attachmentsByOffer[a.offerId].push({
      id: a.id,
      originalName: a.originalName,
      sizeLabel: _fmtAttSize(a.size),
      downloadUrl: '/api/offer/attachments/' + a.id + '/download',
    });
  }

  // Price analysis per rfq item — all min/avg/max calculations use VAT-inclusive prices
  const rfqItems = await db.select().from(rfqItemsTable).where(eq(rfqItemsTable.rfqId, rfqId));
  const itemAnalysis = rfqItems.map((rfqItem) => {
    const vatPrices: number[] = [];
    const offerDetails: Array<{
      supplierId: number;
      supplierName: string;
      price: number;
      priceWithVat: number;
      taxIncluded: boolean;
      deliveryDays: number | null;
      notes: string | null;
      deviation: number;
      isLowest: boolean;
      isAnomaly: boolean;
      notPriced: boolean;
      attachments: Array<{ id: number; originalName: string; sizeLabel: string; downloadUrl: string }>;
    }> = [];

    for (const o of offers) {
      const ois = itemsByOffer[o.offer.id] || [];
      const oi = ois.find((x) => x.item.rfqItemId === rfqItem.id);
      if (oi) {
        const price = parseFloat(oi.item.price);
        // Normalize: if supplier did NOT include tax, add 14% VAT for fair comparison
        const priceWithVat = oi.item.taxIncluded ? price : price * (1 + VAT_RATE);
        const notPriced = price <= 0;
        if (!notPriced) vatPrices.push(priceWithVat);
        offerDetails.push({
          supplierId: o.offer.supplierId,
          supplierName: o.supplierName || "",
          price,
          priceWithVat,
          taxIncluded: oi.item.taxIncluded,
          deliveryDays: oi.item.deliveryDays,
          notes: oi.item.notes ?? null,
          deviation: 0,
          isLowest: false,
          isAnomaly: false,
          notPriced,
          attachments: attachmentsByOffer[o.offer.id] ?? [],
        });
      }
    }

    if (vatPrices.length > 0) {
      const minPrice = Math.min(...vatPrices);
      const maxPrice = Math.max(...vatPrices);
      const avgPrice = vatPrices.reduce((a, b) => a + b, 0) / vatPrices.length;
      const fairPrice = avgPrice;

      for (const od of offerDetails) {
        if (od.notPriced) continue;
        od.deviation = avgPrice > 0 ? ((od.priceWithVat - avgPrice) / avgPrice) * 100 : 0;
        od.isLowest = od.priceWithVat === minPrice;
        od.isAnomaly = Math.abs(od.deviation) > 50;
      }

      return {
        rfqItemId: rfqItem.id,
        description: rfqItem.description,
        partNo: rfqItem.partNo,
        qty: rfqItem.qty ? parseFloat(rfqItem.qty) : null,
        uom: rfqItem.uom,
        referencePrice: rfqItem.referencePrice ? parseFloat(rfqItem.referencePrice) : null,
        minPrice,
        maxPrice,
        avgPrice,
        fairPrice,
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
      minPrice: null,
      maxPrice: null,
      avgPrice: null,
      fairPrice: null,
      offers: [],
    };
  });

  const offersOut = offers.map((o) => ({
    id: o.offer.id,
    rfqId: o.offer.rfqId,
    supplierId: o.offer.supplierId,
    supplierName: o.supplierName,
    sentLogId: o.offer.sentLogId,
    employeeId: o.offer.employeeId,
    totalPrice: o.offer.totalPrice ? parseFloat(o.offer.totalPrice) : null,
    generalNotes: o.offer.generalNotes,
    createdAt: o.offer.createdAt.toISOString(),
    attachments: attachmentsByOffer[o.offer.id] ?? [],
    items: (itemsByOffer[o.offer.id] || []).map((oi) => ({
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
    id: rfqRow.rfq.id,
    internalRfqNo: rfqRow.rfq.internalRfqNo,
    customerRfqNo: rfqRow.rfq.customerRfqNo,
    customerRfqDate: rfqRow.rfq.customerRfqDate,
    requiredResponseDate: rfqRow.rfq.requiredResponseDate,
    status: rfqRow.rfq.status,
    employeeId: rfqRow.rfq.employeeId,
    employeeName: rfqRow.employeeName,
    notes: rfqRow.rfq.notes,
    expiresAt: rfqRow.rfq.expiresAt?.toISOString() ?? null,
    itemCount: rfqItems.length,
    supplierCount: offers.length,
    offerCount: offers.length,
    createdAt: rfqRow.rfq.createdAt.toISOString(),
    updatedAt: rfqRow.rfq.updatedAt.toISOString(),
  };

  res.json({ rfq, offers: offersOut, analysis: { rfqId, itemAnalysis } });
});

router.get("/rfq/:id/dispatch-report", requireAuth, async (req, res): Promise<void> => {
  const rfqId = parseInt(req.params.id as string, 10);
  if (isNaN(rfqId)) {
    res.status(400).json({ error: "Invalid RFQ ID" });
    return;
  }

  req.log.info({ rfqId }, "dispatch-report: start");

  try {
    // 1. Fetch the RFQ record
    const [rfqRow] = await db
      .select({ rfq: rfqTable })
      .from(rfqTable)
      .where(eq(rfqTable.id, rfqId));

    if (!rfqRow) {
      res.status(404).json({ error: "RFQ not found" });
      return;
    }

    // 2. Fetch sent-log joined with supplier details
    const rows = await db
      .select({
        log: sentLogTable,
        supplierName: suppliersTable.name,
        contactPerson: suppliersTable.contactPerson,
        phone: suppliersTable.phone,
        email: suppliersTable.email,
      })
      .from(sentLogTable)
      .leftJoin(suppliersTable, eq(sentLogTable.supplierId, suppliersTable.id))
      .where(eq(sentLogTable.rfqId, rfqId));

    req.log.info({ rfqId, rowCount: rows.length }, "dispatch-report: fetched sent-log");

    if (!rows.length) {
      res.status(404).json({ error: "لا يوجد سجل إرسال لهذا الطلب" });
      return;
    }

    // 3. Build supplier list for PDF
    const suppliers = rows.map((r) => ({
      supplierName: r.supplierName ?? "",
      contactPerson: r.contactPerson ?? null,
      phone: r.phone ?? null,
      email: r.email ?? null,
      linkOpened: r.log.linkOpened,
      openCount: r.log.openCount,
      offerSubmitted: r.log.offerSubmitted,
      createdAt: r.log.createdAt.toISOString(),
    }));

    // 4. Generate PDF buffer
    const pdfBuffer = await generateDispatchReportPdf({
      rfqNo: rfqRow.rfq.internalRfqNo,
      customerRfqNo: rfqRow.rfq.customerRfqNo ?? "",
      exportDate: new Date().toLocaleDateString("en-GB"),
      suppliers,
    });

    req.log.info({ rfqId, bytes: pdfBuffer.length }, "dispatch-report: sending pdf");

    // 5. Send the PDF
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Dispatch-Report-${rfqRow.rfq.internalRfqNo}.pdf"`,
      "Content-Length": String(pdfBuffer.length),
    });
    res.send(pdfBuffer);
  } catch (err) {
    req.log.error({ err }, "dispatch-report: failed");
    if (!res.headersSent) {
      res.status(500).json({
        error: "فشل إنشاء تقرير الإرسال",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
});

router.get("/rfq/:id/offers/pdf", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rfqId = parseInt(raw, 10);
  // Guarantee client gets a response within 22 s regardless of DB/PDF hang
  const routeTimer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({
        error: "Request timed out",
        detail: "PDF generation exceeded 22 s — DB or font issue",
      });
    }
  }, 22_000);
  try {
    const [rfqRow] = await db
      .select({ rfq: rfqTable, employeeName: employeesTable.name })
      .from(rfqTable)
      .leftJoin(employeesTable, eq(rfqTable.employeeId, employeesTable.id))
      .where(eq(rfqTable.id, rfqId));

    if (!rfqRow) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const rfqItems = await db.select().from(rfqItemsTable).where(eq(rfqItemsTable.rfqId, rfqId));
    const offers = await db
      .select({ offer: offersTable, supplierName: suppliersTable.name })
      .from(offersTable)
      .leftJoin(suppliersTable, eq(offersTable.supplierId, suppliersTable.id))
      .where(eq(offersTable.rfqId, rfqId));

    const offerIds = offers.map((o) => o.offer.id);
    const offerItems =
      offerIds.length > 0
        ? await db
            .select({ item: offerItemsTable, rfqItem: rfqItemsTable })
            .from(offerItemsTable)
            .leftJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
            .where(inArray(offerItemsTable.offerId, offerIds))
        : [];

    const itemsByOffer: Record<number, typeof offerItems> = {};
    for (const oi of offerItems) {
      if (!itemsByOffer[oi.item.offerId]) itemsByOffer[oi.item.offerId] = [];
      itemsByOffer[oi.item.offerId].push(oi);
    }

    const PDF_VAT_RATE = 0.14;
    const itemAnalysis = rfqItems.map((rfqItem) => {
      const vatPrices: number[] = [];
      const offerDetails: Array<{
        supplierName: string;
        price: number;
        priceWithVat: number;
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
          const priceWithVat = oi.item.taxIncluded ? price : price * (1 + PDF_VAT_RATE);
          const notPriced = price <= 0;
          if (!notPriced) vatPrices.push(priceWithVat);
          offerDetails.push({
            supplierName: o.supplierName || "",
            price,
            priceWithVat,
            taxIncluded: oi.item.taxIncluded,
            deliveryDays: oi.item.deliveryDays,
            notes: oi.item.notes ?? null,
            deviation: 0,
            isLowest: false,
            isAnomaly: false,
            notPriced,
          });
        }
      }

      if (vatPrices.length > 0) {
        const minPrice = Math.min(...vatPrices);
        const avgPrice = vatPrices.reduce((a, b) => a + b, 0) / vatPrices.length;
        const maxPrice = Math.max(...vatPrices);
        for (const od of offerDetails) {
          if (od.notPriced) continue;
          od.deviation = avgPrice > 0 ? ((od.priceWithVat - avgPrice) / avgPrice) * 100 : 0;
          od.isLowest = od.priceWithVat === minPrice;
          od.isAnomaly = Math.abs(od.deviation) > 50;
        }
        return {
          rfqItemId: rfqItem.id,
          description: rfqItem.description,
          partNo: rfqItem.partNo,
          qty: rfqItem.qty ? parseFloat(rfqItem.qty) : null,
          uom: rfqItem.uom,
          referencePrice: rfqItem.referencePrice ? parseFloat(rfqItem.referencePrice) : null,
          minPrice,
          maxPrice,
          avgPrice,
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
        minPrice: null,
        maxPrice: null,
        avgPrice: null,
        offers: [],
      };
    });

    const exportDate = new Date().toLocaleDateString("ar-EG", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    // Fetch the close date from the sent log (use the first non-null entry)
    const sentLogRows = await db
      .select({ closeDate: sentLogTable.closeDate })
      .from(sentLogTable)
      .where(eq(sentLogTable.rfqId, rfqId));
    const closeDate = sentLogRows.find((r) => r.closeDate)?.closeDate ?? null;

    // Fetch offer attachments for PDF (graceful fallback if table missing)
    let pdfAttRows: { offerId: number; originalName: string }[] = [];
    if (offerIds.length > 0) {
      try {
        pdfAttRows = await db
          .select({
            offerId: offerAttachmentsTable.offerId,
            originalName: offerAttachmentsTable.originalName,
          })
          .from(offerAttachmentsTable)
          .where(inArray(offerAttachmentsTable.offerId, offerIds));
      } catch {
        // table may not exist in older deployments
      }
    }
    const pdfAttByOffer: Record<number, string[]> = {};
    for (const a of pdfAttRows) {
      if (!pdfAttByOffer[a.offerId]) pdfAttByOffer[a.offerId] = [];
      pdfAttByOffer[a.offerId].push(a.originalName);
    }

    // Build per-supplier summary (general notes + attachments) for PDF
    const supplierSummaries = offers
      .map((o) => ({
        supplierName: o.supplierName || "",
        generalNotes: o.offer.generalNotes ?? null,
        attachments: (pdfAttByOffer[o.offer.id] ?? []).map((fileName) => ({ fileName })),
      }))
      .filter((s) => s.generalNotes || s.attachments.length > 0);

    const pdfBuffer = await generateOffersPdf({
      rfqNo: rfqRow.rfq.internalRfqNo,
      customerRfqNo: rfqRow.rfq.customerRfqNo,
      exportDate,
      employeeName: rfqRow.employeeName ?? null,
      closeDate,
      itemAnalysis,
      supplierSummaries,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="RFQ-Comparison-${rfqRow.rfq.internalRfqNo}.pdf"`,
    );
    res.send(pdfBuffer);
  } catch (err) {
    req.log.error({ err }, "Failed to generate offers PDF");
    if (!res.headersSent) {
      res.status(500).json({
        error: "PDF generation failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    clearTimeout(routeTimer);
  }
});

// GET /api/rfq/closing-soon — RFQs expiring tomorrow or the day after (active statuses only)
router.get("/rfq/closing-soon", requireAuth, async (req, res): Promise<void> => {
  const now = new Date();

  // Build day boundaries in UTC
  const startOfTomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  const endOfTomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 23, 59, 59, 999),
  );
  const startOfDayAfter = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2, 0, 0, 0, 0),
  );
  const endOfDayAfter = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2, 23, 59, 59, 999),
  );

  const rows = await db
    .select({
      rfq: rfqTable,
      employeeName: employeesTable.name,
    })
    .from(rfqTable)
    .leftJoin(employeesTable, eq(rfqTable.employeeId, employeesTable.id))
    .where(
      and(
        sql`${rfqTable.status} IN ('SENT', 'QUOTED')`,
        sql`${rfqTable.expiresAt} IS NOT NULL`,
        sql`${rfqTable.expiresAt} BETWEEN ${startOfTomorrow.toISOString()}::timestamptz AND ${endOfDayAfter.toISOString()}::timestamptz`,
      ),
    );

  if (rows.length === 0) {
    res.json({ tomorrow: [], dayAfterTomorrow: [] });
    return;
  }

  const rfqIds = rows.map((r) => r.rfq.id);
  const offerCounts = await db
    .select({ rfqId: offersTable.rfqId, cnt: count() })
    .from(offersTable)
    .where(inArray(offersTable.rfqId, rfqIds))
    .groupBy(offersTable.rfqId);
  const sentCounts = await db
    .select({ rfqId: sentLogTable.rfqId, cnt: count() })
    .from(sentLogTable)
    .where(inArray(sentLogTable.rfqId, rfqIds))
    .groupBy(sentLogTable.rfqId);

  const offerMap = Object.fromEntries(offerCounts.map((r) => [r.rfqId, r.cnt]));
  const sentMap = Object.fromEntries(sentCounts.map((r) => [r.rfqId, r.cnt]));

  const shaped = rows.map((r) => ({
    id: r.rfq.id,
    internalRfqNo: r.rfq.internalRfqNo,
    customerRfqNo: r.rfq.customerRfqNo,
    status: r.rfq.status,
    expiresAt: r.rfq.expiresAt!.toISOString(),
    employeeName: r.employeeName ?? null,
    supplierCount: sentMap[r.rfq.id] ?? 0,
    offerCount: offerMap[r.rfq.id] ?? 0,
  }));

  const tomorrow = shaped.filter((r) => new Date(r.expiresAt) <= endOfTomorrow);
  const dayAfterTomorrow = shaped.filter((r) => new Date(r.expiresAt) > endOfTomorrow);

  res.json({ tomorrow, dayAfterTomorrow });
});

export default router;
