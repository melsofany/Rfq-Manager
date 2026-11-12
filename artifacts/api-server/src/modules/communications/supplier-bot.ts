/**
 * WhatsApp interactive supplier bot — data + decisions.
 *
 * This module owns the ANSWERS to «what can this supplier see?» and «what does
 * their message mean?». The senders (buttons, lists, confirmations) live in
 * `communications/service.ts` and the routing lives in
 * `communications/routes.ts`; keeping the queries and the decision rules here
 * makes them testable without a WhatsApp client, and keeps one copy of each
 * rule.
 *
 * TWO RULES THAT SHAPE EVERYTHING BELOW:
 *
 *  1. A supplier may only ever see THEIR OWN requests and items. Every query is
 *     scoped by `supplierId`, and the scoping happens in the WHERE clause rather
 *     than in a filter applied afterwards — a post-filter is one early `return`
 *     away from leaking another supplier's prices.
 *
 *  2. Nothing a supplier sends becomes a price until they CONFIRM it. Their
 *     answers accumulate as drafts (see `supplier_item_drafts`); confirmation
 *     writes a real offer, still unapproved, for an employee to review.
 */
import {
  db,
  rfqTable,
  rfqItemsTable,
  sentLogTable,
  offersTable,
  offerItemsTable,
  supplierItemDraftsTable,
  supplierBotSessionsTable,
} from "@workspace/db";
import { and, eq, desc, inArray, ne } from "drizzle-orm";
import { logger } from "../../shared/logger";

/** One pricing request as the supplier sees it. */
export interface SupplierRequestView {
  rfqId: number;
  internalRfqNo: string;
  customerRfqNo: string;
  status: string;
  requiredResponseDate: string | null;
  closeDate: string | null;
  itemCount: number;
  answeredCount: number;
  employeeId: number | null;
  employeeName: string | null;
}

/**
 * Open pricing requests for a supplier — sent to them and not yet answered.
 *
 * This is deliberately NOT the same as "every request they have ever been sent":
 * a supplier scrolling a year of closed requests to find today's is the kind of
 * screen people abandon. What is listed is what still needs an answer, which is
 * exactly what the bot exists to collect.
 *
 * `supplierId` is a required argument, not an optional filter — see rule 1.
 */
export async function listSupplierOpenRequests(supplierId: number): Promise<SupplierRequestView[]> {
  try {
    const rows = await db
      .select({
        rfqId: sentLogTable.rfqId,
        internalRfqNo: rfqTable.internalRfqNo,
        customerRfqNo: rfqTable.customerRfqNo,
        status: rfqTable.status,
        requiredResponseDate: rfqTable.requiredResponseDate,
        closeDate: sentLogTable.closeDate,
        employeeId: sentLogTable.employeeId,
      })
      .from(sentLogTable)
      .innerJoin(rfqTable, eq(sentLogTable.rfqId, rfqTable.id))
      .where(
        and(
          eq(sentLogTable.supplierId, supplierId),
          eq(sentLogTable.offerSubmitted, false),
          ne(rfqTable.status, "FAILED"),
        ),
      )
      .orderBy(desc(sentLogTable.id));

    if (rows.length === 0) return [];

    // Item counts in ONE query for every request, so a supplier with 40 open
    // requests does not cost 40 round trips to draw one list.
    const rfqIds = rows.map((r) => r.rfqId);
    const items = await db
      .select({ id: rfqItemsTable.id, rfqId: rfqItemsTable.rfqId })
      .from(rfqItemsTable)
      .where(inArray(rfqItemsTable.rfqId, rfqIds));

    const counts = new Map<number, number>();
    for (const it of items) counts.set(it.rfqId, (counts.get(it.rfqId) ?? 0) + 1);

    // How many items of each request this supplier has already priced. Shown in
    // the list so they can see at a glance which request still needs work —
    // and it comes from the same drafts the item screens write, so the number
    // can never disagree with what the item list shows.
    const answered = new Map<number, number>();
    const draftRows = await db
      .select({
        rfqId: supplierItemDraftsTable.rfqId,
        unitPrice: supplierItemDraftsTable.unitPrice,
      })
      .from(supplierItemDraftsTable)
      .where(
        and(
          eq(supplierItemDraftsTable.supplierId, supplierId),
          inArray(supplierItemDraftsTable.rfqId, rfqIds),
        ),
      );
    for (const d of draftRows) {
      if (d.unitPrice != null && Number(d.unitPrice) > 0) {
        answered.set(d.rfqId, (answered.get(d.rfqId) ?? 0) + 1);
      }
    }

    return rows.map((r) => ({
      rfqId: r.rfqId,
      internalRfqNo: r.internalRfqNo,
      customerRfqNo: r.customerRfqNo,
      status: r.status,
      requiredResponseDate: r.requiredResponseDate ?? null,
      closeDate: r.closeDate ?? null,
      itemCount: counts.get(r.rfqId) ?? 0,
      answeredCount: answered.get(r.rfqId) ?? 0,
      employeeId: r.employeeId ?? null,
      employeeName: null,
    }));
  } catch (err) {
    logger.warn({ err, supplierId }, "Supplier bot: open-request lookup failed");
    return [];
  }
}

