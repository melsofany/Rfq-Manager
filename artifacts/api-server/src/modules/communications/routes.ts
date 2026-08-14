import { Router, type Request, type Response } from "express";
import {
  db,
  suppliersTable,
  whatsappChatsTable,
  whatsappReactionsTable,
  whatsappMediaTable,
  workOrderAssignmentsTable,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
  poItemReceiptsTable,
  customerPosTable,
  customerPoItemsTable,
  customerPoItemDeliveriesTable,
  representativesTable,
  WORK_ORDER_KIND,
} from "@workspace/db";
import { eq, desc, sql, and, inArray, ne, isNotNull } from "drizzle-orm";
import {
  Whatsapp,
  PHONE_NUMBER_ID,
  WEBHOOK_VERIFY_TOKEN,
  isWhatsAppConfigured,
  sendWhatsAppText,
  sendWhatsAppInteractiveConfirmation,
  sendRepresentativeItemReceiptWhatsApp,
  sendRejectionReasonOptions,
  uploadWhatsAppMedia,
  sendRepMainMenu,
  sendRepPoPicker,
  sendRepItemPicker,
  sendRepItemAction,
  sendRepConfirm,
  sendDeliveryRejectionReasonOptions,
  CUSTOMER_REJECTION_REASONS,
  formatQty as formatWaQty,
} from "./service";
import { requireAuth } from "../../middlewares/auth";
import { logger } from "../../shared/logger";
import { REJECTION_REASONS } from "../po/receipts";
import multer from "multer";
const _upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const router = Router();

const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const WA_PHONE_ID = PHONE_NUMBER_ID;
const WA_API_VERSION = "v22.0";

function normalizePhone(phone: string): string {
  let cleaned = phone.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);
  if (cleaned.length === 11 && cleaned.startsWith("0")) cleaned = "2" + cleaned;
  if (cleaned.length === 10 && cleaned.startsWith("1")) cleaned = "20" + cleaned;
  return cleaned;
}

/**
 * Canonical phone form: digits only, country code prefixed, no "+", no leading
 * "00", Egyptian local numbers expanded to international. Used to match a
 * representative across whatever format their phone was stored in (the
 * representatives API historically kept the "+", while Meta webhooks send a
 * bare "20…"). Two phones match iff their canonical forms are equal.
 */
function canonicalPhone(phone: string): string {
  // eslint-disable-next-line no-control-regex
  let cleaned = phone.replace(
    /[\u2066\u2067\u2068\u2069\u200e\u200f\u202a\u202b\u202c\u202d\u202e]/g,
    "",
  );
  cleaned = cleaned.replace(/[^\d]/g, "");
  if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);
  if (cleaned.length === 11 && cleaned.startsWith("0")) cleaned = "2" + cleaned;
  if (cleaned.length === 10 && cleaned.startsWith("1")) cleaned = "20" + cleaned;
  return cleaned;
}

// ─── SSE: real-time push to connected browser clients ─────────────────────
const sseClients = new Set<Response>();

export function broadcastWaEvent(event: { type: string; phone?: string; [key: string]: unknown }) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      (client as Response).write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

router.get("/whatsapp/events", requireAuth, (req, res): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  // 15s heartbeat: keeps the SSE stream alive behind Render's reverse proxy,
  // which otherwise closes idle connections before the old 25s interval fired.
  const hb = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(hb);
      sseClients.delete(res);
    }
  }, 15000);
  sseClients.add(res);
  req.on("close", () => {
    clearInterval(hb);
    sseClients.delete(res);
  });
});

// ─── Webhook GET: Meta subscription handshake ─────────────────────────────
router.get("/webhook/whatsapp", (req, res): void => {
  if (!WEBHOOK_VERIFY_TOKEN) {
    res.status(500).json({ error: "WHATSAPP_VERIFY_TOKEN not configured" });
    return;
  }
  const mode = req.query["hub.mode"];
  const verifyToken = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode !== "subscribe" || typeof verifyToken !== "string" || typeof challenge !== "string") {
    res.status(403).json({ error: "Verification failed" });
    return;
  }
  let result: string | undefined;
  try {
    result = Whatsapp.get({
      "hub.mode": mode,
      "hub.verify_token": verifyToken,
      "hub.challenge": challenge,
    });
  } catch {
    result = undefined;
  }
  if (typeof result === "string") {
    logger.info("WhatsApp webhook verified by Meta");
    res.status(200).send(result);
  } else {
    res.status(403).json({ error: "Verification failed" });
  }
});

// Register the inbound-message handler once at module load.
Whatsapp.on.message = async ({ phoneID, from, message, name, reply }) => {
  try {
    const msg = message as unknown as ServerMessage;
    if (msg.type === "reaction") {
      await handleReactionWebhook(from, msg);
    } else if (await handleRepMessage(from, msg)) {
      // Registered representative bot owns this message (text or rep_ menu).
      logger.info({ from }, "Representative bot message handled");
    } else if (msg.type === "interactive" && await handleWorkOrderButton(from, msg)) {
      logger.info({ from }, "Work-order interactive button handled");
    } else {
      await handleInboundMessage(phoneID, from, msg, name, reply);
    }
  } catch (err) {
    logger.error({ err }, "WhatsApp inbound message handling error");
  }
};

// Register the delivery-status handler once at module load.
Whatsapp.on.status = async ({ status, id, error }) => {
  if (status === "failed") {
    const errCode = error?.code;
    const errDetails = error?.error_data?.details;
    logger.error({ id, status, error }, "WhatsApp message delivery FAILED");

    let failureReason = "فشل تسليم رسالة واتساب";
    if (errCode === 131042) {
      failureReason =
        "⚠️ فواتير واتساب بيزنس غير مسددة — يرجى تسوية الفاتورة على Meta Business لاستئناف إرسال الرسائل.";
    } else if (errCode === 131026) {
      failureReason = "رقم المستلم غير مسجل على واتساب";
    } else if (errCode === 131047) {
      failureReason = "انتهت نافذة المحادثة (24 ساعة)";
    } else if (errDetails) {
      failureReason = errDetails;
    }
    broadcastWaEvent({
      type: "delivery_failed",
      waMessageId: id,
      reason: failureReason,
      codes: errCode ? [errCode] : [],
    });

    try {
      await db.delete(whatsappChatsTable).where(eq(whatsappChatsTable.waMessageId, id));
      logger.info({ waMessageId: id }, "Removed chat records for failed WhatsApp delivery");
    } catch (delErr) {
      logger.warn(
        { err: delErr, waMessageId: id },
        "Could not remove failed delivery chat records",
      );
    }
  } else {
    logger.info({ id, status }, "WhatsApp status update");
  }
};

router.post(
  "/webhook/whatsapp",
  async (req: Request & { rawBody?: string }, res): Promise<void> => {
    res.sendStatus(200);
    try {
      const signature = req.headers["x-hub-signature-256"] as string | undefined;

      // First attempt: let the library handle verification + routing.
      // This works correctly when WHATSAPP_APP_SECRET in Render matches
      // the App Secret in Meta Developer Portal AND the body is ASCII-only.
      if (req.rawBody && signature) {
        try {
          await Whatsapp.post(req.body, req.rawBody, signature);
          return; // Library handled everything — done.
        } catch (sigErr) {
          // Signature check can fail for two reasons:
          //  1. WHATSAPP_APP_SECRET doesn't match Meta's App Secret.
          //  2. whatsapp-api-js applies escapeUnicode() to rawBody before HMAC,
          //     but Meta hashes the raw UTF-8 bytes — so Arabic/emoji content
          //     causes a mismatch even with the correct secret.
          // Either way: do NOT silently drop the message. Fall through and
          // process the payload directly without verification.
          logger.warn(
            { err: String(sigErr) },
            "WhatsApp webhook: signature verification failed — processing without verification. " +
              "ACTION: confirm WHATSAPP_APP_SECRET in Render matches " +
              "Meta Developers → App Settings → Basic → App Secret",
          );
        }
      }

      // Fallback / no-signature path: parse the Meta webhook body directly.
      await dispatchWebhookPayload(req.body as MetaWebhookBody);
    } catch (err) {
      logger.error({ err }, "WhatsApp webhook processing error");
    }
  },
);

// ─── Types for the raw Meta webhook body ─────────────────────────────────
interface MetaWebhookBody {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: ServerMessage[];
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        statuses?: Array<{
          id?: string;
          recipient_id?: string;
          status?: string;
          errors?: Array<{ code?: number; error_data?: { details?: string } }>;
        }>;
      };
    }>;
  }>;
}

/**
 * Parse and dispatch a Meta webhook payload without relying on the library's
 * secure post() wrapper. Called both as a fallback when signature verification
 * fails and as the primary path when no signature header is present.
 */
async function dispatchWebhookPayload(body: MetaWebhookBody): Promise<void> {
  if (body.object !== "whatsapp_business_account") return;
  const change = body.entry?.[0]?.changes?.[0];
  if (!change?.value) return;

  const phoneID = change.value.metadata?.phone_number_id ?? PHONE_NUMBER_ID;

  if (change.field === "messages") {
    if (change.value.messages?.length) {
      const message = change.value.messages[0] as ServerMessage;
      const contact = change.value.contacts?.[0];
      const from = contact?.wa_id ?? message.from;
      const name = contact?.profile?.name;

      if (message.type === "reaction") {
        await handleReactionWebhook(from, message);
      } else if (await handleRepMessage(from, message)) {
        // Registered representative bot owns this message (text or rep_ menu).
        logger.info({ from }, "Representative bot message handled");
      } else if (message.type === "interactive" && await handleWorkOrderButton(from, message)) {
        logger.info({ from }, "Work-order interactive button handled");
      } else {
        await handleInboundMessage(phoneID, from, message, name, async () => {});
      }
    } else if (change.value.statuses?.length) {
      const s = change.value.statuses[0];
      const status = s.status ?? "";
      const id = s.id ?? "";
      if (status === "failed") {
        const errCode = s.errors?.[0]?.code;
        const errDetails = s.errors?.[0]?.error_data?.details;
        let failureReason = "فشل تسليم رسالة واتساب";
        if (errCode === 131042)
          failureReason =
            "⚠️ فواتير واتساب بيزنس غير مسددة — يرجى تسوية الفاتورة على Meta Business لاستئناف إرسال الرسائل.";
        else if (errCode === 131026) failureReason = "رقم المستلم غير مسجل على واتساب";
        else if (errCode === 131047) failureReason = "انتهت نافذة المحادثة (24 ساعة)";
        else if (errDetails) failureReason = errDetails;
        broadcastWaEvent({
          type: "delivery_failed",
          waMessageId: id,
          reason: failureReason,
          codes: errCode ? [errCode] : [],
        });
        try {
          await db.delete(whatsappChatsTable).where(eq(whatsappChatsTable.waMessageId, id));
        } catch {
          /* non-critical */
        }
      } else {
        logger.info({ id, status }, "WhatsApp status update");
      }
    }
  }
}

