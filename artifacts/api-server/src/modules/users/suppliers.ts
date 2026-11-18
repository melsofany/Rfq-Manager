import { guardFor } from "../../shared/permissions";
import { Router } from "express";
import {
  db,
  suppliersTable,
  sentLogTable,
  offersTable,
  offerItemsTable,
  purchaseOrderItemsTable,
  purchaseOrdersTable,
  poItemReceiptsTable,
  customerPoItemsTable,
  customerPosTable,
  rfqTable,
  supplierCategoryLinksTable,
  supplierCategoriesTable,
  itemCategoriesTable,
} from "@workspace/db";
import { eq, ilike, or, and, ne, count, sql, inArray } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { logger } from "../../shared/logger";
import { isForeignKeyViolation } from "../../shared/pg-errors";
import { missingRegistrationFields } from "../../shared/supplier-registration";
import {
  categoriesToStored,
  loadSupplierCategoryMap,
  saveSupplierCategoryLinks,
  nonLeafCategoryNames,
} from "../../shared/supplier-category-links";
import { descendantIds } from "../../shared/category-tree";
import {
  saveSupplierItemCategoryLinks,
  suppliersForItemCategories,
} from "../../shared/supplier-item-category-links";
import {
  loadSupplierItemCategoryEvidenceMap,
  suppliersWithHistoryForCategories,
  supplierItemCategoryEvidence,
} from "../../shared/supplier-item-category-history";

const router = Router();
router.use("/suppliers", guardFor("/suppliers"));

