/**
 * RFQ Dashboard KPIs — لوحة مؤشرات طلبات التسعير
 *
 * Yearly and monthly counters for the customer pricing cycle and its supplier
 * side. Every figure is computed in one SQL statement (aggregates only, no rows
 * loaded into memory).
 *
 * Definitions (also returned to the UI as `definitions` so each card can show
 * its own formula):
 *   - بند عميل        : customer_rfq_items row, not cancelled.
 *   - بند مسعّر للعميل : customer item with unit_price set (offer sent to customer).
 *   - بند مفتوح للعميل : customer item with no price and expiry_date not yet passed.
 *   - أول مرة          : the item key (customer + line_item) appears for the first time
 *                        in its entry_date.
 *   - نسبة التسعير     : priced customer items ÷ all customer items.
 *   - نسبة الفوز بالـ PO : priced customer items that have a customer PO line ÷ priced items.
 *   - بند عليه سعر مورد : customer item linked to an approved supplier offer item.
 *
 * Route (behind requireAuth + the /analytics permission guard):
 *   GET /analytics/rfq-kpis?year=2026&month=11
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { guardFor } from "../../shared/permissions";

const router = Router();
router.use("/analytics", guardFor("/analytics"));

export const RFQ_KPI_DEFINITIONS = {
  totalItems: "إجمالي بنود طلبات العملاء (غير الملغية) التي دخلت في السنة",
  rfqCount: "عدد طلبات التسعير الواردة من العملاء في السنة",
  customerPoCount: "عدد أوامر الشراء الصادرة من العملاء (حالة مُرسَلة) في السنة",
  pricedItems: "البنود التي تم إرسال سعر لها للعميل في السنة",
  pricingRate: "نسبة التسعير = البنود المسعّرة ÷ إجمالي البنود",
  poWinRate: "نسبة الفوز بالـ PO = البنود المسعّرة اللي جالها أمر شراء من العميل ÷ البنود المسعّرة",
  monthRfqCount: "عدد طلبات التسعير الواردة من العملاء في الشهر",
  monthFirstSeenItems: "البنود اللي ظهرت لأول مرة (على مستوى العميل + رقم البند) في الشهر",
  monthItemsToPrice: "إجمالي البنود المطلوب تسعيرها للعميل في الشهر",
  monthSupplierRfqCount: "عدد طلبات التسعير المرسلة للموردين في الشهر",
  monthSupplierPoCount: "عدد أوامر الشراء المرسلة للموردين في الشهر",
  monthSupplierPoRate: "نسبة أوامر الشراء للموردين = أوامر الشراء المرسلة ÷ طلبات التسعير المرسلة للموردين",
  monthOpenCustomerRequests: "الطلبات المفتوحة للعملاء حالياً (بنود بدون سعر وتاريخ إغلاقها لم يمر)",
  monthOpenCustomerItems: "البنود المطلوب تسعيرها للعملاء حالياً (بدون سعر وتاريخ إغلاقها لم يمر)",
  monthItemsWithSupplierPrice: "بنود الشهر اللي ليها سعر مورد معتمد",
  monthSupplierPriceRate: "نسبة البنود اللي ليها سعر مورد = بنود الشهر بسعر مورد ÷ إجمالي بنود الشهر",
} as const;

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 10000) / 100 : 0;
}

router.get("/analytics/rfq-kpis", requireAuth, async (req, res): Promise<void> => {
  const now = new Date();
  const year = parseInt(String(req.query.year ?? now.getUTCFullYear()), 10);
  const month = parseInt(String(req.query.month ?? now.getUTCMonth() + 1), 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    res.status(400).json({ error: "year غير صالحة" });
    return;
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    res.status(400).json({ error: "month غير صالحة" });
    return;
  }
  // First and first-after-last day of the requested month (UTC), for timestamp columns.
  const monthStart = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const monthEnd = new Date(Date.UTC(year, month, 1)).toISOString();

  const result = await db.execute(sql`
    WITH base AS (
      SELECT
        cri.id,
        cri.unit_price,
        NULLIF(cr.entry_date, '')::date AS d,
        cr.expiry_date,
        lower(trim(coalesce(cri.line_item, ''))) AS li,
        coalesce(cr.customer_id::text, lower(trim(cr.customer_name))) AS cust
      FROM customer_rfq_items cri
      JOIN customer_rfqs cr ON cr.id = cri.customer_rfq_id
      WHERE cri.is_cancelled = false
    ),
    first_seen AS (
      SELECT id,
             row_number() OVER (PARTITION BY cust, li ORDER BY d, id) AS rn,
             d
      FROM base
      WHERE d IS NOT NULL AND li <> ''
    ),
    approved AS (
      SELECT DISTINCT ri.customer_rfq_item_id AS cid
      FROM offer_items oi
      JOIN rfq_items ri ON ri.id = oi.rfq_item_id
      WHERE oi.is_approved = true AND ri.customer_rfq_item_id IS NOT NULL
    ),
    po_linked AS (
      SELECT DISTINCT cpi.customer_rfq_item_id AS cid
      FROM customer_po_items cpi
      JOIN customer_pos cp ON cp.id = cpi.customer_po_id
      WHERE cpi.customer_rfq_item_id IS NOT NULL
        AND cp.status = 'sent'
        AND cpi.delivery_status <> 'cancelled'
    )
    SELECT
      -- ── Yearly ──
      (SELECT count(*) FROM base WHERE extract(year FROM d) = ${year}) AS items_year,
      (SELECT count(*) FROM customer_rfqs
         WHERE extract(year FROM NULLIF(entry_date, '')::date) = ${year}) AS rfq_year,
      (SELECT count(*) FROM customer_pos
         WHERE status = 'sent'
           AND extract(year FROM NULLIF(po_date, '')::date) = ${year}) AS customer_po_year,
      (SELECT count(*) FROM base
         WHERE unit_price IS NOT NULL AND extract(year FROM d) = ${year}) AS priced_year,
      (SELECT count(*) FROM base b
         WHERE b.unit_price IS NOT NULL AND extract(year FROM b.d) = ${year}
           AND b.id IN (SELECT cid FROM po_linked)) AS won_year,

      -- ── Monthly: customer side ──
      (SELECT count(*) FROM customer_rfqs
         WHERE extract(year FROM NULLIF(entry_date, '')::date) = ${year}
           AND extract(month FROM NULLIF(entry_date, '')::date) = ${month}) AS rfq_month,
      (SELECT count(*) FROM first_seen
         WHERE rn = 1 AND extract(year FROM d) = ${year} AND extract(month FROM d) = ${month}) AS first_seen_month,
      (SELECT count(*) FROM base
         WHERE extract(year FROM d) = ${year} AND extract(month FROM d) = ${month}) AS items_month,
      (SELECT count(*) FROM base
         WHERE unit_price IS NULL AND NULLIF(expiry_date, '')::date >= CURRENT_DATE) AS open_items_now,
      (SELECT count(DISTINCT cust || '|' || expiry_date) FROM base
         WHERE unit_price IS NULL AND NULLIF(expiry_date, '')::date >= CURRENT_DATE) AS open_requests_now,

      -- ── Monthly: supplier side ──
      (SELECT count(*) FROM rfq
         WHERE created_at >= ${monthStart}::timestamptz AND created_at < ${monthEnd}::timestamptz) AS supplier_rfq_month,
      (SELECT count(*) FROM purchase_orders
         WHERE status = 'sent'
           AND created_at >= ${monthStart}::timestamptz AND created_at < ${monthEnd}::timestamptz) AS supplier_po_month,

      -- ── Monthly: supplier price coverage ──
      (SELECT count(*) FROM base
         WHERE extract(year FROM d) = ${year} AND extract(month FROM d) = ${month}
           AND id IN (SELECT cid FROM approved)) AS supplier_priced_month
  `);

  const r = (result.rows[0] ?? {}) as Record<string, unknown>;
  const itemsYear = num(r.items_year);
  const pricedYear = num(r.priced_year);
  const wonYear = num(r.won_year);
  const itemsMonth = num(r.items_month);
  const supplierRfqMonth = num(r.supplier_rfq_month);
  const supplierPoMonth = num(r.supplier_po_month);
  const supplierPricedMonth = num(r.supplier_priced_month);

  res.json({
    year,
    month,
    yearly: {
      totalItems: itemsYear,
      rfqCount: num(r.rfq_year),
      customerPoCount: num(r.customer_po_year),
      pricedItems: pricedYear,
      pricingRate: pct(pricedYear, itemsYear),
      poWinRate: pct(wonYear, pricedYear),
    },
    monthly: {
      rfqCount: num(r.rfq_month),
      firstSeenItems: num(r.first_seen_month),
      itemsToPrice: itemsMonth,
      supplierRfqCount: supplierRfqMonth,
      supplierPoCount: supplierPoMonth,
      supplierPoRate: pct(supplierPoMonth, supplierRfqMonth),
      openCustomerRequests: num(r.open_requests_now),
      openCustomerItems: num(r.open_items_now),
      itemsWithSupplierPrice: supplierPricedMonth,
      supplierPriceRate: pct(supplierPricedMonth, itemsMonth),
    },
    definitions: RFQ_KPI_DEFINITIONS,
  });
});

export default router;