interface ServerMessage {
  id: string;
  from: string;
  type: string;
  timestamp: string;
  text?: { body: string };
  image?: { id?: string; caption?: string; mime_type?: string };
  document?: { id?: string; filename?: string; mime_type?: string };
  audio?: { id?: string; mime_type?: string };
  video?: { id?: string; caption?: string; mime_type?: string };
  sticker?: { id?: string; mime_type?: string };
  reaction?: { message_id: string; emoji: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
    nfm_reply?: { name?: string; body?: string; response_json?: string };
  };
  button?: { text?: string; payload?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  contacts?: Array<{
    name?: { formatted_name?: string };
    phones?: Array<{ phone?: string; wa_id?: string }>;
  }>;
  order?: { catalog_id?: string; text?: string; product_items?: Array<{ product_retailer_id?: string; quantity?: string; item_price?: string; currency?: string }> };
  system?: { body?: string; type?: string };
  context?: { id: string; from?: string }; // message being replied to
}

/**
 * Resolve the pending (or most recent) work_order_assignment for a phone,
 * optionally constrained to a specific PO line item. Whole-PO assignments
 * (legacy, poItemId null) are matched by representativePhone; per-item
 * assignments additionally match poItemId.
 */
async function findAssignment(
  phone: string,
  poItemId?: number,
): Promise<typeof workOrderAssignmentsTable.$inferSelect | undefined> {
  const target = canonicalPhone(phone);
  const candidates = await db.select().from(workOrderAssignmentsTable);
  return (
    candidates
      .filter((a) => canonicalPhone(a.representativePhone) === target)
      .filter((a) => a.status !== "received" && a.status !== "rejected")
      .filter((a) => (poItemId == null ? true : a.poItemId === poItemId))
      .sort((a, b) => b.id - a.id)[0] ?? undefined
  );
}

/**
 * Handle per-item goods-receipt buttons and the rejection-reason list.
 * Payloads:
 *   work_order_item:<poNo>:<poItemId>:received   → show confirmation (don't record yet)
 *   work_order_item:<poNo>:<poItemId>:rejected   → prompt for reason
 *   work_order_confirm_item:<poNo>:<poItemId>:received → record the receipt (confirm)
 *   work_order_cancel_item:<poNo>:<poItemId>     → re-send item action buttons (تراجع)
 *   work_order_reason:<poNo>:<poItemId>:<encodedReason>   (from the list reply)
 *
 * "received" (after confirm) creates a po_item_receipts row using the ordered
 * qty as both received and accepted (full receipt). "rejected" prompts for the
 * reason via a list; the chosen reason creates a receipt row with rejectedQty.
 */
async function handleWorkOrderItemButton(
  phone: string,
  msg: ServerMessage,
): Promise<boolean> {
  const buttonId = msg.interactive?.button_reply?.id;
  const listId = msg.interactive?.list_reply?.id;
  const payload = buttonId ?? listId ?? "";
  if (
    !payload.startsWith("work_order_item:") &&
    !payload.startsWith("work_order_reason:") &&
    !payload.startsWith("work_order_confirm_item:") &&
    !payload.startsWith("work_order_cancel_item:")
  ) {
    return false;
  }

  // work_order_cancel_item:<poNo>:<poItemId> → re-send the item action buttons.
  if (payload.startsWith("work_order_cancel_item:")) {
    const parts = payload.split(":");
    const poNo = parts[1];
    const poItemId = parseInt(parts[2], 10);
    if (!isFinite(poItemId)) {
      await sendWhatsAppText(phone, "تعذر تحديد البند المرتبط بهذا الزر.");
      return true;
    }
    await resendItemActionReceipt(phone, poNo, poItemId);
    return true;
  }

  // work_order_confirm_item:<poNo>:<poItemId>:received → record the receipt.
  if (payload.startsWith("work_order_confirm_item:")) {
    const parts = payload.split(":");
    const poNo = parts[1];
    const poItemId = parseInt(parts[2], 10);
    if (!isFinite(poItemId)) {
      await sendWhatsAppText(phone, "تعذر تحديد البند المرتبط بهذا الزر.");
      return true;
    }
    const created = await recordItemReceipt(poItemId, {
      receivedQtyFromOrdered: true,
      acceptedQtyFromOrdered: true,
    });
    await sendWhatsAppText(
      phone,
      created
        ? `تم تسجيل استلام البند في أمر الشراء ${poNo}.`
        : `تعذر العثور على البند في أمر الشراء ${poNo}.`,
    );
    return true;
  }

  // work_order_item:<poNo>:<poItemId>:<received|rejected>
  if (payload.startsWith("work_order_item:")) {
    const parts = payload.split(":");
    const poNo = parts[1];
    const poItemId = parseInt(parts[2], 10);
    const action = parts[3];
    if (!isFinite(poItemId)) {
      await sendWhatsAppText(phone, "تعذر تحديد البند المرتبط بهذا الزر.");
      return true;
    }
    if (action === "rejected") {
      await sendRejectionReasonOptions(phone, poNo, poItemId, REJECTION_REASONS);
      return true;
    }
    if (action === "received") {
      // Show a confirm/cancel step before recording.
      await sendRepConfirm(phone, { kind: "receipt", no: poNo, itemId: poItemId, action: "received" });
      return true;
    }
    return true;
  }

  // work_order_reason:<poNo>:<poItemId>:<encodedReason>
  const parts = payload.split(":");
  const poNo = parts[1];
  const poItemId = parseInt(parts[2], 10);
  const reason = decodeURIComponent(parts.slice(3).join(":"));
  if (!isFinite(poItemId)) {
    await sendWhatsAppText(phone, "تعذر تحديد البند المرتبط بهذا الرد.");
    return true;
  }
  const created = await recordItemReceipt(poItemId, {
    rejectedQtyFromOrdered: true,
    rejectionReason: reason,
  });
  await sendWhatsAppText(
    phone,
    created
      ? `تم تسجيل رفض البند في أمر الشراء ${poNo} — السبب: ${reason}.`
      : `تعذر العثور على البند في أمر الشراء ${poNo}.`,
  );
  return true;
}

/** Re-send the item action buttons (استلام/رفض/رجوع) for a receipt item. */
async function resendItemActionReceipt(phone: string, poNo: string, poItemId: number): Promise<void> {
  const [line] = await db
    .select({
      poId: purchaseOrderItemsTable.poId,
      description: purchaseOrderItemsTable.description,
      lineItem: purchaseOrderItemsTable.lineItem,
      qty: purchaseOrderItemsTable.qty,
    })
    .from(purchaseOrderItemsTable)
    .where(eq(purchaseOrderItemsTable.id, poItemId));
  await sendRepItemAction(phone, {
    kind: "receipt",
    no: poNo,
    itemId: poItemId,
    poId: line?.poId ?? 0,
    label: [line?.lineItem, line?.description].filter(Boolean).join(" - ") || "بند",
    qty: formatWaQty(line?.qty),
  });
}

/**
 * Inserts a po_item_receipts row for a supplier PO line and re-aggregates the
 * item's totals. Uses the ordered qty on the purchase_order_item as the basis
 * (full receipt / full rejection). Returns false when the line is not found.
 *
 * The representative-driven WhatsApp flow records a single full-qty event; for
 * partial shipments or cost adjustments the operator should use the receipt
 * screen in the portal (POST /po/:id/receipts) where qty/cost are explicit.
 */
async function recordItemReceipt(
  poItemId: number,
  opts: {
    receivedQtyFromOrdered?: boolean;
    acceptedQtyFromOrdered?: boolean;
    rejectedQtyFromOrdered?: boolean;
    rejectionReason?: string;
  },
): Promise<boolean> {
  const [line] = await db
    .select({
      id: purchaseOrderItemsTable.id,
      poId: purchaseOrderItemsTable.poId,
      qty: purchaseOrderItemsTable.qty,
      customerPoItemId: purchaseOrderItemsTable.customerPoItemId,
    })
    .from(purchaseOrderItemsTable)
    .where(eq(purchaseOrderItemsTable.id, poItemId));
  if (!line) return false;

  const ordered = line.qty ? String(line.qty) : null;
  await db.insert(poItemReceiptsTable).values({
    poItemId: line.id,
    poId: line.poId,
    receivedQty: opts.receivedQtyFromOrdered ? ordered : null,
    acceptedQty: opts.acceptedQtyFromOrdered ? ordered : null,
    rejectedQty: opts.rejectedQtyFromOrdered ? ordered : null,
    rejectionReason: opts.rejectionReason ?? null,
    receiptStatus: opts.rejectedQtyFromOrdered ? "rejected" : "received",
    receivedBy: "واتساب",
  });

  // Re-aggregate the line's totals (mirrors the receipts endpoint logic).
  const rows = await db
    .select()
    .from(poItemReceiptsTable)
    .where(eq(poItemReceiptsTable.poItemId, line.id));
  const sum = (sel: (r: (typeof rows)[number]) => string | null) =>
    rows.reduce((acc, r) => acc + (sel(r) ? Number(sel(r)) : 0), 0);
  const received = sum((r) => r.receivedQty);
  const accepted = sum((r) => r.acceptedQty);
  const rejected = sum((r) => r.rejectedQty);

  // Weighted average actual cost across batches.
  let actualCost: number | null = null;
  const weighted = rows.reduce(
    (acc, r) => {
      const q = r.acceptedQty ? Number(r.acceptedQty) : 0;
      const c = r.actualCost ? Number(r.actualCost) : null;
      if (q > 0 && c != null) {
        acc.total += q * c;
        acc.weight += q;
      }
      return acc;
    },
    { total: 0, weight: 0 },
  );
  if (weighted.weight > 0) actualCost = weighted.total / weighted.weight;

  const orderedNum = ordered ? Number(ordered) : null;
  let lineStatus = "pending";
  if (accepted > 0) {
    lineStatus = orderedNum != null && accepted >= orderedNum ? "fulfilled" : "partial";
  } else if (rejected > 0) {
    lineStatus = "rejected";
  }

  await db
    .update(purchaseOrderItemsTable)
    .set({
      totalReceivedQty: String(received),
      totalAcceptedQty: String(accepted),
      totalRejectedQty: String(rejected),
      finalActualCost: actualCost != null ? String(actualCost) : null,
      lineStatus,
    })
    .where(eq(purchaseOrderItemsTable.id, line.id));

  // Auto-create a delivery work-order assignment when this supplier PO line is
  // linked to a customer PO item and the receipt was accepted (not rejected).
  // The representative can then deliver it to the customer via the bot menu.
  // Guarded: never allows delivering something that wasn't received.
  if (opts.acceptedQtyFromOrdered && line.customerPoItemId) {
    try {
      await ensureDeliveryAssignment(line.id, line.poId, line.customerPoItemId);
    } catch (err) {
      logger.warn({ err, poItemId: line.id }, "Auto delivery-assignment creation failed");
    }
  }
  return true;
}

/**
 * Create a delivery work-order assignment for a customer PO line linked to a
 * supplier PO item, reusing the representative from the receipt assignment if
 * available (so the same rep who received delivers), and resolving the
 * customerPoId from the customer_po_item. Idempotent: skips if an active
 * delivery assignment already exists for this customer_po_item_id.
 */
async function ensureDeliveryAssignment(
  poItemId: number,
  poId: number,
  customerPoItemId: number,
): Promise<void> {
  // Resolve the owning customer PO + customer_po_item row.
  const [cpi] = await db
    .select({
      id: customerPoItemsTable.id,
      customerPoId: customerPoItemsTable.customerPoId,
      deliveryStatus: customerPoItemsTable.deliveryStatus,
    })
    .from(customerPoItemsTable)
    .where(eq(customerPoItemsTable.id, customerPoItemId));
  if (!cpi) return;
  // Already fully delivered/rejected — no new assignment needed.
  if (cpi.deliveryStatus === "delivered" || cpi.deliveryStatus === "rejected") return;

  // Already has an active delivery assignment? skip.
  const existing = await db
    .select({ id: workOrderAssignmentsTable.id })
    .from(workOrderAssignmentsTable)
    .where(
      and(
        eq(workOrderAssignmentsTable.customerPoItemId, customerPoItemId),
        eq(workOrderAssignmentsTable.kind, WORK_ORDER_KIND.DELIVERY),
      ),
    );
  if (existing.length > 0) return;

  // Inherit representative from the receipt assignment of the linked PO item.
  const [receiptAssign] = await db
    .select({
      repName: workOrderAssignmentsTable.representativeName,
      repPhone: workOrderAssignmentsTable.representativePhone,
      repId: workOrderAssignmentsTable.representativeId,
    })
    .from(workOrderAssignmentsTable)
    .where(
      and(
        eq(workOrderAssignmentsTable.poItemId, poItemId),
        eq(workOrderAssignmentsTable.kind, WORK_ORDER_KIND.RECEIPT),
      ),
    )
    .orderBy(desc(workOrderAssignmentsTable.id));
  if (!receiptAssign) return; // no rep on record → wait for explicit assignment

  await db.insert(workOrderAssignmentsTable).values({
    poId,
    representativeId: receiptAssign.repId,
    representativeName: receiptAssign.repName,
    representativePhone: receiptAssign.repPhone,
    status: "sent",
    kind: WORK_ORDER_KIND.DELIVERY,
    customerPoId: cpi.customerPoId,
    customerPoItemId,
  });
}

// ─── Representative bot (menu-driven receipts & deliveries) ────────────────
// A registered representative interacting with the business number gets a
// menu-driven bot: any text → main menu; list replies drill into POs → items →
// action buttons. Non-reps fall through to the normal chat flow.

/** Is this phone number a registered, active representative? */
async function findRepresentative(phone: string) {
  const target = canonicalPhone(phone);
  const reps = await db.select().from(representativesTable);
  const rep = reps.find((r) => canonicalPhone(r.phone) === target);
  return rep && rep.isActive ? rep : undefined;
}

/** Count pending receipt + delivery assignments for a rep phone. */
async function countRepTasks(repPhone: string): Promise<{ receipt: number; delivery: number }> {
  const target = canonicalPhone(repPhone);
  const rows = await db
    .select({
      kind: workOrderAssignmentsTable.kind,
      status: workOrderAssignmentsTable.status,
      poItemId: workOrderAssignmentsTable.poItemId,
      customerPoItemId: workOrderAssignmentsTable.customerPoItemId,
      representativePhone: workOrderAssignmentsTable.representativePhone,
    })
    .from(workOrderAssignmentsTable);
  const mine = rows.filter((r) => canonicalPhone(r.representativePhone) === target);
  let receipt = 0;
  let delivery = 0;
  for (const r of mine) {
    if (r.kind === WORK_ORDER_KIND.DELIVERY) {
      if (r.status === "delivered" || r.status === "rejected") continue;
      delivery++;
    } else {
      if (r.status === "received" || r.status === "rejected") continue;
      receipt++;
    }
  }
  return { receipt, delivery };
}

/**
 * Group pending receipt assignments for a rep by supplier PO, returning the POs
 * with their pending item counts (for the PO picker list).
 */
async function repReceiptPoList(repPhone: string): Promise<
  Array<{ id: number; no: string; label: string; pendingItems: number }>
> {
  const target = canonicalPhone(repPhone);
  const assigns = await db
    .select({
      poItemId: workOrderAssignmentsTable.poItemId,
      poId: workOrderAssignmentsTable.poId,
      status: workOrderAssignmentsTable.status,
      representativePhone: workOrderAssignmentsTable.representativePhone,
    })
    .from(workOrderAssignmentsTable)
    .where(eq(workOrderAssignmentsTable.kind, WORK_ORDER_KIND.RECEIPT));
  const active = assigns
    .filter((a) => canonicalPhone(a.representativePhone) === target)
    .filter((a) => a.poItemId && a.status !== "received" && a.status !== "rejected");
  const poIds = [...new Set(active.map((a) => a.poId))];
  if (poIds.length === 0) return [];
  const pos = await db
    .select({ id: purchaseOrdersTable.id, no: purchaseOrdersTable.sheetPoNo })
    .from(purchaseOrdersTable)
    .where(inArray(purchaseOrdersTable.id, poIds));
  return pos.map((po) => ({
    id: po.id,
    no: po.no,
    label: `أمر شراء`,
    pendingItems: active.filter((a) => a.poId === po.id).length,
  }));
}

/**
 * Group pending delivery assignments for a rep by customer PO. Each row is a
 * customer PO with pending delivery items. Only items whose linked supplier PO
 * line was *accepted* appear (no delivering what wasn't received).
 */
async function repDeliveryPoList(repPhone: string): Promise<
  Array<{ id: number; no: string; label: string; pendingItems: number }>
> {
  const target = canonicalPhone(repPhone);
  const assigns = await db
    .select({
      customerPoId: workOrderAssignmentsTable.customerPoId,
      customerPoItemId: workOrderAssignmentsTable.customerPoItemId,
      status: workOrderAssignmentsTable.status,
      representativePhone: workOrderAssignmentsTable.representativePhone,
    })
    .from(workOrderAssignmentsTable)
    .where(eq(workOrderAssignmentsTable.kind, WORK_ORDER_KIND.DELIVERY));
  const active = assigns
    .filter((a) => canonicalPhone(a.representativePhone) === target)
    .filter(
      (a) => a.customerPoId && a.customerPoItemId && a.status !== "delivered" && a.status !== "rejected",
    );
  const poIds = [...new Set(active.map((a) => a.customerPoId!))];
  if (poIds.length === 0) return [];
  const pos = await db
    .select({ id: customerPosTable.id, no: customerPosTable.customerPoNo, name: customerPosTable.customerName })
    .from(customerPosTable)
    .where(inArray(customerPosTable.id, poIds));
  return pos.map((po) => ({
    id: po.id,
    no: po.no,
    label: po.name || "أمر شراء عميل",
    pendingItems: active.filter((a) => a.customerPoId === po.id).length,
  }));
}

/** Pending receipt items for a supplier PO (not yet received/rejected). */
async function repReceiptItems(poId: number): Promise<
  Array<{ id: number; label: string; qty: string | null; statusHint: string }>
> {
  const rows = await db
    .select({
      id: purchaseOrderItemsTable.id,
      description: purchaseOrderItemsTable.description,
      lineItem: purchaseOrderItemsTable.lineItem,
      qty: purchaseOrderItemsTable.qty,
      lineStatus: purchaseOrderItemsTable.lineStatus,
    })
    .from(purchaseOrderItemsTable)
    .where(eq(purchaseOrderItemsTable.poId, poId));
  const pending = rows.filter(
    (r) => r.lineStatus === "pending" || r.lineStatus === "partial",
  );
  return pending.map((r) => ({
    id: r.id,
    label: [r.lineItem, r.description].filter(Boolean).join(" - ") || "بند",
    qty: formatWaQty(r.qty),
    statusHint: r.lineStatus === "partial" ? "استلام جزئي" : "بانتظار الاستلام",
  }));
}

/** Pending delivery items for a customer PO (not yet delivered/rejected). */
async function repDeliveryItems(customerPoId: number): Promise<
  Array<{ id: number; label: string; qty: string | null; statusHint: string }>
> {
  const rows = await db
    .select({
      id: customerPoItemsTable.id,
      description: customerPoItemsTable.description,
      lineItem: customerPoItemsTable.lineItem,
      qty: customerPoItemsTable.qty,
      deliveryStatus: customerPoItemsTable.deliveryStatus,
    })
    .from(customerPoItemsTable)
    .where(eq(customerPoItemsTable.customerPoId, customerPoId));
  const pending = rows.filter(
    (r) => r.deliveryStatus === "pending" || r.deliveryStatus === "partial",
  );
  return pending.map((r) => ({
    id: r.id,
    label: [r.lineItem, r.description].filter(Boolean).join(" - ") || "بند",
    qty: formatWaQty(r.qty),
    statusHint: r.deliveryStatus === "partial" ? "تسليم جزئي" : "بانتظار التسليم",
  }));
}

/**
 * Handle an inbound message from a registered representative. Returns true if
 * handled (rep bot owns the message), false to let it fall through to the
 * normal chat flow. Triggers on: any text, or a list_reply/button_reply with a
 * `rep_` prefix.
 */
async function handleRepMessage(phone: string, msg: ServerMessage): Promise<boolean> {
  const listId = msg.interactive?.list_reply?.id;
  const buttonId = msg.interactive?.button_reply?.id;
  const payload = listId ?? buttonId ?? "";
  const isRepPayload = payload.startsWith("rep_");
  const isText = msg.type === "text" && Boolean(msg.text?.body);

  // Only engage the bot for registered reps. If a rep sent a rep_ payload (from
  // a previous menu) always handle it; otherwise any text from a rep opens the
  // main menu.
  const rep = await findRepresentative(phone);
  if (!rep && !isRepPayload) return false;
  if (!rep && isRepPayload) {
    await sendWhatsAppText(phone, "هذا الرقم غير مسجل كمندوب. تواصل مع الإدارة.");
    return true;
  }
  // rep is defined from here on.

  if (isText && !isRepPayload) {
    const counts = await countRepTasks(phone);
    await sendRepMainMenu(phone, counts);
    return true;
  }
  if (!isRepPayload) return false;

  // rep_menu:<kind>
  if (payload.startsWith("rep_menu:")) {
    const kind = payload.split(":")[1] as "receipt" | "delivery";
    if (kind === "receipt") {
      await sendRepPoPicker(phone, "receipt", await repReceiptPoList(phone));
    } else {
      await sendRepPoPicker(phone, "delivery", await repDeliveryPoList(phone));
    }
    return true;
  }
  // rep_po:<kind>:<poId>
  if (payload.startsWith("rep_po:")) {
    const [, kind, poIdStr] = payload.split(":");
    const poId = parseInt(poIdStr, 10);
    if (kind === "receipt") {
      await sendRepItemPicker(phone, "receipt", poId, await repReceiptItems(poId));
    } else {
      await sendRepItemPicker(phone, "delivery", poId, await repDeliveryItems(poId));
    }
    return true;
  }
  // rep_item:<kind>:<poId>:<itemId> → action buttons
  if (payload.startsWith("rep_item:")) {
    const [, kind, poIdStr, itemIdStr] = payload.split(":");
    const poId = parseInt(poIdStr, 10);
    const itemId = parseInt(itemIdStr, 10);
    if (kind === "receipt") {
      // Resolve poNo + line label.
      const [po] = await db
        .select({ no: purchaseOrdersTable.sheetPoNo })
        .from(purchaseOrdersTable)
        .where(eq(purchaseOrdersTable.id, poId));
      const [it] = await db
        .select({
          description: purchaseOrderItemsTable.description,
          lineItem: purchaseOrderItemsTable.lineItem,
          qty: purchaseOrderItemsTable.qty,
        })
        .from(purchaseOrderItemsTable)
        .where(eq(purchaseOrderItemsTable.id, itemId));
      await sendRepItemAction(phone, {
        kind: "receipt",
        no: po?.no ?? poIdStr,
        itemId,
        poId,
        label: [it?.lineItem, it?.description].filter(Boolean).join(" - ") || "بند",
        qty: formatWaQty(it?.qty),
      });
    } else {
      const [po] = await db
        .select({ no: customerPosTable.customerPoNo })
        .from(customerPosTable)
        .where(eq(customerPosTable.id, poId));
      const [it] = await db
        .select({
          description: customerPoItemsTable.description,
          lineItem: customerPoItemsTable.lineItem,
          qty: customerPoItemsTable.qty,
        })
        .from(customerPoItemsTable)
        .where(eq(customerPoItemsTable.id, itemId));
      await sendRepItemAction(phone, {
        kind: "delivery",
        no: po?.no ?? poIdStr,
        itemId,
        poId,
        label: [it?.lineItem, it?.description].filter(Boolean).join(" - ") || "بند",
        qty: formatWaQty(it?.qty),
      });
    }
    return true;
  }
  // rep_back:<target> — re-send the previous menu so the rep can navigate back.
  //   rep_back:menu        → main menu
  //   rep_back:po:<kind>   → PO picker
  //   rep_back:item:<kind>:<poId> → item picker (back from an item's action)
  if (payload.startsWith("rep_back:")) {
    const [, target, kind, poIdStr] = payload.split(":");
    if (target === "menu") {
      const counts = await countRepTasks(phone);
      await sendRepMainMenu(phone, counts);
    } else if (target === "po" && (kind === "receipt" || kind === "delivery")) {
      const pos = kind === "receipt" ? await repReceiptPoList(phone) : await repDeliveryPoList(phone);
      await sendRepPoPicker(phone, kind, pos);
    } else if (target === "item" && (kind === "receipt" || kind === "delivery")) {
      const poId = parseInt(poIdStr, 10);
      const items = kind === "receipt" ? await repReceiptItems(poId) : await repDeliveryItems(poId);
      await sendRepItemPicker(phone, kind, poId, items);
    }
    return true;
  }
  return false;
}

/**
 * Handle per-item customer-delivery buttons and the customer-rejection list.
 * Payloads:
 *   work_order_delivery:<customerPoNo>:<customerPoItemId>:delivered → show confirmation
 *   work_order_delivery:<customerPoNo>:<customerPoItemId>:customer_rejected → prompt reason
 *   work_order_confirm_delivery:<customerPoNo>:<customerPoItemId>:delivered → record delivery (confirm)
 *   work_order_cancel_delivery:<customerPoNo>:<customerPoItemId> → re-send item action (تراجع)
 *   work_order_delivery_reason:<customerPoNo>:<customerPoItemId>:<reason>
 *
 * "delivered" (after confirm) creates a customer_po_item_deliveries row using
 * the ordered qty (full delivery). "customer_rejected" prompts for the reason;
 * the chosen reason creates a delivery row with rejectedByCustomerQty = ordered qty.
 * Guard: the customer_po_item must be linked to a supplier PO item whose line
 * was *accepted* (received) — no delivering what wasn't received.
 */
async function handleWorkOrderDeliveryButton(
  phone: string,
  msg: ServerMessage,
): Promise<boolean> {
  const buttonId = msg.interactive?.button_reply?.id;
  const listId = msg.interactive?.list_reply?.id;
  const payload = buttonId ?? listId ?? "";
  if (
    !payload.startsWith("work_order_delivery:") &&
    !payload.startsWith("work_order_delivery_reason:") &&
    !payload.startsWith("work_order_confirm_delivery:") &&
    !payload.startsWith("work_order_cancel_delivery:")
  ) {
    return false;
  }

  // work_order_cancel_delivery:<customerPoNo>:<customerPoItemId> → re-send item action.
  if (payload.startsWith("work_order_cancel_delivery:")) {
    const parts = payload.split(":");
    const customerPoNo = parts[1];
    const customerPoItemId = parseInt(parts[2], 10);
    if (!isFinite(customerPoItemId)) {
      await sendWhatsAppText(phone, "تعذر تحديد البند المرتبط بهذا الزر.");
      return true;
    }
    await resendItemActionDelivery(phone, customerPoNo, customerPoItemId);
    return true;
  }

  // work_order_confirm_delivery:<customerPoNo>:<customerPoItemId>:delivered → record.
  if (payload.startsWith("work_order_confirm_delivery:")) {
    const parts = payload.split(":");
    const customerPoNo = parts[1];
    const customerPoItemId = parseInt(parts[2], 10);
    if (!isFinite(customerPoItemId)) {
      await sendWhatsAppText(phone, "تعذر تحديد البند المرتبط بهذا الزر.");
      return true;
    }
    const created = await recordItemDelivery(customerPoItemId, { deliveredFromOrdered: true });
    await sendWhatsAppText(
      phone,
      created
        ? `تم تسجيل تسليم البند للعميل في أمر الشراء ${customerPoNo}.`
        : `تعذر تسجيل التسليم — تأكد أن البند قد استُلم من المورد أولاً.`,
    );
    return true;
  }

  // work_order_delivery:<customerPoNo>:<customerPoItemId>:<delivered|customer_rejected>
  if (payload.startsWith("work_order_delivery:")) {
    const parts = payload.split(":");
    const customerPoNo = parts[1];
    const customerPoItemId = parseInt(parts[2], 10);
    const action = parts[3];
    if (!isFinite(customerPoItemId)) {
      await sendWhatsAppText(phone, "تعذر تحديد البند المرتبط بهذا الزر.");
      return true;
    }
    if (action === "customer_rejected") {
      await sendDeliveryRejectionReasonOptions(phone, customerPoNo, customerPoItemId, CUSTOMER_REJECTION_REASONS);
      return true;
    }
    if (action === "delivered") {
      // Show a confirm/cancel step before recording.
      await sendRepConfirm(phone, { kind: "delivery", no: customerPoNo, itemId: customerPoItemId, action: "delivered" });
      return true;
    }
    return true;
  }

  // work_order_delivery_reason:<customerPoNo>:<customerPoItemId>:<encodedReason>
  const parts = payload.split(":");
  const customerPoNo = parts[1];
  const customerPoItemId = parseInt(parts[2], 10);
  const reason = decodeURIComponent(parts.slice(3).join(":"));
  if (!isFinite(customerPoItemId)) {
    await sendWhatsAppText(phone, "تعذر تحديد البند المرتبط بهذا الرد.");
    return true;
  }
  const created = await recordItemDelivery(customerPoItemId, {
    customerRejectedFromOrdered: true,
    rejectionReason: reason,
  });
  await sendWhatsAppText(
    phone,
    created
      ? `تم تسجيل رفض العميل للبند في أمر الشراء ${customerPoNo} — السبب: ${reason}.`
      : `تعذر تسجيل الرفض — تأكد أن البند قد استُلم من المورد أولاً.`,
  );
  return true;
}

/** Re-send the item action buttons (تسليم/رفض العميل/رجوع) for a delivery item. */
async function resendItemActionDelivery(phone: string, customerPoNo: string, customerPoItemId: number): Promise<void> {
  const [line] = await db
    .select({
      customerPoId: customerPoItemsTable.customerPoId,
      description: customerPoItemsTable.description,
      lineItem: customerPoItemsTable.lineItem,
      qty: customerPoItemsTable.qty,
    })
    .from(customerPoItemsTable)
    .where(eq(customerPoItemsTable.id, customerPoItemId));
  await sendRepItemAction(phone, {
    kind: "delivery",
    no: customerPoNo,
    itemId: customerPoItemId,
    poId: line?.customerPoId ?? 0,
    label: [line?.lineItem, line?.description].filter(Boolean).join(" - ") || "بند",
    qty: formatWaQty(line?.qty),
  });
}

/**
 * Inserts a customer_po_item_deliveries row and re-aggregates the customer
 * PO item's delivery totals. Uses the ordered qty as the basis (full delivery
 * / full rejection). Returns false when the line is not found OR has not been
 * received from the supplier yet (no accepted supplier receipt on a linked
 * purchase_order_item).
 */
async function recordItemDelivery(
  customerPoItemId: number,
  opts: {
    deliveredFromOrdered?: boolean;
    customerRejectedFromOrdered?: boolean;
    rejectionReason?: string;
  },
): Promise<boolean> {
  const [cpi] = await db
    .select({
      id: customerPoItemsTable.id,
      customerPoId: customerPoItemsTable.customerPoId,
      qty: customerPoItemsTable.qty,
      deliveryStatus: customerPoItemsTable.deliveryStatus,
    })
    .from(customerPoItemsTable)
    .where(eq(customerPoItemsTable.id, customerPoItemId));
  if (!cpi) return false;

  // Guard: confirm a linked supplier PO item was *accepted* (received).
  const [linked] = await db
    .select({
      lineStatus: purchaseOrderItemsTable.lineStatus,
      totalAcceptedQty: purchaseOrderItemsTable.totalAcceptedQty,
    })
    .from(purchaseOrderItemsTable)
    .where(eq(purchaseOrderItemsTable.customerPoItemId, customerPoItemId));
  if (!linked) return false;
  const accepted = linked.totalAcceptedQty ? Number(linked.totalAcceptedQty) : 0;
  if (accepted <= 0 || linked.lineStatus === "rejected") return false;

  const ordered = cpi.qty ? String(cpi.qty) : null;
  await db.insert(customerPoItemDeliveriesTable).values({
    customerPoItemId: cpi.id,
    customerPoId: cpi.customerPoId,
    deliveredQty: opts.deliveredFromOrdered ? ordered : null,
    rejectedByCustomerQty: opts.customerRejectedFromOrdered ? ordered : null,
    rejectionReason: opts.rejectionReason ?? null,
    deliveryStatus: opts.customerRejectedFromOrdered ? "rejected" : "delivered",
    deliveredBy: "واتساب",
  });

  // Re-aggregate (mirrors the deliveries endpoint logic).
  const rows = await db
    .select()
    .from(customerPoItemDeliveriesTable)
    .where(eq(customerPoItemDeliveriesTable.customerPoItemId, cpi.id));
  const sum = (sel: (r: (typeof rows)[number]) => string | null) =>
    rows.reduce((acc, r) => acc + (sel(r) ? Number(sel(r)) : 0), 0);
  const delivered = sum((r) => r.deliveredQty);
  const rejected = sum((r) => r.rejectedByCustomerQty);

  let status = "pending";
  if (rejected > 0 && delivered === 0) status = "rejected";
  else if (ordered != null && delivered >= Number(ordered)) status = "delivered";
  else if (delivered > 0) status = "partial";

  await db
    .update(customerPoItemsTable)
    .set({
      totalDeliveredQty: String(delivered),
      totalRejectedByCustomerQty: String(rejected),
      deliveryStatus: status,
    })
    .where(eq(customerPoItemsTable.id, cpi.id));

  // Mark the delivery assignment as done.
  await db
    .update(workOrderAssignmentsTable)
    .set({
      status: opts.customerRejectedFromOrdered ? "rejected" : "delivered",
      rejectionReason: opts.rejectionReason ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workOrderAssignmentsTable.customerPoItemId, cpi.id),
        eq(workOrderAssignmentsTable.kind, WORK_ORDER_KIND.DELIVERY),
      ),
    );
  return true;
}