function toArray(cat: string | null | undefined): string[] {
  if (!cat) return [];
  return cat
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function toStored(cats: string | string[]): string {
  if (Array.isArray(cats))
    return cats
      .map((s) => s.trim())
      .filter(Boolean)
      .join(",");
  return String(cats).trim();
}

// بيانات السجل التجاري والضريبي والبنكية للمورد — تُعاد كاملة في كل استجابة
const REGISTRATION_FIELDS = [
  "commercialRegister",
  "taxRegistration",
  "bankName",
  "bankAccountHolder",
  "bankAccountNumber",
  "iban",
  "swiftCode",
  "bankBranch",
] as const;

function serializeSupplier(s: typeof suppliersTable.$inferSelect) {
  return {
    id: s.id,
    supplierId: s.supplierId,
    name: s.name,
    contactPerson: s.contactPerson,
    email: s.email,
    phone: s.phone,
    address: s.address,
    category: s.category,
    categories: toArray(s.category),
    isActive: s.isActive,
    invoiceHasVat: s.invoiceHasVat,
    ...Object.fromEntries(REGISTRATION_FIELDS.map((k) => [k, s[k]])),
    // The supplier confirmed this data himself through the one-time link.
    // `registrationComplete` is derived (never stored) so the page and the PO
    // dispatch gate cannot disagree about whether he can be paid.
    registrationVerifiedAt: s.registrationVerifiedAt?.toISOString() ?? null,
    registrationComplete: missingRegistrationFields(s).length === 0,
    registrationMissingFields: missingRegistrationFields(s),
    createdAt: s.createdAt.toISOString(),
  };
}

// إلغاء تفعيل المورد تلقائيًا عند بلوغ هذا العدد من الإرسالات دون أي رد
const AUTO_DEACTIVATE_AFTER = 10;

// ─── حساب تقييم المورد ─────────────────────────────────────────────────────
// Every component score is null when the underlying data is missing — no
// fabricated defaults. The total is a weighted average over only the available
// components, and null when there is no data at all.
// ─── Pure score derivation ─────────────────────────────────────────────────
// The ONE place the weighting lives. Both the single-supplier endpoint and the
// batched list endpoint call this, so they can never report different scores
// for the same supplier. Every component is null when its data is missing — no
// fabricated defaults; the total is a weighted average over available parts.
function deriveScore(m: {
  totalRfqsReceived: number;
  totalOffersSubmitted: number;
  avgResponseHours: number | null;
  totalItemsOffered: number;
  avgPriceDelta: number | null;
  wins: number;
  acceptedQty: number;
  rejectedQty: number;
  avgDeliveryDays: number | null;
}) {
  const responseRate =
    m.totalRfqsReceived > 0
      ? Math.round((m.totalOffersSubmitted / m.totalRfqsReceived) * 1000) / 10
      : null;
  const commitmentScore = responseRate !== null ? Math.min(100, Math.round(responseRate)) : null;

  let responseSpeedScore: number | null = null;
  if (m.avgResponseHours !== null) {
    if (m.avgResponseHours < 4) responseSpeedScore = 100;
    else if (m.avgResponseHours < 8) responseSpeedScore = 90;
    else if (m.avgResponseHours < 24) responseSpeedScore = 75;
    else if (m.avgResponseHours < 48) responseSpeedScore = 60;
    else if (m.avgResponseHours < 72) responseSpeedScore = 45;
    else if (m.avgResponseHours < 168) responseSpeedScore = 30;
    else responseSpeedScore = 15;
  }

  let priceScore: number | null = null;
  if (m.avgPriceDelta !== null) {
    // -20% أو أقل = 100، 0% = 70، +20% أو أكثر = 40
    const d = m.avgPriceDelta;
    if (d <= -20) priceScore = 100;
    else if (d <= 0) priceScore = Math.round(70 + (Math.abs(d) / 20) * 30);
    else if (d <= 20) priceScore = Math.round(70 - (d / 20) * 30);
    else priceScore = 40;
    priceScore = Math.max(0, Math.min(100, priceScore));
  }

  const winScore =
    m.totalItemsOffered > 0 ? Math.round((m.wins / m.totalItemsOffered) * 100) : null;

  const receiptQualityScore =
    m.acceptedQty + m.rejectedQty > 0
      ? Math.round((m.acceptedQty / (m.acceptedQty + m.rejectedQty)) * 100)
      : null;

  let deliveryScore: number | null = null;
  if (m.avgDeliveryDays !== null) {
    if (m.avgDeliveryDays <= 7) deliveryScore = 100;
    else if (m.avgDeliveryDays <= 14) deliveryScore = 85;
    else if (m.avgDeliveryDays <= 30) deliveryScore = 70;
    else if (m.avgDeliveryDays <= 60) deliveryScore = 55;
    else deliveryScore = 35;
  }

  const components = [
    { score: commitmentScore, weight: 0.25 },
    { score: responseSpeedScore, weight: 0.15 },
    { score: priceScore, weight: 0.2 },
    { score: winScore, weight: 0.2 },
    { score: receiptQualityScore, weight: 0.2 },
    { score: deliveryScore, weight: 0.1 },
  ];
  let totalScore: number | null = null;
  let rating: number | null = null;
  const available = components.filter((c) => c.score !== null) as {
    score: number;
    weight: number;
  }[];
  const weightSum = available.reduce((a, c) => a + c.weight, 0);
  if (weightSum > 0) {
    totalScore = Math.round(available.reduce((a, c) => a + c.score * c.weight, 0) / weightSum);
    rating = Math.round((totalScore / 100) * 5 * 10) / 10;
  }

  return {
    totalRfqsReceived: m.totalRfqsReceived,
    totalOffersSubmitted: m.totalOffersSubmitted,
    responseRate,
    commitmentScore,
    avgResponseHours: m.avgResponseHours,
    responseSpeedScore,
    avgPriceDelta: m.avgPriceDelta,
    priceScore,
    totalItemsOffered: m.totalItemsOffered,
    wins: m.wins,
    winScore,
    acceptedQty: m.acceptedQty,
    rejectedQty: m.rejectedQty,
    receiptQualityScore,
    avgDeliveryDays: m.avgDeliveryDays,
    deliveryScore,
    totalScore,
    rating,
  };
}

type SupplierScore = ReturnType<typeof deriveScore>;

// Batched: all suppliers' score metrics in ~8 queries instead of 7 per supplier
// (≈390 suppliers × 7 ≈ 2,700 round trips → 29 s against production).
async function computeAllSupplierScores(
  supplierIds: number[],
): Promise<Map<number, SupplierScore>> {
  const out = new Map<number, SupplierScore>();
  if (supplierIds.length === 0) return out;

  const [
    sentRows,
    offerRows,
    itemsOfferedRows,
    winsRows,
    receiptRows,
    responseRes,
    priceRes,
    deliveryRes,
  ] = await Promise.all([
    db
      .select({ supplierId: sentLogTable.supplierId, cnt: count() })
      .from(sentLogTable)
      .where(inArray(sentLogTable.supplierId, supplierIds))
      .groupBy(sentLogTable.supplierId),
    db
      .select({ supplierId: offersTable.supplierId, cnt: count() })
      .from(offersTable)
      .where(inArray(offersTable.supplierId, supplierIds))
      .groupBy(offersTable.supplierId),
    db
      .select({ supplierId: offersTable.supplierId, cnt: count() })
      .from(offerItemsTable)
      .leftJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
      .where(inArray(offersTable.supplierId, supplierIds))
      .groupBy(offersTable.supplierId),
    db
      .select({ supplierId: purchaseOrderItemsTable.supplierId, cnt: count() })
      .from(purchaseOrderItemsTable)
      .where(inArray(purchaseOrderItemsTable.supplierId, supplierIds))
      .groupBy(purchaseOrderItemsTable.supplierId),
    db
      .select({
        supplierId: purchaseOrderItemsTable.supplierId,
        accepted: sql<string | null>`sum(${purchaseOrderItemsTable.totalAcceptedQty})`,
        rejected: sql<string | null>`sum(${purchaseOrderItemsTable.totalRejectedQty})`,
      })
      .from(purchaseOrderItemsTable)
      .where(inArray(purchaseOrderItemsTable.supplierId, supplierIds))
      .groupBy(purchaseOrderItemsTable.supplierId),
    db.execute(sql`
        SELECT o.supplier_id AS supplier_id,
               AVG(EXTRACT(EPOCH FROM (o.created_at - sl.created_at)) / 3600)
                 FILTER (WHERE EXTRACT(EPOCH FROM (o.created_at - sl.created_at)) / 3600 >= 0
                           AND EXTRACT(EPOCH FROM (o.created_at - sl.created_at)) / 3600 < 8760)
                 AS avg_hours
        FROM offers o
        JOIN sent_log sl ON o.sent_log_id = sl.id
        WHERE o.supplier_id IN ${supplierIds}
          AND o.sent_log_id IS NOT NULL
          AND sl.created_at IS NOT NULL
        GROUP BY o.supplier_id
      `),
    db.execute(sql`
        SELECT o.supplier_id AS supplier_id,
               AVG((oi.price::numeric - market.avg_price) / market.avg_price * 100) AS avg_delta
        FROM offer_items oi
        JOIN offers o ON oi.offer_id = o.id
        JOIN (
          SELECT oi2.rfq_item_id, AVG(oi2.price::numeric) AS avg_price
          FROM offer_items oi2
          GROUP BY oi2.rfq_item_id
        ) market ON market.rfq_item_id = oi.rfq_item_id
        WHERE o.supplier_id IN ${supplierIds}
          AND market.avg_price > 0
        GROUP BY o.supplier_id
      `),
    db.execute(sql`
        SELECT poi.supplier_id AS supplier_id,
               AVG(EXTRACT(EPOCH FROM (r.received_at - po.created_at)) / 86400) AS avg_days,
               COUNT(*) AS cnt
        FROM po_item_receipts r
        JOIN purchase_orders po ON r.po_id = po.id
        JOIN purchase_order_items poi ON r.po_item_id = poi.id
        WHERE poi.supplier_id IN ${supplierIds}
        GROUP BY poi.supplier_id
      `),
  ]);

  const sentBy = new Map<number, number>();
  for (const r of sentRows) if (r.supplierId != null) sentBy.set(r.supplierId, Number(r.cnt));
  const offersBy = new Map<number, number>();
  for (const r of offerRows) if (r.supplierId != null) offersBy.set(r.supplierId, Number(r.cnt));
  const itemsOfferedBy = new Map<number, number>();
  for (const r of itemsOfferedRows)
    if (r.supplierId != null) itemsOfferedBy.set(r.supplierId, Number(r.cnt));
  const winsBy = new Map<number, number>();
  for (const r of winsRows) if (r.supplierId != null) winsBy.set(r.supplierId, Number(r.cnt));
  const receiptBy = new Map<number, { accepted: number; rejected: number }>();
  for (const r of receiptRows)
    if (r.supplierId != null)
      receiptBy.set(r.supplierId, {
        accepted: r.accepted ? parseFloat(r.accepted) : 0,
        rejected: r.rejected ? parseFloat(r.rejected) : 0,
      });
  const responseBy = new Map<number, number>();
  for (const r of responseRes.rows as { supplier_id: number; avg_hours: string | null }[])
    if (r.avg_hours != null)
      responseBy.set(Number(r.supplier_id), Math.round(parseFloat(r.avg_hours) * 10) / 10);
  const priceBy = new Map<number, number>();
  for (const r of priceRes.rows as { supplier_id: number; avg_delta: string | null }[]) {
    const d = r.avg_delta != null ? parseFloat(r.avg_delta) : NaN;
    if (Number.isFinite(d)) priceBy.set(Number(r.supplier_id), Math.round(d * 10) / 10);
  }
  const deliveryBy = new Map<number, number>();
  for (const r of deliveryRes.rows as {
    supplier_id: number;
    avg_days: string | null;
    cnt: string;
  }[]) {
    if (Number(r.cnt) > 0 && r.avg_days != null)
      deliveryBy.set(Number(r.supplier_id), Math.round(parseFloat(r.avg_days)));
  }

  for (const id of supplierIds) {
    const receipt = receiptBy.get(id) ?? { accepted: 0, rejected: 0 };
    out.set(
      id,
      deriveScore({
        totalRfqsReceived: sentBy.get(id) ?? 0,
        totalOffersSubmitted: offersBy.get(id) ?? 0,
        avgResponseHours: responseBy.get(id) ?? null,
        totalItemsOffered: itemsOfferedBy.get(id) ?? 0,
        avgPriceDelta: priceBy.get(id) ?? null,
        wins: winsBy.get(id) ?? 0,
        acceptedQty: receipt.accepted,
        rejectedQty: receipt.rejected,
        avgDeliveryDays: deliveryBy.get(id) ?? null,
      }),
    );
  }
  return out;
}

// Single-supplier score (detail endpoint) — fetches the same metrics for one
// supplier and derives through the SAME pure function as the batched path.
async function computeSupplierScore(supplierId: number) {
  const [sentStats] = await db
    .select({ total: count() })
    .from(sentLogTable)
    .where(eq(sentLogTable.supplierId, supplierId));
  const [offerStats] = await db
    .select({ total: count() })
    .from(offersTable)
    .where(eq(offersTable.supplierId, supplierId));
  const totalRfqsReceived = Number(sentStats?.total ?? 0);
  const totalOffersSubmitted = Number(offerStats?.total ?? 0);

  const responseTimeRows = await db.execute(sql`
      SELECT EXTRACT(EPOCH FROM (o.created_at - sl.created_at)) / 3600 AS hours
      FROM offers o
      JOIN sent_log sl ON o.sent_log_id = sl.id
      WHERE o.supplier_id = ${supplierId}
        AND sl.created_at IS NOT NULL
        AND o.sent_log_id IS NOT NULL
    `);
  const responseTimes = (responseTimeRows.rows as { hours: string }[])
    .map((r) => parseFloat(r.hours))
    .filter((h) => h >= 0 && h < 8760); // استثناء القيم الشاذة (> سنة)
  const avgResponseHours =
    responseTimes.length > 0
      ? Math.round((responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) * 10) / 10
      : null;

  const [itemsOfferedRow] = await db
    .select({ cnt: count() })
    .from(offerItemsTable)
    .leftJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
    .where(eq(offersTable.supplierId, supplierId));
  const totalItemsOffered = Number(itemsOfferedRow?.cnt ?? 0);

  let avgPriceDelta: number | null = null;
  if (totalItemsOffered > 0) {
    const priceDeviationRows = await db.execute(sql`
        SELECT AVG((oi.price::numeric - market.avg_price) / market.avg_price * 100) AS avg_delta
        FROM offer_items oi
        JOIN offers o ON oi.offer_id = o.id
        JOIN (
          SELECT oi2.rfq_item_id, AVG(oi2.price::numeric) AS avg_price
          FROM offer_items oi2
          GROUP BY oi2.rfq_item_id
        ) market ON market.rfq_item_id = oi.rfq_item_id
        WHERE o.supplier_id = ${supplierId}
          AND market.avg_price > 0
      `);
    const rawDelta = priceDeviationRows.rows[0]
      ? parseFloat(String((priceDeviationRows.rows[0] as { avg_delta: string }).avg_delta ?? ""))
      : NaN;
    avgPriceDelta = Number.isFinite(rawDelta) ? Math.round(rawDelta * 10) / 10 : null;
  }

  const [winsRow] = await db
    .select({ cnt: count() })
    .from(purchaseOrderItemsTable)
    .where(eq(purchaseOrderItemsTable.supplierId, supplierId));
  const wins = Number(winsRow?.cnt ?? 0);

  const [receiptRow] = await db
    .select({
      accepted: sql<string | null>`sum(${purchaseOrderItemsTable.totalAcceptedQty})`,
      rejected: sql<string | null>`sum(${purchaseOrderItemsTable.totalRejectedQty})`,
    })
    .from(purchaseOrderItemsTable)
    .where(eq(purchaseOrderItemsTable.supplierId, supplierId));
  const acceptedQty = receiptRow?.accepted ? parseFloat(receiptRow.accepted) : 0;
  const rejectedQty = receiptRow?.rejected ? parseFloat(receiptRow.rejected) : 0;

  const [deliveryRow] = await db
    .select({
      avg: sql<
        string | null
      >`avg(extract(epoch from (${poItemReceiptsTable.receivedAt} - ${purchaseOrdersTable.createdAt})) / 86400)`,
      cnt: count(),
    })
    .from(poItemReceiptsTable)
    .innerJoin(purchaseOrdersTable, eq(poItemReceiptsTable.poId, purchaseOrdersTable.id))
    .innerJoin(
      purchaseOrderItemsTable,
      eq(poItemReceiptsTable.poItemId, purchaseOrderItemsTable.id),
    )
    .where(eq(purchaseOrderItemsTable.supplierId, supplierId));
  const receiptCount = Number(deliveryRow?.cnt ?? 0);
  const avgDeliveryDays =
    receiptCount > 0 && deliveryRow?.avg ? Math.round(parseFloat(String(deliveryRow.avg))) : null;

  return deriveScore({
    totalRfqsReceived,
    totalOffersSubmitted,
    avgResponseHours,
    totalItemsOffered,
    avgPriceDelta,
    wins,
    acceptedQty,
    rejectedQty,
    avgDeliveryDays,
  });
}

// ─── Routes ────────────────────────────────────────────────────────────────

// ─── Bulk Import ───────────────────────────────────────────────────────────
router.post("/suppliers/bulk", requireAuth, async (req, res): Promise<void> => {
  const { suppliers } = req.body as { suppliers?: unknown[] };

  if (!Array.isArray(suppliers) || suppliers.length === 0) {
    res.status(400).json({ error: "suppliers array required" });
    return;
  }

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  const details: Array<{
    row: number;
    name: string;
    status: "imported" | "skipped" | "error";
    reason: string | null;
    supplier?: Record<string, unknown>;
  }> = [];

  for (let i = 0; i < suppliers.length; i++) {
    const row = suppliers[i] as Record<string, unknown>;
    const name = String(row.name ?? "").trim();
    const rawCats = row.categories ?? row.category;
    const category = rawCats ? toStored(rawCats as string | string[]) : "general";

    // Same leaf-only rule, reported PER ROW so an import cannot file a supplier
    // under a parent unnoticed. The row is skipped with a reason, never
    // half-imported.
    const nonLeaf = await nonLeafCategoryNames(toArray(category));
    if (nonLeaf.length > 0) {
      skipped++;
      details.push({
        row: i + 1,
        name,
        status: "skipped",
        reason: `تصنيف رئيسي له فروع: ${nonLeaf.join("، ")} — اختر تصنيفًا فرعيًا`,
      });
      continue;
    }

    if (!name) {
      errors++;
      details.push({
        row: i + 1,
        name: name || "(بدون اسم)",
        status: "error",
        reason: "الاسم مطلوب",
      });
      continue;
    }

    const email = row.email ? String(row.email).trim() : null;
    const phone = row.phone ? String(row.phone).trim() : null;

    // Check duplicate email
    if (email) {
      const [existingEmail] = await db
        .select()
        .from(suppliersTable)
        .where(ilike(suppliersTable.email, email))
        .limit(1);
      if (existingEmail) {
        skipped++;
        details.push({
          row: i + 1,
          name,
          status: "skipped",
          reason: `الإيميل مسجل بالفعل للمورد: ${existingEmail.name}`,
        });
        continue;
      }
    }

    // Check duplicate phone
    if (phone) {
      const cleaned = phone.replace(/\s+/g, "");
      const [existingPhone] = await db
        .select()
        .from(suppliersTable)
        .where(sql`replace(${suppliersTable.phone}, ' ', '') = ${cleaned}`)
        .limit(1);
      if (existingPhone) {
        skipped++;
        details.push({
          row: i + 1,
          name,
          status: "skipped",
          reason: `رقم الهاتف مسجل بالفعل للمورد: ${existingPhone.name}`,
        });
        continue;
      }
    }

    try {
      const registration = Object.fromEntries(
        REGISTRATION_FIELDS.map((k) => [k, row[k] ? String(row[k]).trim() : undefined]),
      );
      const [supplier] = await db
        .insert(suppliersTable)
        .values({
          supplierId: row.supplierId ? String(row.supplierId) : undefined,
          name,
          contactPerson: row.contactPerson ? String(row.contactPerson) : undefined,
          email: email || undefined,
          phone: phone || undefined,
          address: row.address ? String(row.address) : undefined,
          ...registration,
          category,
          invoiceHasVat:
            typeof req.body.invoiceHasVat === "boolean" ? req.body.invoiceHasVat : undefined,
        })
        .returning();

      // Keep the LINK table in step (source of truth). A failure here must not
      // lose the imported supplier, so it is logged, not thrown.
      try {
        await saveSupplierCategoryLinks(supplier.id, toArray(category));
      } catch (linkErr) {
        console.warn("supplier category link save failed (bulk import)", supplier.id, linkErr);
      }

      imported++;
      details.push({
        row: i + 1,
        name,
        status: "imported",
        reason: null,
        supplier: serializeSupplier(supplier),
      });
    } catch (err: unknown) {
      errors++;
      const msg = (err as { message?: string })?.message ?? "خطأ غير متوقع";
      details.push({ row: i + 1, name, status: "error", reason: msg });
    }
  }

  res.json({ imported, skipped, errors, details });
});

/**
 * إلغاء تفعيل تلقائي: كل مورد لم يرد على آخر N إرسال متتالي. العدّاد يبدأ من
 * GREATEST(آخر عرض, تاريخ آخر إعادة تفعيل يدوية) — فإعادة التفعيل يدويًا تُصفّر
 * العدّاد، ولا يُعاد تعطيل المورد إلا بعد N إرسالات جديدة دون رد.
 *
 * This is a WRITE, and it used to run on every GET /suppliers — measured at
 * **8.9 s** on production (the correlated `MAX(created_at)` per supplier group
 * re-reads `offers` for every sent_log row). A page load must not pay for a
 * background sweep, so it is now called once at startup (see index.ts) and after
 * a manual re-activation, never from the list route.
 *
 * The rewrite hoists both correlated subqueries into CTEs that run ONCE, and was
 * verified to return the identical affected-row count at thresholds 1/2/3/10.
 * Best-effort: a failure is logged, never thrown.
 */
export async function deactivateInactiveSuppliers(): Promise<number> {
  try {
    const result = await db.execute(sql`
      WITH last_offer AS (
        SELECT supplier_id, max(created_at) AS at
        FROM offers WHERE supplier_id IS NOT NULL GROUP BY supplier_id
      ),
      last_react AS (
        SELECT id, reactivated_at FROM suppliers WHERE reactivated_at IS NOT NULL
      ),
      unanswered AS (
        SELECT sl.supplier_id, count(*) AS c
        FROM sent_log sl
        LEFT JOIN last_offer lo ON lo.supplier_id = sl.supplier_id
        LEFT JOIN last_react lr ON lr.id = sl.supplier_id
        WHERE sl.supplier_id IS NOT NULL
          AND sl.created_at > GREATEST(
            COALESCE(lo.at, 'epoch'::timestamp),
            COALESCE(lr.reactivated_at, 'epoch'::timestamp)
          )
        GROUP BY sl.supplier_id
      )
      UPDATE suppliers s
      SET is_active = false
      FROM unanswered u
      WHERE s.id = u.supplier_id
        AND u.c >= ${AUTO_DEACTIVATE_AFTER}
        AND s.is_active = true
    `);
    return (result as { rowCount?: number }).rowCount ?? 0;
  } catch (err) {
    logger.warn({ err }, "suppliers: auto-deactivate sweep failed");
    return 0;
  }
}

router.get("/suppliers", requireAuth, async (req, res): Promise<void> => {
  const { category, search, itemCategoryId } = req.query as Record<string, string>;

  const conditions = [];
  if (itemCategoryId) {
    // «المورد ده بيورّد إيه» filter — a DIFFERENT question from the trade
    // category above. A supplier matches when it is linked to this ITEM
    // category or to ANY category in its subtree, so filtering on «كهرباء»
    // lists suppliers linked to «كابلات» too.
    const wantedId = parseInt(itemCategoryId, 10);
    if (!Number.isFinite(wantedId)) {
      res.status(400).json({ error: "معرّف تصنيف البنود غير صالح" });
      return;
    }
    const allItemCategories = await db
      .select({
        id: itemCategoriesTable.id,
        name: itemCategoriesTable.name,
        parentId: itemCategoriesTable.parentId,
      })
      .from(itemCategoriesTable);
    const subtree = [...descendantIds(allItemCategories, wantedId)];
    // A supplier matches the item-category filter when EITHER a human linked him
    // (manual) OR his own HISTORY covers the category — he quoted a line in it
    // or a purchase order was issued to him for one. Union of the two, so the
    // filter finds the suppliers the operator never had to tag by hand.
    const byCategory = await suppliersForItemCategories(subtree);
    const byHistory = await suppliersWithHistoryForCategories(subtree).catch(
      () => new Map<number, number[]>(),
    );
    const supplierIds = new Set<number>();
    for (const ids of byCategory.values()) for (const s of ids) supplierIds.add(s);
    for (const ids of byHistory.values()) for (const s of ids) supplierIds.add(s);
    const supplierIdList = [...supplierIds];
    // No supplier supplies this category → an empty set, never a dropped
    // filter (which would list EVERY supplier).
    conditions.push(
      supplierIdList.length > 0 ? inArray(suppliersTable.id, supplierIdList) : sql`1 = 0`,
    );
  }
  if (category) {
    // Filter through the LINK table — the authoritative relationship. A supplier
    // matches when it is linked to a category with this name, OR to ANY category
    // in that category's SUBTREE: filtering on «كهرباء» must list the suppliers
    // filed under «كابلات» / «سلك» / … at ANY depth, so a parent is a superset of
    // its whole subtree. The subtree is resolved in one read of the tree
    // (`descendantIds`) rather than a fixed two-level join, which used to miss a
    // grandchild (كهرباء ← Automation ← Encoders).
    const allCategories = await db
      .select({
        id: supplierCategoriesTable.id,
        name: supplierCategoriesTable.name,
        parentId: supplierCategoriesTable.parentId,
      })
      .from(supplierCategoriesTable);
    const rootIds = allCategories.filter((c) => c.name === category).map((c) => c.id);
    const subtreeIds = new Set<number>();
    for (const rootId of rootIds) {
      for (const id of descendantIds(allCategories, rootId)) subtreeIds.add(id);
    }
    // No matching category at all → no supplier can match; return an empty set
    // rather than dropping the filter (which would list EVERY supplier).
    const linkedSupplierIds = db
      .select({ supplierId: supplierCategoryLinksTable.supplierId })
      .from(supplierCategoryLinksTable)
      .where(
        subtreeIds.size > 0
          ? inArray(supplierCategoryLinksTable.categoryId, [...subtreeIds])
          : sql`1 = 0`,
      );
    conditions.push(inArray(suppliersTable.id, linkedSupplierIds));
  }
  if (search)
    conditions.push(
      or(
        ilike(suppliersTable.name, `%${search}%`),
        ilike(suppliersTable.contactPerson, `%${search}%`),
      ),
    );

  const suppliers = await db
    .select()
    .from(suppliersTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(suppliersTable.name);

  // Prefer the LINK table for the category list; fall back to the legacy text
  // for any supplier that has no links (pre-migration rows).
  const linkMap = await loadSupplierCategoryMap(suppliers.map((s) => s.id));
  // Item categories are DERIVED from the supplier's own history (what he quoted
  // and what he was issued a PO for) merged with the manual links. A failure is
  // ENRICHMENT-only — it must never fail the supplier list itself.
  const evidenceMap = await loadSupplierItemCategoryEvidenceMap(suppliers.map((s) => s.id)).catch(
    () =>
      new Map<
        number,
        Array<{
          categoryId: number;
          name: string;
          quoted: boolean;
          ordered: boolean;
          manual: boolean;
        }>
      >(),
  );
  res.json(
    suppliers.map((s) => {
      const base = serializeSupplier(s);
      const itemCategoryEvidence = evidenceMap.get(s.id) ?? [];
      const itemCategories = itemCategoryEvidence.map((c) => ({
        id: c.categoryId,
        name: c.name,
        quoted: c.quoted,
        ordered: c.ordered,
        manual: c.manual,
      }));
      const links = linkMap.get(s.id);
      if (!links || links.length === 0) return { ...base, itemCategories, itemCategoryEvidence };
      const names = links.map((l) => l.name);
      return {
        ...base,
        category: categoriesToStored(names),
        categories: names,
        // The FULL path per category, so the UI can show «كهرباء / كابلات»
        // instead of an ambiguous leaf name.
        categoryPaths: links.map((l) => ({ id: l.id, name: l.name, path: l.path })),
        itemCategories,
        itemCategoryEvidence,
      };
    }),
  );
});

/**
 * Suppliers that can SUPPLY a given item category — «مين يقدر يورّد بند من
 * تصنيف كابلات؟». Includes the category's whole subtree (a supplier linked to
 * «كهرباء» can supply «كابلات»). Read-only.
 */
router.get(
  "/suppliers/for-item-category/:categoryId",
  requireAuth,
  async (req, res): Promise<void> => {
    const categoryId = parseInt(req.params.categoryId as string, 10);
    if (!Number.isFinite(categoryId)) {
      res.status(400).json({ error: "معرّف التصنيف غير صالح" });
      return;
    }
    const all = await db
      .select({
        id: itemCategoriesTable.id,
        name: itemCategoriesTable.name,
        parentId: itemCategoriesTable.parentId,
      })
      .from(itemCategoriesTable);
    const subtree = [...descendantIds(all, categoryId)];
    // Manual links UNION the supplier's own history (quoted / ordered), so
    // «مين يقدر يورّد بند من تصنيف كابلات؟» finds the suppliers who have
    // actually priced or supplied it, not only the hand-tagged ones.
    const byCategory = await suppliersForItemCategories(subtree);
    const byHistory = await suppliersWithHistoryForCategories(subtree).catch(
      () => new Map<number, number[]>(),
    );
    const supplierIdSet = new Set<number>();
    for (const ids of byCategory.values()) for (const s of ids) supplierIdSet.add(s);
    for (const ids of byHistory.values()) for (const s of ids) supplierIdSet.add(s);
    const supplierIds = [...supplierIdSet];
    const rows = supplierIds.length
      ? await db.select().from(suppliersTable).where(inArray(suppliersTable.id, supplierIds))
      : [];
    res.json({
      categoryId,
      subtreeIds: subtree,
      suppliers: rows.map((s) => ({ id: s.id, name: s.name, phone: s.phone, email: s.email })),
    });
  },
);

// قائمة تقييمات جميع الموردين دفعة واحدة
router.get("/suppliers/scores", requireAuth, async (req, res): Promise<void> => {
  const suppliers = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.isActive, true))
    .orderBy(suppliersTable.name);

  const scoreMap = await computeAllSupplierScores(suppliers.map((s) => s.id));
  const scores = suppliers.map((s) => ({
    supplierId: s.id,
    supplierName: s.name,
    ...(scoreMap.get(s.id) ??
      deriveScore({
        totalRfqsReceived: 0,
        totalOffersSubmitted: 0,
        avgResponseHours: null,
        totalItemsOffered: 0,
        avgPriceDelta: null,
        wins: 0,
        acceptedQty: 0,
        rejectedQty: 0,
        avgDeliveryDays: null,
      })),
  }));

  // ترتيب حسب التقييم تنازلياً (الموردون بلا بيانات آخر القائمة)
  scores.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  res.json(scores);
});