/** One line item of a request, as offered to the supplier. */
export interface SupplierItemView {
  id: number;
  lineItem: string | null;
  partNo: string | null;
  description: string;
  uom: string | null;
  qty: string | null;
  draft: {
    availability: string | null;
    unitPrice: string | null;
    currency: string | null;
    deliveryDays: number | null;
    originCountry: string | null;
    brand: string | null;
    notes: string | null;
  } | null;
}

/**
 * The items of ONE request, scoped to a supplier, together with that supplier's
 * drafts for them.
 *
 * Both are returned from ONE load so a caller cannot hold items and drafts from
 * two different moments — the confirmation screen and the write it triggers must
 * describe the same rows, and re-reading the drafts between the two is exactly
 * how a screen ends up promising something the write does not deliver.
 *
 * The scoping check is part of the query (the sent-log row must belong to this
 * supplier), so an id typed by hand — or a stale button from a request that was
 * re-sent to someone else — cannot open another supplier's line items. The
 * caller does not have to remember to check; it is not possible to call this
 * without being scoped.
 */
export async function loadSupplierRequestItemsWithDrafts(
  supplierId: number,
  rfqId: number,
): Promise<{ items: SupplierItemView[]; drafts: Map<number, SupplierItemView["draft"]> }> {
  try {
    const [allowed] = await db
      .select({ id: sentLogTable.id })
      .from(sentLogTable)
      .where(and(eq(sentLogTable.supplierId, supplierId), eq(sentLogTable.rfqId, rfqId)))
      .limit(1);
    if (!allowed) return { items: [], drafts: new Map() };

    const rows = await db
      .select()
      .from(rfqItemsTable)
      .where(eq(rfqItemsTable.rfqId, rfqId))
      .orderBy(rfqItemsTable.id);

    const drafts = await loadDrafts(supplierId, rfqId);

    const items = rows.map((r) => ({
      id: r.id,
      lineItem: r.lineItem ?? null,
      partNo: r.partNo ?? null,
      description: r.description,
      uom: r.uom ?? null,
      qty: r.qty ?? null,
      // The supplier's own draft rides along, so a menu redrawn after an
      // interruption shows «تم الرد» against the items already answered.
      draft: drafts.get(r.id) ?? null,
    }));
    return { items, drafts };
  } catch (err) {
    logger.warn({ err, supplierId, rfqId }, "Supplier bot: item lookup failed");
    return { items: [], drafts: new Map() };
  }
}

/** The items of one request, scoped to the supplier. */
export async function listSupplierRequestItems(
  supplierId: number,
  rfqId: number,
): Promise<SupplierItemView[]> {
  const { items } = await loadSupplierRequestItemsWithDrafts(supplierId, rfqId);
  return items;
}