async function handleWorkOrderButton(phone: string, msg: ServerMessage): Promise<boolean> {
  // Delivery flow (to customer) — checked first so delivery payloads don't
  // fall through to the receipt/legacy handlers.
  if (await handleWorkOrderDeliveryButton(phone, msg)) return true;
  // Per-item goods-receipt flow takes precedence over the legacy whole-PO flow.
  if (await handleWorkOrderItemButton(phone, msg)) return true;

  const payload = msg.interactive?.button_reply?.id;
  if (!payload?.startsWith("work_order:")) return false;
  const [, poNo, action, decision] = payload.split(":");
  const assignment = await findAssignment(phone);
  if (!assignment) {
    await sendWhatsAppText(phone, "تعذر العثور على أمر الشغل المرتبط بهذا الزر.");
    return true;
  }
  if (action === "received" || action === "rejected") {
    await db.update(workOrderAssignmentsTable).set({ pendingAction: action, status: `pending_${action}`, updatedAt: new Date() }).where(eq(workOrderAssignmentsTable.id, assignment.id));
    await sendWhatsAppInteractiveConfirmation(phone, poNo, action);
    return true;
  }
  if (decision === "cancel") {
    await db.update(workOrderAssignmentsTable).set({ pendingAction: null, status: "sent", updatedAt: new Date() }).where(eq(workOrderAssignmentsTable.id, assignment.id));
    await sendWhatsAppText(phone, "تم التراجع، ولم يتم تغيير حالة أمر الشغل.");
    return true;
  }
  if (decision === "confirm" && (action === "received" || action === "rejected")) {
    await db.update(workOrderAssignmentsTable).set({ pendingAction: null, status: action, updatedAt: new Date() }).where(eq(workOrderAssignmentsTable.id, assignment.id));
    await sendWhatsAppText(phone, action === "received" ? `تم تأكيد استلام أمر الشغل ${poNo}.` : `تم تأكيد رفض أمر الشغل ${poNo}.`);
    return true;
  }
  return true;
}