// Any authenticated employee can add a supplier
router.post("/suppliers", requireAuth, async (req, res): Promise<void> => {
  const { supplierId, name, contactPerson, email, phone, address } = req.body as Record<
    string,
    string
  >;
  const registration = Object.fromEntries(
    REGISTRATION_FIELDS.map((k) => [k, req.body[k] ? String(req.body[k]).trim() : undefined]),
  );
  const rawCats = req.body.categories ?? req.body.category;
  const category = toStored(rawCats || "general");

  if (!name || !category) {
    res.status(400).json({ error: "Name and category required" });
    return;
  }

  // A supplier is filed under a LEAF trade only (ERPNext's «only leaf nodes are
  // allowed in transaction»). Filing him under a parent would make him count
  // once for the parent AND once for each subtree query, so the totals cannot be
  // trusted. Refuse and NAME the category instead of silently dropping the link.
  const nonLeaf = await nonLeafCategoryNames(toArray(category));
  if (nonLeaf.length > 0) {
    res.status(400).json({
      error: `لا يمكن إسناد المورد لتصنيف رئيسي له تصنيفات فرعية: ${nonLeaf.join("، ")} — اختر تصنيفًا فرعيًا`,
      nonLeafCategories: nonLeaf,
    });
    return;
  }

  if (email && email.trim()) {
    const [existing] = await db
      .select()
      .from(suppliersTable)
      .where(ilike(suppliersTable.email, email.trim()))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: `هذا الإيميل مسجل بالفعل للمورد: ${existing.name}` });
      return;
    }
  }

  if (phone && phone.trim()) {
    const cleaned = phone.trim().replace(/\s+/g, "");
    const [existing] = await db
      .select()
      .from(suppliersTable)
      .where(sql`replace(${suppliersTable.phone}, ' ', '') = ${cleaned}`)
      .limit(1);
    if (existing) {
      res.status(409).json({ error: `رقم الهاتف مسجل بالفعل للمورد: ${existing.name}` });
      return;
    }
  }

  const [supplier] = await db
    .insert(suppliersTable)
    .values({
      supplierId,
      name,
      contactPerson,
      email,
      phone,
      address,
      ...registration,
      category,
    })
    .returning();

  // Seed the LINK table from the categories just stored.
  try {
    await saveSupplierCategoryLinks(supplier.id, toArray(category));
  } catch (linkErr) {
    console.warn("supplier category link save failed (create)", supplier.id, linkErr);
  }
  // Supplier ↔ ITEM-category links — «المورد ده بيورّد إيه». Optional; a create
  // without them is valid, and a failure must never fail the create.
  const itemCategoryIds = Array.isArray(req.body.itemCategoryIds)
    ? (req.body.itemCategoryIds as Array<number | string>).map((v) => Number(v))
    : undefined;
  if (itemCategoryIds !== undefined) {
    try {
      await saveSupplierItemCategoryLinks(supplier.id, itemCategoryIds);
    } catch (linkErr) {
      console.warn("supplier item-category link save failed (create)", supplier.id, linkErr);
    }
  }
  res.status(201).json(serializeSupplier(supplier));
});