/**
 * A pricing request must never be answerable by a supplier it was not sent to.
 *
 * Exported because the ROUTE needs it before it accepts anything: a button tap
 * carries an rfqId from an older message, and that request may have been closed
 * or re-assigned since. Re-reading the authorisation at the moment of use — not
 * only when the menu was drawn — is what makes a stale button harmless.
 */
export async function supplierMayAnswer(
  supplierId: number,
  rfqId: number,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const [log] = await db
      .select({ id: sentLogTable.id, offerSubmitted: sentLogTable.offerSubmitted })
      .from(sentLogTable)
      .where(and(eq(sentLogTable.supplierId, supplierId), eq(sentLogTable.rfqId, rfqId)))
      .limit(1);
    if (!log) return { ok: false, reason: "not_sent_to_supplier" };
    return { ok: true };
  } catch (err) {
    logger.warn({ err, supplierId, rfqId }, "Supplier bot: authorisation check failed");
    // Fail CLOSED: an unverifiable authorisation is not an authorisation.
    return { ok: false, reason: "check_failed" };
  }
}

/** The meaning of a free-text message the supplier just sent. */
export type BotStep =
  "await_price" | "await_delivery" | "await_origin" | "await_brand" | "await_notes";

export interface SessionState {
  phone: string;
  supplierId: number | null;
  rfqId: number | null;
  rfqItemId: number | null;
  step: BotStep | null;
}

/** The bot's per-phone state, or null when the supplier is not mid-flow. */
export async function loadSession(phone: string): Promise<SessionState | null> {
  try {
    const [row] = await db
      .select()
      .from(supplierBotSessionsTable)
      .where(eq(supplierBotSessionsTable.phone, phone))
      .limit(1);
    if (!row) return null;
    return {
      phone: row.phone,
      supplierId: row.supplierId ?? null,
      rfqId: row.rfqId ?? null,
      rfqItemId: row.rfqItemId ?? null,
      step: (row.step as BotStep | null) ?? null,
    };
  } catch (err) {
    logger.warn({ err, phone }, "Supplier bot: session load failed");
    return null;
  }
}