async function handleInboundMessage(
  phoneID: string,
  phone: string,
  msg: ServerMessage,
  senderName: string | undefined,
  reply: (message: import("whatsapp-api-js/types").ClientMessage) => Promise<unknown>,
): Promise<void> {
  const waMessageId = msg.id;
  let body: string;
  let mediaId: string | null = null;
  let mediaType: string | null = null;
  let mimeType: string | null = null;
  let filename: string | null = null;

  if (msg.type === "text" && msg.text) {
    body = msg.text.body;
  } else if (msg.type === "image" && msg.image) {
    body = `[صورة مرسلة]${msg.image.caption ? " — " + msg.image.caption : ""}`;
    mediaId = msg.image.id ?? null;
    mediaType = "image";
    mimeType = msg.image.mime_type ?? null;
  } else if (msg.type === "document" && msg.document) {
    body = `[مستند: ${msg.document.filename ?? "ملف"}]`;
    mediaId = msg.document.id ?? null;
    mediaType = "document";
    mimeType = msg.document.mime_type ?? null;
    filename = msg.document.filename ?? null;
  } else if (msg.type === "audio" && msg.audio) {
    body = "[رسالة صوتية]";
    mediaId = msg.audio.id ?? null;
    mediaType = "audio";
    mimeType = msg.audio.mime_type ?? null;
  } else if (msg.type === "video" && msg.video) {
    body = `[فيديو]${msg.video.caption ? " — " + msg.video.caption : ""}`;
    mediaId = msg.video.id ?? null;
    mediaType = "video";
    mimeType = msg.video.mime_type ?? null;
  } else if (msg.type === "sticker" && msg.sticker) {
    // Stickers arrive as image/webp media — render as an image.
    body = "[ملصق]";
    mediaId = msg.sticker.id ?? null;
    mediaType = "image";
    mimeType = msg.sticker.mime_type ?? "image/webp";
  } else if (msg.type === "location" && msg.location) {
    const { latitude, longitude, name, address } = msg.location;
    const label = name || address ? ` (${name ?? ""}${address ? " — " + address : ""})`.trim() : "";
    body = `📍 موقع${label}: ${latitude ?? ""}, ${longitude ?? ""}`;
    if (latitude != null && longitude != null)
      body += ` — https://maps.google.com/?q=${latitude},${longitude}`;
  } else if (msg.type === "contacts" && msg.contacts?.length) {
    body =
      "👤 جهة اتصال:\n" +
      msg.contacts
        .map((c) => {
          const nm = c.name?.formatted_name ?? "";
          const nums = (c.phones ?? []).map((p) => p.phone ?? p.wa_id ?? "").filter(Boolean);
          return `${nm}${nums.length ? " — " + nums.join("، ") : ""}`.trim();
        })
        .join("\n");
  } else if (msg.type === "button" && msg.button) {
    body = `🔘 رد على زر: ${msg.button.text ?? msg.button.payload ?? ""}`;
  } else if (msg.type === "interactive" && msg.interactive) {
    const ir = msg.interactive;
    if (ir.list_reply) body = `📋 ${ir.list_reply.title ?? ""}${ir.list_reply.description ? " — " + ir.list_reply.description : ""}`;
    else if (ir.nfm_reply) body = `📝 ${ir.nfm_reply.name ?? "نموذج"}: ${ir.nfm_reply.body ?? ir.nfm_reply.response_json ?? ""}`;
    else body = `🔘 رد تفاعلي: ${ir.button_reply?.title ?? ""}`;
  } else if (msg.type === "order" && msg.order) {
    const items = msg.order.product_items ?? [];
    body =
      `🛒 طلب${msg.order.text ? " — " + msg.order.text : ""}:\n` +
      items
        .map((it) => `${it.quantity ?? "1"} × ${it.product_retailer_id ?? "منتج"}${it.item_price ? ` (${it.currency ?? ""} ${it.item_price})` : ""}`)
        .join("\n");
  } else if (msg.type === "system" && msg.system) {
    body = `ℹ️ ${msg.system.body ?? msg.system.type ?? "رسالة نظام"}`;
  } else {
    body = `[رسالة من نوع: ${msg.type}]`;
  }

  const allSuppliers = await db.select().from(suppliersTable);
  const matchedSupplier = allSuppliers.find((s) => {
    if (!s.phone) return false;
    const normalized = s.phone.replace(/[\s\-()]/g, "").replace(/^\+/, "");
    return normalized === phone || normalized.endsWith(phone) || phone.endsWith(normalized);
  });

  const existing = await db
    .select({ id: whatsappChatsTable.id })
    .from(whatsappChatsTable)
    .where(eq(whatsappChatsTable.waMessageId, waMessageId))
    .limit(1);
  if (existing.length > 0) return;

  await db.insert(whatsappChatsTable).values({
    waMessageId,
    direction: "inbound",
    phone,
    supplierId: matchedSupplier?.id ?? null,
    body,
    mediaId,
    mediaType,
    mimeType,
    filename,
    replyToMessageId: msg.context?.id ?? null,
    isRead: false,
  });

  try {
    await Whatsapp.markAsRead(phoneID, waMessageId);
  } catch {
    /* non-critical */
  }

  // Cache media binary in background so it survives Meta's 30-day expiry
  if (mediaId) {
    void downloadAndStoreMedia(mediaId, mimeType ?? "application/octet-stream");
  }

  logger.info(
    { from: phone, type: msg.type, supplier: matchedSupplier?.name },
    "WhatsApp inbound message saved",
  );
  broadcastWaEvent({ type: "new_message", phone, senderName });
  void reply;
}