router.get("/suppliers/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [supplier] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, id));
  if (!supplier) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const itemCategoryEvidence = await supplierItemCategoryEvidence(id).catch(() => []);
  const itemCategories = itemCategoryEvidence.map((c) => ({
    id: c.categoryId,
    name: c.name,
    quoted: c.quoted,
    ordered: c.ordered,
    manual: c.manual,
  }));
  // Full path per trade category — the detail header shows «كهرباء / كابلات».
  const links = (await loadSupplierCategoryMap([id])).get(id) ?? [];
  const categoryPaths = links.map((l) => ({ id: l.id, name: l.name, path: l.path }));
  res.json({
    ...serializeSupplier(supplier),
    ...(links.length > 0
      ? {
          category: categoriesToStored(links.map((l) => l.name)),
          categories: links.map((l) => l.name),
        }
      : {}),
    categoryPaths,
    itemCategories,
    itemCategoryEvidence,
  });
});

router.patch("/suppliers/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const updates: Record<string, unknown> = {};
  const allowed = [
    "name",
    "contactPerson",
    "email",
    "phone",
    "address",
    "isActive",
    "invoiceHasVat",
    ...REGISTRATION_FIELDS,
  ];
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (req.body.categories !== undefined || req.body.category !== undefined) {
    const rawCats = req.body.categories ?? req.body.category;
    // Same leaf-only rule as create. A PATCH that moves a supplier onto a
    // parent is refused; the link table is left exactly as it was.
    updates.category = toStored(rawCats);
    // Same leaf-only rule as create. A PATCH that moves a supplier onto a
    // parent is refused; the link table is left exactly as it was.
    const nonLeaf = await nonLeafCategoryNames(toArray(String(updates.category)));
    if (nonLeaf.length > 0) {
      res.status(400).json({
        error: `لا يمكن إسناد المورد لتصنيف رئيسي له تصنيفات فرعية: ${nonLeaf.join("، ")} — اختر تصنيفًا فرعيًا`,
        nonLeafCategories: nonLeaf,
      });
      return;
    }
  }

  if (updates.email && String(updates.email).trim()) {
    const emailVal = String(updates.email).trim();
    const [existing] = await db
      .select()
      .from(suppliersTable)
      .where(and(ilike(suppliersTable.email, emailVal), ne(suppliersTable.id, id)))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: `هذا الإيميل مسجل بالفعل للمورد: ${existing.name}` });
      return;
    }
  }

  if (updates.phone && String(updates.phone).trim()) {
    const cleaned = String(updates.phone).trim().replace(/\s+/g, "");
    const [existing] = await db
      .select()
      .from(suppliersTable)
      .where(
        and(sql`replace(${suppliersTable.phone}, ' ', '') = ${cleaned}`, ne(suppliersTable.id, id)),
      )
      .limit(1);
    if (existing) {
      res.status(409).json({ error: `رقم الهاتف مسجل بالفعل للمورد: ${existing.name}` });
      return;
    }
  }

  // Manual reactivation (false → true): stamp reactivated_at = now so the
  // auto-deactivate sweep resets this supplier's no-reply counter — it now
  // takes AUTO_DEACTIVATE_AFTER MORE unanswered sends (since this moment) to
  // auto-deactivate again, instead of re-deactivating on the next page load.
  if (updates.isActive === true) {
    const [current] = await db
      .select({ isActive: suppliersTable.isActive })
      .from(suppliersTable)
      .where(eq(suppliersTable.id, id))
      .limit(1);
    if (current && !current.isActive) {
      updates.reactivatedAt = new Date();
    }
  }

  const [supplier] = await db
    .update(suppliersTable)
    .set(updates)
    .where(eq(suppliersTable.id, id))
    .returning();
  if (!supplier) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Reconcile the LINK table (source of truth) when categories were submitted.
  if (updates.category !== undefined) {
    try {
      await saveSupplierCategoryLinks(id, toArray(String(updates.category)));
    } catch (linkErr) {
      console.warn("supplier category link save failed (patch)", id, linkErr);
    }
  }
  // Supplier ↔ ITEM-category links. `itemCategoryIds: []` clears them; omitting
  // the field leaves them untouched.
  if (Array.isArray(req.body.itemCategoryIds)) {
    try {
      await saveSupplierItemCategoryLinks(
        id,
        (req.body.itemCategoryIds as Array<number | string>).map((v) => Number(v)),
      );
    } catch (linkErr) {
      console.warn("supplier item-category link save failed (patch)", id, linkErr);
    }
  }
  const itemCategoryEvidence = await supplierItemCategoryEvidence(id).catch(() => []);
  const itemCategories = itemCategoryEvidence.map((c) => ({
    id: c.categoryId,
    name: c.name,
    quoted: c.quoted,
    ordered: c.ordered,
    manual: c.manual,
  }));
  res.json({ ...serializeSupplier(supplier), itemCategories, itemCategoryEvidence });
});