export async function saveSession(state: SessionState): Promise<void> {
  try {
    await db
      .insert(supplierBotSessionsTable)
      .values({
        phone: state.phone,
        supplierId: state.supplierId,
        rfqId: state.rfqId,
        rfqItemId: state.rfqItemId,
        step: state.step,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [supplierBotSessionsTable.phone],
        set: {
          supplierId: state.supplierId,
          rfqId: state.rfqId,
          rfqItemId: state.rfqItemId,
          step: state.step,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    logger.warn({ err, phone: state.phone }, "Supplier bot: session save failed");
  }
}

export async function clearSession(phone: string): Promise<void> {
  try {
    await db.delete(supplierBotSessionsTable).where(eq(supplierBotSessionsTable.phone, phone));
  } catch (err) {
    logger.warn({ err, phone }, "Supplier bot: session clear failed");
  }
}

/**
 * Parse a price the supplier typed.
 *
 * WhatsApp users type prices the way they write them: «120», «120.5», «1,250»,
 * «120 جنيه», «120 EGP», and — because Arabic keyboards produce them — Arabic-
 * Indic digits («١٢٠»). Rejecting those is how a bot ends up asking the same
 * question three times.
 *
 * Returns null when there is genuinely no usable number, which is the signal to
 * re-ask rather than to store a zero. A NEGATIVE value is rejected rather than
 * having its sign dropped: reading «-5» as «5» invents a price the supplier did
 * not state, and a minus in a price field almost always means they mistyped
 * something else entirely.
 */
export function parsePrice(raw: string): number | null {
  const western = (raw || "")
    // Arabic-Indic and Extended Arabic-Indic digits → ASCII.
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  const match = western.match(/-?\d[\d,\s]*(?:\.\d+)?/);
  if (!match) return null;
  if (match[0].trimStart().startsWith("-")) return null;
  const cleaned = match[0].replace(/[,\s]/g, "");
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** Parse a delivery duration in days from free text («3», «3 أيام», «٣»). */
export function parseDeliveryDays(raw: string): number | null {
  const n = parsePrice(raw);
  if (n == null) return null;
  const days = Math.round(n);
  if (days <= 0 || days > 3650) return null;
  return days;
}

/** Recognise «متاح» / «غير متاح» in the many ways it gets typed. */
export function parseAvailability(raw: string): "available" | "unavailable" | null {
  const t = (raw || "").trim().toLowerCase();
  if (!t) return null;
  // Order matters: check the NEGATIVE first, because «غير متاح» contains «متاح».
  if (/(غير\s*متاح|مش\s*متاح|لا\s*يوجد|not\s*avail|unavail|مرفوض)/i.test(t)) return "unavailable";
  if (/(متاح|موجود|available|avail|✓)/i.test(t)) return "available";
  return null;
}

/**
 * The next question after a step, or null when the item's fields are complete.
 *
 * A fixed ladder rather than a form: WhatsApp has no form control, and asking
 * everything at once produces a paragraph the supplier answers in one garbled
 * line. Each answer advances exactly one step, so an interrupted flow resumes at
 * the right question.
 */
export const STEP_ORDER: BotStep[] = [
  "await_price",
  "await_delivery",
  "await_origin",
  "await_brand",
  "await_notes",
];

export function stepPrompt(step: BotStep, itemLabel: string): string {
  switch (step) {
    case "await_price":
      return `💰 سعر الوحدة للبند:\n${itemLabel}\n\nاكتب السعر بالأرقام فقط (مثال: 120).`;
    case "await_delivery":
      return `🚚 مدة التوريد بالأيام للبند:\n${itemLabel}\n\nاكتب عدد الأيام (مثال: 7).`;
    case "await_origin":
      return `🌍 بلد المنشأ للبند:\n${itemLabel}\n\nاكتب بلد المنشأ، أو «تخطي».`;
    case "await_brand":
      return `🏷️ العلامة التجارية للبند:\n${itemLabel}\n\nاكتب العلامة، أو «تخطي».`;
    case "await_notes":
      return `📝 ملاحظات إضافية للبند:\n${itemLabel}\n\nاكتب ملاحظتك، أو «تخطي».`;
  }
}

/** «تخطي» / «skip» — advance without answering the optional step. */
export function isSkip(raw: string): boolean {
  return /^(تخطي|تخطى|تجاوز|لا|skip|-|—|بدون)$/i.test((raw || "").trim());
}

// ── Draft persistence ────────────────────────────────────────────────────────

export interface DraftPatch {
  availability?: string | null;
  unitPrice?: number | null;
  currency?: string | null;
  deliveryDays?: number | null;
  originCountry?: string | null;
  brand?: string | null;
  notes?: string | null;
  attachmentMediaId?: string | null;
  attachmentName?: string | null;
}

/**
 * Merge one answer into the item's draft.
 *
 * An UPSERT on the (rfq, item, supplier) triple, and only the fields actually
 * supplied are written: leaving the others out of the `set` is what lets the
 * supplier answer «السعر» now and «مدة التوريد» on a later message without the
 * second write erasing the first. Passing an explicit null still clears a field,
 * which is why the patch type distinguishes "absent" from "null".
 */
export async function upsertDraft(
  supplierId: number,
  rfqId: number,
  rfqItemId: number,
  patch: DraftPatch,
): Promise<void> {
  const now = new Date();
  // ONE representation for both paths. Building the insert row and then deriving
  // the conflict `set` from it is what keeps them from drifting: writing
  // `String(price)` on insert and the raw number in the `set` gives the same
  // column two shapes depending on whether the row existed.
  //
  // The types are the table's own inferred insert/update shapes rather than a
  // bare `Record`, so a column renamed in the schema is a compile error here
  // instead of a value that silently stops being written.
  type DraftRow = typeof supplierItemDraftsTable.$inferInsert;
  const row: DraftRow = {
    rfqId,
    rfqItemId,
    supplierId,
    availability: patch.availability ?? null,
    unitPrice: patch.unitPrice != null ? String(patch.unitPrice) : null,
    currency: patch.currency ?? null,
    deliveryDays: patch.deliveryDays ?? null,
    originCountry: patch.originCountry ?? null,
    brand: patch.brand ?? null,
    notes: patch.notes ?? null,
    attachmentMediaId: patch.attachmentMediaId ?? null,
    attachmentName: patch.attachmentName ?? null,
    updatedAt: now,
  };
  const set: Partial<DraftRow> = { updatedAt: now };
  for (const key of Object.keys(patch) as Array<keyof DraftPatch>) {
    // Only fields actually supplied are updated, so an answer given now does not
    // erase one given in an earlier message. `row` holds the converted value, so
    // the `set` can never disagree with what an insert would have written.
    if (patch[key] !== undefined) {
      (set as Record<string, unknown>)[key] = (row as Record<string, unknown>)[key];
    }
  }
  try {
    await db
      .insert(supplierItemDraftsTable)
      .values(row)
      .onConflictDoUpdate({
        target: [
          supplierItemDraftsTable.rfqId,
          supplierItemDraftsTable.rfqItemId,
          supplierItemDraftsTable.supplierId,
        ],
        set,
      });
  } catch (err) {
    logger.warn({ err, supplierId, rfqId, rfqItemId }, "Supplier bot: draft write failed");
    throw err;
  }
}

/** Every draft this supplier has for a request, keyed by item id. */
export async function loadDrafts(
  supplierId: number,
  rfqId: number,
): Promise<Map<number, SupplierItemView["draft"]>> {
  const map = new Map<number, SupplierItemView["draft"]>();
  try {
    const rows = await db
      .select()
      .from(supplierItemDraftsTable)
      .where(
        and(
          eq(supplierItemDraftsTable.supplierId, supplierId),
          eq(supplierItemDraftsTable.rfqId, rfqId),
        ),
      );
    for (const r of rows) {
      map.set(r.rfqItemId, {
        availability: r.availability ?? null,
        unitPrice: r.unitPrice != null ? String(r.unitPrice) : null,
        currency: r.currency ?? null,
        deliveryDays: r.deliveryDays ?? null,
        originCountry: r.originCountry ?? null,
        brand: r.brand ?? null,
        notes: r.notes ?? null,
      });
    }
  } catch (err) {
    logger.warn({ err, supplierId, rfqId }, "Supplier bot: draft load failed");
  }
  return map;
}

export interface DraftSummary {
  answered: Array<{
    rfqItemId: number;
    label: string;
    price: string | null;
    availability: string | null;
  }>;
  unanswered: Array<{ rfqItemId: number; label: string }>;
  pricedCount: number;
  totalCount: number;
}

/**
 * Split items into answered / outstanding.
 *
 * PURE, and exported, because this one rule decides three separate screens (the
 * item list's ✅/⬜ marker, the confirmation summary, and what `confirmDrafts`
 * writes). Three copies of «is this item answered?» is how a screen ends up
 * disagreeing with what was actually saved.
 *
 * Answered means PRICED. A draft row exists the moment the supplier taps
 * «متاح», so keying on the row would report an item as answered with no price —
 * and the confirmation screen would then claim a completeness that is not there.
 */
export function classifyDrafts(
  items: SupplierItemView[],
  drafts: Map<number, SupplierItemView["draft"]>,
): DraftSummary {
  const answered: DraftSummary["answered"] = [];
  const unanswered: DraftSummary["unanswered"] = [];
  for (const it of items) {
    const label = itemLabel(it);
    const d = drafts.get(it.id);
    const price = d?.unitPrice != null && Number(d.unitPrice) > 0 ? d.unitPrice : null;
    if (price != null) {
      answered.push({
        rfqItemId: it.id,
        label,
        price,
        availability: d?.availability ?? null,
      });
    } else {
      unanswered.push({ rfqItemId: it.id, label });
    }
  }
  return { answered, unanswered, pricedCount: answered.length, totalCount: items.length };
}

/** What the supplier has answered so far, and what is still outstanding. */
export async function summariseDrafts(supplierId: number, rfqId: number): Promise<DraftSummary> {
  const { items, drafts } = await loadSupplierRequestItemsWithDrafts(supplierId, rfqId);
  return classifyDrafts(items, drafts);
}

/** A short, human label for an item — part number first, then the description. */
export function itemLabel(it: {
  partNo?: string | null;
  lineItem?: string | null;
  description: string;
}): string {
  const code = it.partNo?.trim() || it.lineItem?.trim();
  const desc = (it.description || "").trim();
  const short = desc.length > 60 ? `${desc.slice(0, 57)}…` : desc;
  return code ? `${code} — ${short}` : short;
}

// ── Confirmation: drafts → a real (unapproved) offer ─────────────────────────

export interface ConfirmResult {
  ok: boolean;
  offerId?: number;
  savedItems?: number;
  reason?: string;
  /** Approved lines whose price the supplier restated, so the approval was released. */
  approvalsCleared?: number;
}

/**
 * Write the supplier's drafts into a real offer.
 *
 * The offer is stored UNAPPROVED — `offer_items.is_approved` stays false — so it
 * appears in the employee's review screen as a supplier submission and nothing
 * more. A WhatsApp message is not a signed quotation, and treating it as an
 * approved price would push an unreviewed figure into the customer margin
 * calculation.
 *
 * Only items with a price > 0 are written: an item the supplier marked
 * «غير متاح», or left blank, is not a zero-price offer. Writing a 0 would drag
 * every average down and is indistinguishable from a real zero quote.
 *
 * The whole write is one transaction: a partially written offer (header without
 * its items, or half the items) is worse than no offer, because the employee
 * would review and approve an incomplete price list.
 */
export async function confirmDrafts(
  supplierId: number,
  rfqId: number,
  opts: { employeeId?: number | null } = {},
): Promise<ConfirmResult> {
  // Items and drafts are loaded ONCE and shared with the classification, so the
  // rows written are exactly the rows the confirmation screen showed.
  const { items, drafts } = await loadSupplierRequestItemsWithDrafts(supplierId, rfqId);
  const summary = classifyDrafts(items, drafts);
  if (summary.pricedCount === 0) {
    return { ok: false, reason: "no_priced_items" };
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [log] = await tx
        .select({ id: sentLogTable.id, employeeId: sentLogTable.employeeId })
        .from(sentLogTable)
        .where(and(eq(sentLogTable.supplierId, supplierId), eq(sentLogTable.rfqId, rfqId)))
        .limit(1);

      const [existing] = await tx
        .select({ id: offersTable.id, employeeId: offersTable.employeeId })
        .from(offersTable)
        .where(and(eq(offersTable.rfqId, rfqId), eq(offersTable.supplierId, supplierId)))
        .orderBy(desc(offersTable.id))
        .limit(1);

      const priced = summary.answered;
      const totalPrice = priced.reduce((sum, a) => sum + Number(a.price ?? 0), 0);

      let offerId: number;
      if (existing) {
        await tx
          .update(offersTable)
          .set({
            totalPrice: String(totalPrice),
            employeeId: opts.employeeId ?? log?.employeeId ?? existing.employeeId ?? null,
          })
          .where(eq(offersTable.id, existing.id));
        offerId = existing.id;
      } else {
        const [created] = await tx
          .insert(offersTable)
          .values({
            rfqId,
            supplierId,
            sentLogId: log?.id ?? null,
            employeeId: opts.employeeId ?? log?.employeeId ?? null,
            totalPrice: String(totalPrice),
            generalNotes: "أُرسل عبر بوت واتساب — بانتظار مراجعة الموظف",
          })
          .returning();
        offerId = created.id;
      }

      // Existing lines are matched and UPDATED in place; only genuinely new
      // items are inserted, and NOTHING is deleted.
      //
      // This used to `DELETE FROM offer_items WHERE offer_id = ...` and re-insert
      // every line. That silently destroyed two things an employee owns:
      //   * `is_approved` — the approved supplier price, which is the reference
      //     cost the customer-rfq margin check and the RFQ KPIs read;
      //   * `purchase_order_items.offer_item_id`, which is `ON DELETE SET NULL`,
      //     so every PO line raised from this offer lost its link to it.
      // A supplier restating their own prices is not entitled to un-approve a
      // price or to detach a purchase order. Same rule as `customer_rfq_items`
      // and `customer_po_items`: never delete-and-reinsert a referenced row.
      const priorItems = await tx
        .select({
          id: offerItemsTable.id,
          rfqItemId: offerItemsTable.rfqItemId,
          price: offerItemsTable.price,
          isApproved: offerItemsTable.isApproved,
        })
        .from(offerItemsTable)
        .where(eq(offerItemsTable.offerId, offerId));
      const priorByItem = new Map(priorItems.map((r) => [r.rfqItemId, r]));

      let approvalCleared = 0;
      for (const a of priced) {
        const d = drafts.get(a.rfqItemId);
        const notes = [
          d?.originCountry ? `بلد المنشأ: ${d.originCountry}` : null,
          d?.brand ? `العلامة: ${d.brand}` : null,
          d?.currency ? `العملة: ${d.currency}` : null,
          d?.notes ?? null,
        ]
          .filter(Boolean)
          .join(" | ");
        const price = String(a.price);
        const prior = priorByItem.get(a.rfqItemId);

        if (prior) {
          // An approval is an approval OF A PRICE. If the supplier restates the
          // price, the approval no longer describes the quoted figure and must
          // not stay behind as a silently-wrong reference cost — the employee
          // re-approves. An unchanged price keeps its approval untouched.
          const priceChanged = Number(prior.price) !== Number(price);
          const clearApproval = priceChanged && prior.isApproved;
          if (clearApproval) approvalCleared += 1;
          await tx
            .update(offerItemsTable)
            .set({
              price,
              taxIncluded: false,
              deliveryDays: d?.deliveryDays ?? null,
              notes: notes || null,
              ...(clearApproval ? { isApproved: false } : {}),
            })
            .where(eq(offerItemsTable.id, prior.id));
        } else {
          await tx.insert(offerItemsTable).values({
            offerId,
            rfqItemId: a.rfqItemId,
            price,
            taxIncluded: false,
            deliveryDays: d?.deliveryDays ?? null,
            notes: notes || null,
          });
        }
      }

      await tx
        .update(sentLogTable)
        .set({ offerSubmitted: true })
        .where(and(eq(sentLogTable.supplierId, supplierId), eq(sentLogTable.rfqId, rfqId)));

      const [rfq] = await tx
        .select({ status: rfqTable.status })
        .from(rfqTable)
        .where(eq(rfqTable.id, rfqId))
        .limit(1);
      if (rfq?.status === "SENT") {
        await tx.update(rfqTable).set({ status: "QUOTED" }).where(eq(rfqTable.id, rfqId));
      }

      return { offerId, savedItems: priced.length, approvalCleared };
    });

    return {
      ok: true,
      offerId: result.offerId,
      savedItems: result.savedItems,
      approvalsCleared: result.approvalCleared,
    };
  } catch (err) {
    logger.error({ err, supplierId, rfqId }, "Supplier bot: confirm failed");
    return { ok: false, reason: "write_failed" };
  }
}