// ─── Background: download + store media binary ─────────────────────────
async function downloadAndStoreMedia(mediaId: string, fallbackMime: string): Promise<void> {
  try {
    // Skip if already cached
    const existing = await db
      .select({ waMediaId: whatsappMediaTable.waMediaId })
      .from(whatsappMediaTable)
      .where(eq(whatsappMediaTable.waMediaId, mediaId))
      .limit(1);
    if (existing.length > 0) return;

    const metaRes = await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${mediaId}`,
    );
    if (!metaRes.ok) return;
    const metaData = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!metaData.url) return;

    const mediaRes = await Whatsapp.$$apiFetch$$(metaData.url);
    if (!mediaRes.ok) return;
    const buffer = Buffer.from(await mediaRes.arrayBuffer());

    await db
      .insert(whatsappMediaTable)
      .values({
        waMediaId: mediaId,
        data: buffer,
        mimeType: metaData.mime_type ?? fallbackMime,
      })
      .onConflictDoNothing();

    logger.info({ mediaId, bytes: buffer.length }, "WhatsApp media cached to DB");
  } catch (err) {
    logger.warn({ err, mediaId }, "Background media cache failed (non-critical)");
  }
}

// ─── Handle reaction webhook ──────────────────────────────────────────────
async function handleReactionWebhook(from: string, msg: ServerMessage): Promise<void> {
  const phone = normalizePhone(from);
  const reaction = msg.reaction;
  if (!reaction) return;
  const { message_id: waMessageId, emoji } = reaction;

  if (!emoji || emoji.trim() === "") {
    // Remove reaction
    await db
      .delete(whatsappReactionsTable)
      .where(
        and(
          eq(whatsappReactionsTable.waMessageId, waMessageId),
          eq(whatsappReactionsTable.reactorPhone, phone),
        ),
      );
  } else {
    // Upsert reaction
    await db
      .insert(whatsappReactionsTable)
      .values({
        waMessageId,
        reactorPhone: phone,
        emoji,
      })
      .onConflictDoUpdate({
        target: [whatsappReactionsTable.waMessageId, whatsappReactionsTable.reactorPhone],
        set: { emoji },
      });
  }
  broadcastWaEvent({ type: "reaction", waMessageId, reactorPhone: phone, emoji });
  logger.info({ waMessageId, phone, emoji }, "WhatsApp reaction processed");
}

// ─── GET /api/whatsapp/media/:mediaId ────────────────────────────────────
router.get("/whatsapp/media/:mediaId", requireAuth, async (req, res): Promise<void> => {
  const mediaId = req.params.mediaId as string;
  if (!isWhatsAppConfigured) {
    res.status(503).json({ error: "WhatsApp not configured" });
    return;
  }
  try {
    // Try DB cache first (avoids Meta 30-day expiry)
    const cached = await db
      .select()
      .from(whatsappMediaTable)
      .where(eq(whatsappMediaTable.waMediaId, mediaId))
      .limit(1);
    if (cached.length > 0) {
      res.setHeader("Content-Type", cached[0].mimeType);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.send(cached[0].data);
      return;
    }

    // Fallback: fetch from Meta and store for next time
    const metaRes = await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${mediaId}`,
    );
    const metaData = (await metaRes.json()) as { url?: string; mime_type?: string; error?: object };
    if (!metaRes.ok || !metaData.url) {
      res.status(404).json({ error: "Media not found", detail: metaData.error });
      return;
    }
    const mediaRes = await Whatsapp.$$apiFetch$$(metaData.url);
    if (!mediaRes.ok) {
      res.status(404).json({ error: "Media download failed" });
      return;
    }
    const buffer = Buffer.from(await mediaRes.arrayBuffer());
    const mime = metaData.mime_type || "application/octet-stream";

    // Store in DB (fire-and-forget)
    void db
      .insert(whatsappMediaTable)
      .values({ waMediaId: mediaId, data: buffer, mimeType: mime })
      .onConflictDoNothing();

    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(buffer);
  } catch (err) {
    logger.error({ err, mediaId }, "Failed to proxy WhatsApp media");
    res.status(500).json({ error: "Failed to fetch media" });
  }
});