// Only admin or manager can delete a supplier
router.delete("/suppliers/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  try {
    const [deleted] = await db.delete(suppliersTable).where(eq(suppliersTable.id, id)).returning();
    if (!deleted) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).end();
  } catch (err: unknown) {
    // Drizzle hides the Postgres error text in `err.cause`, so a
    // `message.includes(...)` check never fires — see shared/pg-errors.ts.
    if (isForeignKeyViolation(err)) {
      res.status(409).json({
        error:
          "لا يمكن حذف هذا المورد لوجود سجلات مرتبطة به (عروض أسعار، أوامر شراء، فواتير موردين، أو محادثات واتساب). يمكنك تعطيله بدلاً من حذفه.",
      });
      return;
    }
    throw err;
  }
});

// GET /suppliers/:id/rfqs — طلبات التسعير المرسلة لهذا المورد
router.get("/suppliers/:id/rfqs", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const supplierId = parseInt(raw, 10);

  const rows = await db
    .select({
      rfqId: rfqTable.id,
      internalRfqNo: rfqTable.internalRfqNo,
      customerRfqNo: rfqTable.customerRfqNo,
      status: rfqTable.status,
      sentAt: sentLogTable.createdAt,
      rfqCreatedAt: rfqTable.createdAt,
    })
    .from(sentLogTable)
    .innerJoin(rfqTable, eq(sentLogTable.rfqId, rfqTable.id))
    .where(eq(sentLogTable.supplierId, supplierId))
    .orderBy(sql`${sentLogTable.createdAt} DESC`);

  const rfqIds = rows.map((r) => r.rfqId);
  const offerRows =
    rfqIds.length > 0
      ? await db
          .select({ rfqId: offersTable.rfqId, cnt: count() })
          .from(offersTable)
          .where(and(eq(offersTable.supplierId, supplierId), inArray(offersTable.rfqId, rfqIds)))
          .groupBy(offersTable.rfqId)
      : [];

  const offerMap = Object.fromEntries(offerRows.map((r) => [r.rfqId, Number(r.cnt)]));

  res.json(
    rows.map((r) => ({
      id: r.rfqId,
      internalRfqNo: r.internalRfqNo,
      customerRfqNo: r.customerRfqNo,
      status: r.status,
      sentAt: r.sentAt?.toISOString() ?? null,
      hasOffer: (offerMap[r.rfqId] ?? 0) > 0,
      createdAt: r.rfqCreatedAt.toISOString(),
    })),
  );
});