// ─── GET /api/whatsapp/profile-picture/:phone ─────────────────────────────
router.get("/whatsapp/profile-picture/:phone", requireAuth, async (req, res): Promise<void> => {
  const phone = req.params.phone as string;
  if (!isWhatsAppConfigured) {
    res.status(404).json({ error: "Not configured" });
    return;
  }
  try {
    const contactRes = await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/contacts?wa_id=${phone}&fields=profile_picture_url`,
    );
    const contactData = (await contactRes.json()) as {
      data?: Array<{ profile_picture_url?: string }>;
    };
    const picUrl = contactData.data?.[0]?.profile_picture_url;
    if (!picUrl) {
      res.status(404).json({ error: "No profile picture" });
      return;
    }
    const imgRes = await Whatsapp.$$apiFetch$$(picUrl);
    if (!imgRes.ok) {
      res.status(404).json({ error: "Image not available" });
      return;
    }
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    res.setHeader("Content-Type", imgRes.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(buffer);
  } catch (err) {
    logger.warn({ err, phone }, "Failed to fetch WhatsApp profile picture");
    res.status(404).json({ error: "Failed to fetch profile picture" });
  }
});

// ─── GET /api/whatsapp/chats ──────────────────────────────────────────────
router.get("/whatsapp/chats", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select({
      phone: whatsappChatsTable.phone,
      supplierId: whatsappChatsTable.supplierId,
      supplierName: suppliersTable.name,
      lastMessage: sql<string>`(array_agg(${whatsappChatsTable.body} ORDER BY ${whatsappChatsTable.createdAt} DESC))[1]`,
      lastAt: sql<Date>`MAX(${whatsappChatsTable.createdAt})`,
      lastInboundAt: sql<Date | null>`MAX(${whatsappChatsTable.createdAt}) FILTER (WHERE ${whatsappChatsTable.direction} = 'inbound')`,
      unread: sql<number>`COUNT(*) FILTER (WHERE ${whatsappChatsTable.direction} = 'inbound' AND ${whatsappChatsTable.isRead} = false)`,
    })
    .from(whatsappChatsTable)
    .leftJoin(suppliersTable, eq(whatsappChatsTable.supplierId, suppliersTable.id))
    .groupBy(whatsappChatsTable.phone, whatsappChatsTable.supplierId, suppliersTable.name)
    .orderBy(sql`MAX(${whatsappChatsTable.createdAt}) DESC`);
  res.json(rows);
});

// ─── GET /api/whatsapp/chats/:phone ──────────────────────────────────────
router.get("/whatsapp/chats/:phone", requireAuth, async (req, res): Promise<void> => {
  const phone = req.params.phone as string;
  const messages = await db
    .select()
    .from(whatsappChatsTable)
    .where(eq(whatsappChatsTable.phone, phone))
    .orderBy(desc(whatsappChatsTable.createdAt))
    .limit(200);
  await db
    .update(whatsappChatsTable)
    .set({ isRead: true })
    .where(eq(whatsappChatsTable.phone, phone));

  // Attach reactions to each message
  const msgIds = messages.map((m) => m.waMessageId).filter(Boolean) as string[];
  const reactionMap = new Map<string, Array<{ reactorPhone: string; emoji: string }>>();
  if (msgIds.length > 0) {
    const reactions = await db
      .select()
      .from(whatsappReactionsTable)
      .where(inArray(whatsappReactionsTable.waMessageId, msgIds));
    for (const r of reactions) {
      const list = reactionMap.get(r.waMessageId) ?? [];
      list.push({ reactorPhone: r.reactorPhone, emoji: r.emoji });
      reactionMap.set(r.waMessageId, list);
    }
  }

  const enriched = messages.reverse().map((m) => ({
    ...m,
    reactions: m.waMessageId ? (reactionMap.get(m.waMessageId) ?? []) : [],
  }));
  res.json(enriched);
});

// ─── POST /api/whatsapp/react ─────────────────────────────────────────────
router.post("/whatsapp/react", requireAuth, async (req, res): Promise<void> => {
  const { waMessageId, toPhone, emoji } = req.body as {
    waMessageId: string;
    toPhone: string;
    emoji: string;
  };
  if (!waMessageId || !toPhone) {
    res.status(400).json({ error: "waMessageId and toPhone are required" });
    return;
  }
  if (!isWhatsAppConfigured) {
    res.status(503).json({ error: "WhatsApp not configured" });
    return;
  }
  try {
    // Send reaction via Meta API
    await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: toPhone,
          type: "reaction",
          reaction: { message_id: waMessageId, emoji: emoji ?? "" },
        }),
      },
    );

    // Persist locally (reactorPhone = "me" = our account)
    if (emoji && emoji.trim() !== "") {
      await db
        .insert(whatsappReactionsTable)
        .values({
          waMessageId,
          reactorPhone: "me",
          emoji,
        })
        .onConflictDoUpdate({
          target: [whatsappReactionsTable.waMessageId, whatsappReactionsTable.reactorPhone],
          set: { emoji },
        });
    } else {
      await db
        .delete(whatsappReactionsTable)
        .where(
          and(
            eq(whatsappReactionsTable.waMessageId, waMessageId),
            eq(whatsappReactionsTable.reactorPhone, "me"),
          ),
        );
    }

    broadcastWaEvent({ type: "reaction", waMessageId, reactorPhone: "me", emoji });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, waMessageId }, "Failed to send WhatsApp reaction");
    res.status(500).json({ error: "Failed to send reaction" });
  }
});

// ─── POST /api/whatsapp/send ──────────────────────────────────────────────
router.post("/whatsapp/send", requireAuth, async (req, res): Promise<void> => {
  const { phone, message, supplierId, replyToWaMessageId } = req.body as {
    phone: string;
    message: string;
    supplierId?: number;
    replyToWaMessageId?: string;
  };
  if (!phone || !message) {
    res.status(400).json({ error: "phone and message are required" });
    return;
  }
  const normalized = normalizePhone(phone);
  let outboundWaId: string | null = null;
  try {
    if (replyToWaMessageId && isWhatsAppConfigured) {
      // Send with reply context using Meta API directly
      const apiBody = JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalized,
        context: { message_id: replyToWaMessageId },
        type: "text",
        text: { body: message, preview_url: false },
      });
      const r = await Whatsapp.$$apiFetch$$(
        `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/messages`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: apiBody },
      );
      const data = (await r.json()) as { messages?: Array<{ id: string }>; error?: unknown };
      if (!r.ok) throw new Error(`WhatsApp API error: ${JSON.stringify(data.error)}`);
      outboundWaId = data.messages?.[0]?.id ?? null;
    } else {
      outboundWaId = await sendWhatsAppText(phone, message);
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, phone: normalized }, "WhatsApp send failed");
    let userMessage = "فشل إرسال الرسالة عبر WhatsApp.";
    if (errMsg.includes("131047"))
      userMessage =
        "انتهت نافذة المحادثة (24 ساعة). لا يمكن إرسال رسائل حرة بعد 24 ساعة من آخر رسالة من المورد.";
    else if (errMsg.includes("131026")) userMessage = "رقم الهاتف غير مسجل على WhatsApp.";
    res.status(400).json({ error: userMessage, detail: errMsg });
    return;
  }
  await db.insert(whatsappChatsTable).values({
    waMessageId: outboundWaId,
    direction: "outbound",
    phone: normalized,
    supplierId: supplierId ?? null,
    body: message,
    replyToMessageId: replyToWaMessageId ?? null,
    isRead: true,
  });
  res.json({ ok: true });
});

// ─── POST /api/whatsapp/forward ──────────────────────────────────────────
router.post("/whatsapp/forward", requireAuth, async (req, res): Promise<void> => {
  const { messageId, toPhone } = req.body as { messageId: number; toPhone: string };
  if (!messageId || !toPhone) {
    res.status(400).json({ error: "messageId and toPhone are required" });
    return;
  }
  if (!isWhatsAppConfigured) {
    res.status(503).json({ error: "WhatsApp not configured" });
    return;
  }
  const [msg] = await db
    .select()
    .from(whatsappChatsTable)
    .where(eq(whatsappChatsTable.id, messageId))
    .limit(1);
  if (!msg) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  const normalizedTo = normalizePhone(toPhone);
  let outboundWaId: string | null = null;
  try {
    if (msg.mediaId && msg.mediaType) {
      // Helper: given a buffer+mimeType, upload to Meta then send as typed media message.
      // Uses uploadWhatsAppMedia (proven in service.ts) + Whatsapp.sendMessage (proven in send-media route).
      const uploadAndSend = async (buffer: Buffer, mimeType: string): Promise<string | null> => {
        const filename = msg.filename || "file";
        const newMediaId = await uploadWhatsAppMedia(buffer, filename, mimeType);
        const {
          Image,
          Video,
          Audio,
          Document: WADocument,
        } = await import("whatsapp-api-js/messages");
        const waMessage =
          msg.mediaType === "image"
            ? new Image(newMediaId, true)
            : msg.mediaType === "video"
              ? new Video(newMediaId, true)
              : msg.mediaType === "audio"
                ? new Audio(newMediaId, true)
                : new WADocument(newMediaId, true, undefined, filename);
        const result = await Whatsapp.sendMessage(WA_PHONE_ID, normalizedTo, waMessage);
        if ("error" in result && result.error) {
          logger.warn({ error: result.error }, "Forward: Whatsapp.sendMessage returned error");
          return null;
        }
        return result.messages?.[0]?.id ?? null;
      };

      // Step 1: try DB cache first
      const [cached] = await db
        .select()
        .from(whatsappMediaTable)
        .where(eq(whatsappMediaTable.waMediaId, msg.mediaId))
        .limit(1);

      if (cached) {
        logger.info({ mediaId: msg.mediaId }, "Forward: using DB-cached media");
        outboundWaId = await uploadAndSend(Buffer.from(cached.data), cached.mimeType);
      }

      // Step 2: not in cache (or send failed) — download fresh from Meta
      if (!outboundWaId) {
        logger.info({ mediaId: msg.mediaId }, "Forward: cache miss — fetching fresh from Meta");
        try {
          const metaRes = await Whatsapp.$$apiFetch$$(
            `https://graph.facebook.com/${WA_API_VERSION}/${msg.mediaId}`,
          );
          if (metaRes.ok) {
            const metaData = (await metaRes.json()) as { url?: string; mime_type?: string };
            if (metaData.url) {
              const mediaRes = await Whatsapp.$$apiFetch$$(metaData.url);
              if (mediaRes.ok) {
                const buffer = Buffer.from(await mediaRes.arrayBuffer());
                const mimeType = metaData.mime_type || msg.mimeType || "application/octet-stream";
                // Store in cache for future forwards (fire-and-forget)
                void db
                  .insert(whatsappMediaTable)
                  .values({
                    waMediaId: msg.mediaId,
                    data: buffer,
                    mimeType,
                    filename: msg.filename ?? undefined,
                  })
                  .onConflictDoNothing()
                  .catch(() => {
                    /* non-critical */
                  });
                outboundWaId = await uploadAndSend(buffer, mimeType);
              }
            }
          }
        } catch (fetchErr) {
          logger.warn({ err: fetchErr, mediaId: msg.mediaId }, "Forward: fresh Meta fetch failed");
        }
      }

      // Step 3: last resort — plain text (e.g. Meta media link expired after 30 days)
      if (!outboundWaId) {
        logger.warn(
          { mediaId: msg.mediaId },
          "Forward: all media attempts failed — sending text fallback",
        );
        outboundWaId = await sendWhatsAppText(toPhone, `↩️ مُعاد توجيهه:\n${msg.body}`);
      }
    } else {
      outboundWaId = await sendWhatsAppText(toPhone, `↩️ مُعاد توجيهه:\n${msg.body}`);
    }
  } catch (err) {
    logger.error({ err, messageId, toPhone }, "WhatsApp forward failed");
    res.status(500).json({ error: "فشل إعادة التوجيه" });
    return;
  }
  await db.insert(whatsappChatsTable).values({
    waMessageId: outboundWaId,
    direction: "outbound",
    phone: normalizedTo,
    body: msg.mediaId ? `[مُعاد توجيهه] ${msg.body}` : `↩️ مُعاد توجيهه:\n${msg.body}`,
    mediaId: null,
    mediaType: null,
    isRead: true,
  });
  broadcastWaEvent({ type: "new_message", phone: normalizedTo });
  res.json({ ok: true });
});

// ─── POST /api/whatsapp/send-media (multipart/form-data via multer) ─────────
router.post(
  "/whatsapp/send-media",
  requireAuth,
  _upload.single("file"),
  async (req, res): Promise<void> => {
    const phone = (req.body as Record<string, string>).phone;
    const supplierIdRaw = (req.body as Record<string, string>).supplierId;
    const supplierId = supplierIdRaw ? parseInt(supplierIdRaw, 10) : undefined;
    const file = req.file;
    if (!phone || !file) {
      res.status(400).json({ error: "phone and file are required" });
      return;
    }
    if (!isWhatsAppConfigured) {
      res.status(500).json({ error: "WhatsApp not configured" });
      return;
    }
    const fileMime = file.mimetype;
    const fileFilename = file.originalname || "file";
    try {
      // uploadWhatsAppMedia uses the proven $apiFetch$ authenticated method from service.ts
      const mediaId = await uploadWhatsAppMedia(file.buffer, fileFilename, fileMime);
      const mediaType = fileMime.startsWith("image/")
        ? "image"
        : fileMime.startsWith("video/")
          ? "video"
          : fileMime.startsWith("audio/")
            ? "audio"
            : "document";
      const {
        Image,
        Video,
        Audio,
        Document: WADocument,
      } = await import("whatsapp-api-js/messages");
      const message =
        mediaType === "image"
          ? new Image(mediaId, true)
          : mediaType === "video"
            ? new Video(mediaId, true)
            : mediaType === "audio"
              ? new Audio(mediaId, true)
              : new WADocument(mediaId, true, undefined, fileFilename);
      const normalized = normalizePhone(phone);
      const sendResult = await Whatsapp.sendMessage(WA_PHONE_ID, normalized, message);
      if ("error" in sendResult && sendResult.error) {
        logger.error({ sendResult }, "WhatsApp send media failed");
        res.status(500).json({ error: "فشل إرسال الملف عبر WhatsApp" });
        return;
      }
      const outboundWaId = sendResult.messages?.[0]?.id ?? null;
      const bodyText =
        mediaType === "image"
          ? `[صورة: ${fileFilename}]`
          : mediaType === "video"
            ? `[فيديو: ${fileFilename}]`
            : mediaType === "audio"
              ? `[صوت: ${fileFilename}]`
              : `[مستند: ${fileFilename}]`;
      await db.insert(whatsappChatsTable).values({
        waMessageId: outboundWaId,
        direction: "outbound",
        phone: normalized,
        supplierId: supplierId ?? null,
        body: bodyText,
        mediaId,
        mediaType,
        mimeType: fileMime,
        filename: fileFilename,
        isRead: true,
      });
      // Cache the binary so this outbound file can be forwarded later.
      // Meta does not allow re-downloading uploaded media, so we must store it ourselves.
      void db
        .insert(whatsappMediaTable)
        .values({
          waMediaId: mediaId,
          data: file.buffer,
          mimeType: fileMime,
          filename: fileFilename,
        })
        .onConflictDoNothing()
        .catch((cacheErr) =>
          logger.warn({ cacheErr, mediaId }, "send-media: failed to cache binary"),
        );
      logger.info({ phone: normalized, mediaType, filename: fileFilename }, "WhatsApp media sent");
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "Error in send-media");
      const msg = err instanceof Error ? err.message : "خطأ غير معروف";
      res.status(500).json({ error: msg });
    }
  },
);
// ─── PATCH /api/whatsapp/messages/:id ────────────────────────────────────
router.patch("/whatsapp/messages/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const { body } = req.body as { body: string };
  if (!body?.trim()) {
    res.status(400).json({ error: "body is required" });
    return;
  }
  const [updated] = await db
    .update(whatsappChatsTable)
    .set({ body: body.trim() })
    .where(eq(whatsappChatsTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(updated);
});

// ─── DELETE /api/whatsapp/messages/:id ───────────────────────────────────
router.delete("/whatsapp/messages/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const [msg] = await db
    .select()
    .from(whatsappChatsTable)
    .where(eq(whatsappChatsTable.id, id))
    .limit(1);
  if (!msg) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  let waDeletedOnPlatform = false;
  if (isWhatsAppConfigured && msg.waMessageId && msg.direction === "outbound") {
    try {
      const waDelRes = await Whatsapp.$$apiFetch$$(
        `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/messages/${msg.waMessageId}`,
        { method: "DELETE" },
      );
      const waDelData = (await waDelRes.json()) as {
        success?: boolean;
        error?: { message?: string };
      };
      if (waDelRes.ok && waDelData.success) {
        waDeletedOnPlatform = true;
        logger.info({ msgId: msg.waMessageId }, "WhatsApp message deleted for all participants");
      } else {
        logger.warn({ waDelData, msgId: msg.waMessageId }, "WhatsApp delete API rejected");
      }
    } catch (err) {
      logger.warn({ err }, "Error calling WhatsApp delete API — removing from DB only");
    }
  }
  await db.delete(whatsappChatsTable).where(eq(whatsappChatsTable.id, id));
  res.json({ ok: true, waDeletedOnPlatform });
});