// GET /suppliers/:id/pos — أوامر الشراء المرتبطة بهذا المورد
router.get("/suppliers/:id/pos", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const supplierId = parseInt(raw, 10);

  const rows = await db
    .selectDistinct({
      id: purchaseOrdersTable.id,
      internalPoNo: purchaseOrdersTable.internalPoNo,
      sheetPoNo: purchaseOrdersTable.sheetPoNo,
      status: purchaseOrdersTable.status,
      createdAt: purchaseOrdersTable.createdAt,
    })
    .from(purchaseOrderItemsTable)
    .innerJoin(purchaseOrdersTable, eq(purchaseOrderItemsTable.poId, purchaseOrdersTable.id))
    .where(eq(purchaseOrderItemsTable.supplierId, supplierId))
    .orderBy(sql`${purchaseOrdersTable.createdAt} DESC`);

  const poIds = rows.map((r) => r.id);

  const itemCountRows =
    poIds.length > 0
      ? await db
          .select({ poId: purchaseOrderItemsTable.poId, cnt: count() })
          .from(purchaseOrderItemsTable)
          .where(
            and(
              eq(purchaseOrderItemsTable.supplierId, supplierId),
              inArray(purchaseOrderItemsTable.poId, poIds),
            ),
          )
          .groupBy(purchaseOrderItemsTable.poId)
      : [];
  const itemMap = Object.fromEntries(itemCountRows.map((r) => [r.poId, Number(r.cnt)]));

  // Batch-load receipt progress for ALL returned POs in one query (line_status
  // aggregate across the PO's items owned by this supplier).
  const lineRows =
    poIds.length > 0
      ? await db
          .select({
            poId: purchaseOrderItemsTable.poId,
            lineStatus: purchaseOrderItemsTable.lineStatus,
            supplierId: purchaseOrderItemsTable.supplierId,
            customerPoItemId: purchaseOrderItemsTable.customerPoItemId,
          })
          .from(purchaseOrderItemsTable)
          .where(inArray(purchaseOrderItemsTable.poId, poIds))
      : [];

  const progressMap: Record<number, { total: number; received: number; rejected: number }> = {};
  for (const r of lineRows) {
    if (r.supplierId !== supplierId) continue; // count only this supplier's lines
    const agg = (progressMap[r.poId] ??= { total: 0, received: 0, rejected: 0 });
    agg.total++;
    if (r.lineStatus === "fulfilled" || r.lineStatus === "received") agg.received++;
    if (r.lineStatus === "rejected") agg.rejected++;
  }

  // Link each supplier PO to its customer PO: item-level FK first
  // (purchase_order_items.customerPoItemId → customer_po_items.customerPoId),
  // then a header-level fallback (sheetPoNo = customer_pos.customerPoNo,
  // case-insensitive) — same linkage rules as the customer-PO fulfillment.
  const linkedCustItemIds = [
    ...new Set(lineRows.map((r) => r.customerPoItemId).filter((x): x is number => x != null)),
  ];
  const linkedCustItems =
    linkedCustItemIds.length > 0
      ? await db
          .select({
            id: customerPoItemsTable.id,
            customerPoId: customerPoItemsTable.customerPoId,
          })
          .from(customerPoItemsTable)
          .where(inArray(customerPoItemsTable.id, linkedCustItemIds))
      : [];
  const custPoIdByItemId = new Map(linkedCustItems.map((r) => [r.id, r.customerPoId]));

  const poToCustomerPo = new Map<number, number>();
  for (const r of lineRows) {
    if (r.customerPoItemId != null && !poToCustomerPo.has(r.poId)) {
      const cid = custPoIdByItemId.get(r.customerPoItemId);
      if (cid != null) poToCustomerPo.set(r.poId, cid);
    }
  }
  const unlinked = rows.filter((r) => !poToCustomerPo.has(r.id) && r.sheetPoNo);
  if (unlinked.length > 0) {
    const headerMatches = await db
      .select({ id: customerPosTable.id, customerPoNo: customerPosTable.customerPoNo })
      .from(customerPosTable)
      .where(or(...unlinked.map((r) => ilike(customerPosTable.customerPoNo, r.sheetPoNo))));
    const custPoByNo = new Map(headerMatches.map((r) => [r.customerPoNo.toLowerCase(), r.id]));
    for (const r of unlinked) {
      const cid = custPoByNo.get(r.sheetPoNo.toLowerCase());
      if (cid != null) poToCustomerPo.set(r.id, cid);
    }
  }

  // Roll up delivery resolution (delivered + rejected are terminal) over the
  // linked customer PO's items — the same numbers the /customer-po page shows.
  const custPoIds = [...new Set(poToCustomerPo.values())];
  const custDeliveryRows =
    custPoIds.length > 0
      ? await db
          .select({
            customerPoId: customerPoItemsTable.customerPoId,
            deliveryStatus: customerPoItemsTable.deliveryStatus,
          })
          .from(customerPoItemsTable)
          .where(inArray(customerPoItemsTable.customerPoId, custPoIds))
      : [];
  const custRollup = new Map<number, { total: number; resolved: number }>();
  for (const r of custDeliveryRows) {
    if (r.customerPoId == null) continue; // detached (removed) row — not on any PO
    const e = custRollup.get(r.customerPoId) ?? { total: 0, resolved: 0 };
    e.total++;
    if (r.deliveryStatus === "delivered" || r.deliveryStatus === "rejected") e.resolved++;
    custRollup.set(r.customerPoId, e);
  }

  // Mirror the customer-PO fulfillmentStatus stages so this column reads
  // EXACTLY like the «حالة الطلب» column on /customer-po:
  //   fulfilled          — كل البنود حُسمت (مُسلَّمة أو مرفوضة) → «اكتمل»
  //   delivered          — بعض البنود حُسمت → «تم تنفيذه X%»
  //   ready_to_deliver   — استُلم من المورد ولم يُسلَّم بعد → «جاهز للتسليم X%»
  //   po_issued          — صدر للمورد (sent) ولم يُستلَم → «تم إصدار أمر شراء للمورد»
  //   draft              — مسودة
  type DerivedStage = "fulfilled" | "delivered" | "ready_to_deliver" | "po_issued" | "draft";
  function deriveProgressStatus(
    headerStatus: string,
    progress: { total: number; received: number; rejected: number } | undefined,
    delivery: { total: number; resolved: number } | undefined,
  ): {
    stage: DerivedStage;
    label: string;
    tone: "fulfilled" | "partial" | "received" | "issued" | "default";
  } {
    if (delivery && delivery.total > 0 && delivery.resolved > 0) {
      const pct = Math.round((delivery.resolved / delivery.total) * 100);
      if (pct >= 100) return { stage: "fulfilled", label: "اكتمل", tone: "fulfilled" };
      return { stage: "delivered", label: `تم تنفيذه ${pct}%`, tone: "partial" };
    }
    if (progress && progress.total > 0 && progress.received > 0) {
      const pct = Math.round((progress.received / progress.total) * 100);
      return { stage: "ready_to_deliver", label: `جاهز للتسليم ${pct}%`, tone: "received" };
    }
    if (headerStatus === "sent") {
      return { stage: "po_issued", label: "تم إصدار أمر شراء للمورد", tone: "issued" };
    }
    return {
      stage: "draft",
      label: headerStatus === "draft" ? "مسودة" : headerStatus,
      tone: "default",
    };
  }

  res.json(
    rows.map((r) => {
      const receipt = progressMap[r.id];
      const custId = poToCustomerPo.get(r.id);
      const derived = deriveProgressStatus(
        r.status,
        receipt,
        custId != null ? custRollup.get(custId) : undefined,
      );
      return {
        id: r.id,
        internalPoNo: r.internalPoNo,
        sheetPoNo: r.sheetPoNo,
        status: r.status,
        progressStatus: derived.stage,
        progressStatusLabel: derived.label,
        progressTone: derived.tone,
        itemCount: itemMap[r.id] ?? 0,
        receipt,
        createdAt: r.createdAt.toISOString(),
      };
    }),
  );
});

router.get("/suppliers/:id/score", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const supplierId = parseInt(raw, 10);

  const [supplier] = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.id, supplierId));
  if (!supplier) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const score = await computeSupplierScore(supplierId);

  res.json({
    supplierId,
    supplierName: supplier.name,
    ...score,
  });
});

export default router;