// ─── GET /api/whatsapp/templates (Meta Business API templates) ────────────
router.get("/whatsapp/templates", requireAuth, async (req, res): Promise<void> => {
  const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!isWhatsAppConfigured) {
    res.status(503).json({ error: "WhatsApp not configured" });
    return;
  }
  if (!WABA_ID) {
    res
      .status(400)
      .json({ error: "WHATSAPP_BUSINESS_ACCOUNT_ID not set — يجب إضافة هذا المتغير البيئي" });
    return;
  }
  try {
    const r = await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${WABA_ID}/message_templates?limit=100&fields=name,status,quality_score,language,category,components`,
    );
    const data = (await r.json()) as { data?: unknown[]; error?: unknown; paging?: unknown };
    if (!r.ok) {
      res.status(500).json({ error: data.error || "Failed to fetch templates" });
      return;
    }
    res.json({ templates: data.data ?? [], paging: data.paging ?? null });
  } catch (err) {
    logger.error({ err }, "Failed to fetch WhatsApp templates");
    res.status(500).json({ error: "Failed to fetch templates from Meta" });
  }
});

// ─── POST /api/whatsapp/send-template ────────────────────────────────────
router.post("/whatsapp/send-template", requireAuth, async (req, res): Promise<void> => {
  const { phone, templateName, language, components, supplierId } = req.body as {
    phone: string;
    templateName: string;
    language?: string;
    components?: unknown[];
    supplierId?: number;
  };
  if (!phone || !templateName) {
    res.status(400).json({ error: "phone and templateName required" });
    return;
  }
  if (!isWhatsAppConfigured) {
    res.status(503).json({ error: "WhatsApp not configured" });
    return;
  }
  const normalized = normalizePhone(phone);
  try {
    const body = JSON.stringify({
      messaging_product: "whatsapp",
      to: normalized,
      type: "template",
      template: {
        name: templateName,
        language: { code: language || "ar" },
        components: components || [],
      },
    });
    const r = await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
    );
    const data = (await r.json()) as { messages?: Array<{ id: string }>; error?: unknown };
    if (!r.ok) {
      logger.error({ data, phone: normalized, templateName }, "WhatsApp template send failed");
      res.status(400).json({ error: data.error || "Failed to send template" });
      return;
    }
    const waId = data.messages?.[0]?.id ?? null;
    await db.insert(whatsappChatsTable).values({
      waMessageId: waId,
      direction: "outbound",
      phone: normalized,
      supplierId: supplierId ?? null,
      body: `[قالب: ${templateName}]`,
      isRead: true,
    });
    logger.info({ phone: normalized, templateName, waId }, "WhatsApp template sent");
    res.json({ ok: true, waMessageId: waId });
  } catch (err) {
    logger.error({ err, phone: normalized, templateName }, "Error sending WhatsApp template");
    res.status(500).json({ error: "Failed to send template" });
  }
});

// ─── GET /api/whatsapp/contacts ──────────────────────────────────────────
router.get("/whatsapp/contacts", requireAuth, async (req, res): Promise<void> => {
  try {
    const suppliers = await db
      .select()
      .from(suppliersTable)
      .where(eq(suppliersTable.isActive, true))
      .orderBy(suppliersTable.name);
    const withPhone = suppliers.filter((s) => s.phone && s.phone.trim());
    res.json(withPhone);
  } catch (err) {
    logger.error({ err }, "Failed to fetch WhatsApp contacts");
    res.status(500).json({ error: "Failed to fetch contacts" });
  }
});

// ─── GET /api/whatsapp/stats ──────────────────────────────────────────────
router.get("/whatsapp/stats", requireAuth, async (req, res): Promise<void> => {
  try {
    const [stats] = await db
      .select({
        total: sql<number>`COUNT(*)`,
        unread: sql<number>`COUNT(*) FILTER (WHERE ${whatsappChatsTable.direction} = 'inbound' AND ${whatsappChatsTable.isRead} = false)`,
        totalChats: sql<number>`COUNT(DISTINCT ${whatsappChatsTable.phone})`,
        outbound: sql<number>`COUNT(*) FILTER (WHERE ${whatsappChatsTable.direction} = 'outbound')`,
        inbound: sql<number>`COUNT(*) FILTER (WHERE ${whatsappChatsTable.direction} = 'inbound')`,
      })
      .from(whatsappChatsTable);
    res.json(stats);
  } catch (err) {
    logger.error({ err }, "Failed to fetch WhatsApp stats");
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ─── POST /api/whatsapp/broadcast ─────────────────────────────────────────
router.post("/whatsapp/broadcast", requireAuth, async (req, res): Promise<void> => {
  const { phones, message, supplierIds } = req.body as {
    phones: string[];
    message: string;
    supplierIds?: number[];
  };
  if (!phones?.length || !message?.trim()) {
    res.status(400).json({ error: "phones and message are required" });
    return;
  }
  if (!isWhatsAppConfigured) {
    res.status(503).json({ error: "WhatsApp not configured" });
    return;
  }

  const results: Array<{
    phone: string;
    supplierId?: number;
    ok: boolean;
    error?: string;
    waId?: string | null;
  }> = [];
  for (let i = 0; i < phones.length; i++) {
    const phone = phones[i];
    const supplierId = supplierIds?.[i];
    try {
      const waId = await sendWhatsAppText(phone, message);
      const normalized = normalizePhone(phone);
      await db.insert(whatsappChatsTable).values({
        waMessageId: waId,
        direction: "outbound",
        phone: normalized,
        supplierId: supplierId ?? null,
        body: message,
        isRead: true,
      });
      results.push({ phone, supplierId, ok: true, waId });
      logger.info({ phone: normalized, supplierId }, "Broadcast message sent");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({ phone, supplierId, ok: false, error: errMsg });
      logger.warn({ err, phone }, "Broadcast message failed for one recipient");
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;
  logger.info({ successCount, failCount, total: phones.length }, "Broadcast completed");
  res.json({ ok: true, results, successCount, failCount });
});

// ─── GET /api/whatsapp/diagnose ───────────────────────────────────────────
router.get("/whatsapp/diagnose", requireAuth, async (req, res): Promise<void> => {
  const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || "ar";
  const TEMPLATE_NAMES = [
    process.env.WHATSAPP_TEMPLATE_PDF || "rfq_pdf_ar",
    process.env.WHATSAPP_TEMPLATE_TEXT || "rfq_send_ar",
    process.env.WHATSAPP_TEMPLATE_UTILITY || "rfq_utility_ar",
  ];

  if (!isWhatsAppConfigured) {
    res.json({ configured: false, error: "Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_TOKEN" });
    return;
  }

  let phoneInfo: Record<string, unknown> = {};
  try {
    const r = await Whatsapp.$$apiFetch$$(
      `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}?fields=display_phone_number,verified_name,quality_rating,status,platform_type`,
    );
    phoneInfo = (await r.json()) as Record<string, unknown>;
  } catch (e) {
    phoneInfo = { error: String(e) };
  }

  let templates: Record<string, unknown> = {};
  if (WABA_ID) {
    try {
      const r = await Whatsapp.$$apiFetch$$(
        `https://graph.facebook.com/${WA_API_VERSION}/${WABA_ID}/message_templates?limit=30&fields=name,status,quality_score,language,category`,
      );
      const data = (await r.json()) as {
        data?: Array<{
          name: string;
          status: string;
          language: string;
          category?: string;
          quality_score?: unknown;
        }>;
      };
      const all = data.data ?? [];
      const ourTemplates = all.filter(
        (t) => TEMPLATE_NAMES.includes(t.name) || t.language === TEMPLATE_LANG,
      );
      templates = {
        total: all.length,
        our_templates: ourTemplates,
        all_names: all.map((t) => ({ name: t.name, status: t.status, lang: t.language })),
      };
    } catch (e) {
      templates = { error: String(e) };
    }
  } else {
    templates = { warning: "WHATSAPP_BUSINESS_ACCOUNT_ID not set — cannot check template status" };
  }

  const creds = {
    WHATSAPP_PHONE_NUMBER_ID: WA_PHONE_ID
      ? "✓ set (" + WA_PHONE_ID.slice(0, 5) + "...)"
      : "✗ missing",
    WHATSAPP_TOKEN: WA_TOKEN ? "✓ set (length=" + WA_TOKEN.length + ")" : "✗ missing",
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET
      ? "✓ set (signature verification enabled)"
      : "✗ missing — webhook signature verification disabled",
    WHATSAPP_BUSINESS_ACCOUNT_ID: WABA_ID
      ? "✓ set"
      : "✗ missing — add this env var to check template status",
    WHATSAPP_VERIFY_TOKEN: WEBHOOK_VERIFY_TOKEN ? "✓ set" : "✗ missing",
    template_names: TEMPLATE_NAMES,
    template_lang: TEMPLATE_LANG,
    library:
      "whatsapp-api-js v6 (open-source, official Meta Cloud API wrapper — github.com/Secreto31126/whatsapp-api-js)",
  };

  res.json({ configured: true, phone: phoneInfo, templates, creds });
});

export default router;
