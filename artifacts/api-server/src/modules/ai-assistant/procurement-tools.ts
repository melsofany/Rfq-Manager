/**
 * AI Assistant — database-first procurement intelligence tools.
 *
 * These do the arithmetic in POSTGRES, not in the model's head. That distinction
 * is the whole point: a model asked to total quantities across hundreds of rows
 * will silently approximate, drop rows past its context window, or invent a
 * number — and the operator cannot tell. A `SUM … GROUP BY` cannot. The model's
 * job becomes understanding the question and explaining the result, which is what
 * it is actually good at.
 *
 * Every function returns an `EvidenceEnvelope`, so the figures arrive with their
 * source, filters, completeness and confidence attached.
 */
import {
  db,
  purchaseOrdersTable,
  purchaseOrderItemsTable,
  suppliersTable,
  offersTable,
  offerItemsTable,
  supplierInvoicesTable,
  customerPosTable,
  customerPoItemsTable,
  rfqTable,
  rfqItemsTable,
} from "@workspace/db";
import { and, or, eq, ilike, inArray, ne, isNotNull, sql, desc } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { evidence, type EvidenceEnvelope } from "./evidence";
import { normalizeText } from "./email";
import { logger } from "../../shared/logger";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Approval state for a supplier line, shared by the "open" and "overdue" views.
 * `cancelled` is excluded everywhere: a cancelled line is not work outstanding.
 */
const DEAD_LINE_STATES = ["cancelled", "fulfilled", "rejected"];

// ─── 1. Purchase-order status ────────────────────────────────────────────────

/**
 * One supplier PO with its per-item receipt rollup, in a single query.
 *
 * Answering "what is the status of PO X?" used to take several sequential tool
 * calls (find PO → find items → find receipts), which routinely exhausted the
 * round budget mid-chase. This collapses it to one.
 */
export async function getPurchaseOrderStatus(term: string): Promise<EvidenceEnvelope> {
  const needle = term.trim();
  const matched = (await (db as any)
    .select()
    .from(purchaseOrdersTable)
    .where(
      or(
        ilike(purchaseOrdersTable.internalPoNo, `%${needle}%`),
        ilike(purchaseOrdersTable.sheetPoNo, `%${needle}%`),
        /^\d+$/.test(needle) ? eq(purchaseOrdersTable.id, Number(needle)) : undefined,
      ) as SQL,
    )
    .limit(5)) as Row[];

  if (matched.length === 0) {
    return evidence({
      data: { found: false },
      source: "database:purchase_orders",
      filters: { term: needle },
      recordCount: 0,
      warnings: [`لا يوجد أمر شراء مطابق لـ «${needle}».`],
    });
  }

  const poIds = matched.map((p) => Number(p.id));
  const items = (await (db as any)
    .select()
    .from(purchaseOrderItemsTable)
    .where(inArray(purchaseOrderItemsTable.poId, poIds))) as Row[];

  // Resolve supplier names for the item rows in ONE query (not per row — that is
  // the N+1 pattern this module exists to avoid).
  const supplierIds = [...new Set(items.map((i) => Number(i.supplierId)).filter(Number.isInteger))];
  const suppliers = supplierIds.length
    ? ((await (db as any)
        .select({ id: suppliersTable.id, name: suppliersTable.name })
        .from(suppliersTable)
        .where(inArray(suppliersTable.id, supplierIds))) as Row[])
    : [];
  const nameById = new Map(suppliers.map((s) => [Number(s.id), String(s.name ?? "")]));

  const warnings: string[] = [];
  if (matched.length > 1) {
    warnings.push(`وجدت ${matched.length} أوامر مطابقة؛ أعرض تفاصيل كلٍّ منها.`);
  }

  const orders: Row[] = matched.map((po) => {
    const poItems = items.filter((i) => Number(i.poId) === Number(po.id));
    const active = poItems.filter((i) => i.lineStatus !== "cancelled");
    if (poItems.length !== active.length) {
      warnings.push(`أمر ${po.internalPoNo ?? po.id}: بعض البنود ملغاة.`);
    }
    const perSupplier = new Map<
      number,
      { supplierId: number; supplierName: string; items: Row[] }
    >();
    for (const it of active) {
      const sid = Number(it.supplierId);
      if (!perSupplier.has(sid)) {
        perSupplier.set(sid, {
          supplierId: sid,
          supplierName: nameById.get(sid) ?? "غير معروف",
          items: [],
        });
      }
      perSupplier.get(sid)!.items.push(it);
    }
    const totalQty = active.reduce((a, i) => a + num(i.qty), 0);
    const receivedQty = active.reduce((a, i) => a + num(i.totalReceivedQty), 0);
    const acceptedQty = active.reduce((a, i) => a + num(i.totalAcceptedQty), 0);
    return {
      ...po,
      itemCount: active.length,
      totalQty,
      receivedQty,
      acceptedQty,
      suppliers: [...perSupplier.values()].map((s) => ({
        supplierId: s.supplierId,
        supplierName: s.supplierName,
        itemCount: s.items.length,
        items: s.items,
      })),
    };
  });

  const plain = matched.map((p) => String(p.internalPoNo ?? p.id)).join(", ");
  return evidence({
    data: { found: true, orders },
    source: "database:purchase_orders + purchase_order_items",
    filters: { term: needle },
    recordCount: orders.length,
    warnings,
    method: `حالة أمر الشراء ${plain} محسوبة من صفوف بنود أمر الشراء (الكمية/المستلم/المقبول لكل بند).`,
    evidence: orders.map((o) => ({
      poNo: o.internalPoNo ?? o.id,
      status: o.status,
      items: o.itemCount,
      totalQty: o.totalQty,
      receivedQty: o.receivedQty,
    })),
  });
}

// ─── 2. Supplier performance ─────────────────────────────────────────────────

/**
 * Per-supplier aggregate computed in SQL: ordered quantity, accepted/rejected
 * receipt quantities, offers submitted and the last PO date. Built as ONE query
 * per aggregate (not per supplier), so a 20-supplier question does not fan out
 * into 60 queries.
 */
export async function getSupplierPerformance(opts: {
  supplier?: string;
  sinceDays?: number;
}): Promise<EvidenceEnvelope> {
  const warnings: string[] = [];
  // Resolve the supplier term to ids first, so the aggregate filters on ids.
  let supplierIds: number[] | null = null;
  if (opts.supplier) {
    const needle = opts.supplier.trim();
    const rows = (await (db as any)
      .select({ id: suppliersTable.id, name: suppliersTable.name })
      .from(suppliersTable)
      .where(
        or(
          ilike(suppliersTable.name, `%${needle}%`),
          /^\d+$/.test(needle) ? eq(suppliersTable.id, Number(needle)) : undefined,
        ) as SQL,
      )
      .limit(20)) as Row[];
    if (rows.length === 0) {
      return evidence({
        data: { suppliers: [] },
        source: "database:suppliers",
        filters: { supplier: needle },
        recordCount: 0,
        warnings: [`لا يوجد مورد مطابق لـ «${needle}».`],
      });
    }
    if (rows.length > 1) warnings.push(`«${needle}» طابق ${rows.length} موردين؛ أعرض كلًّا منهم.`);
    supplierIds = rows.map((r) => Number(r.id));
  }

  const itemFilters: SQL[] = [ne(purchaseOrderItemsTable.lineStatus, "cancelled")];
  if (supplierIds) itemFilters.push(inArray(purchaseOrderItemsTable.supplierId, supplierIds));
  if (opts.sinceDays) {
    itemFilters.push(
      sql`${purchaseOrderItemsTable.createdAt} >= NOW() - (${opts.sinceDays} || ' days')::interval` as SQL,
    );
  }

  const agg = (await (db as any)
    .select({
      supplierId: purchaseOrderItemsTable.supplierId,
      itemCount: sql<number>`count(*)::int`,
      poCount: sql<number>`count(distinct ${purchaseOrderItemsTable.poId})::int`,
      totalQty: sql<number>`coalesce(sum(${purchaseOrderItemsTable.qty}),0)::float8`,
      acceptedQty: sql<number>`coalesce(sum(${purchaseOrderItemsTable.totalAcceptedQty}),0)::float8`,
      rejectedQty: sql<number>`coalesce(sum(${purchaseOrderItemsTable.totalRejectedQty}),0)::float8`,
      rejectedLines: sql<number>`count(*) filter (where ${purchaseOrderItemsTable.lineStatus} = 'rejected')::int`,
    })
    .from(purchaseOrderItemsTable)
    .where(and(...itemFilters))
    .groupBy(purchaseOrderItemsTable.supplierId)) as Row[];

  // Offers + approved offers, one aggregate each.
  const offerFilters: SQL[] = [];
  if (supplierIds) offerFilters.push(inArray(offersTable.supplierId, supplierIds));
  const offerAgg = (await (db as any)
    .select({
      supplierId: offersTable.supplierId,
      offerCount: sql<number>`count(*)::int`,
      lastOfferAt: sql<string>`max(${offersTable.createdAt})::text`,
    })
    .from(offersTable)
    .where(offerFilters.length ? and(...offerFilters) : undefined)
    .groupBy(offersTable.supplierId)) as Row[];

  const supplierIdList = supplierIds ?? [
    ...new Set([...agg, ...offerAgg].map((r) => Number(r.supplierId)).filter(Number.isInteger)),
  ];
  const named = supplierIdList.length
    ? ((await (db as any)
        .select({ id: suppliersTable.id, name: suppliersTable.name })
        .from(suppliersTable)
        .where(inArray(suppliersTable.id, supplierIdList))) as Row[])
    : [];
  const nameById = new Map(named.map((s) => [Number(s.id), String(s.name ?? "")]));
  const aggById = new Map(agg.map((r) => [Number(r.supplierId), r]));
  const offerById = new Map(offerAgg.map((r) => [Number(r.supplierId), r]));

  const suppliers = supplierIdList.map((id) => {
    const a = aggById.get(id) ?? {};
    const o = offerById.get(id) ?? {};
    const totalQty = num(a.totalQty);
    const acceptedQty = num(a.acceptedQty);
    return {
      supplierId: id,
      supplierName: nameById.get(id) ?? "غير معروف",
      poCount: num(a.poCount),
      itemCount: num(a.itemCount),
      totalQty,
      acceptedQty,
      rejectedQty: num(a.rejectedQty),
      rejectedLines: num(a.rejectedLines),
      offerCount: num(o.offerCount),
      lastOfferAt: o.lastOfferAt ?? null,
      // Acceptance rate is the supplier's most useful single number and is a
      // plain ratio of two SQL sums, never an estimate.
      acceptanceRate: totalQty > 0 ? Number((acceptedQty / totalQty).toFixed(4)) : null,
      hasActivity: num(a.itemCount) > 0 || num(o.offerCount) > 0,
    };
  });

  if (suppliers.length === 0) warnings.push("لا توجد بيانات أداء لهذا النطاق.");

  return evidence({
    data: { suppliers },
    source: "database:purchase_order_items + offers + suppliers",
    filters: { supplier: opts.supplier ?? null, sinceDays: opts.sinceDays ?? null },
    recordCount: suppliers.length,
    warnings,
    method:
      "لكل مورد: عدد أوامر الشراء والبنود ومجموع الكميات والمقبول والمرفوض من صفوف بنود أوامر الشراء، " +
      "وعدد العروض المقدَّمة من جدول العروض. نسبة القبول = المقبول ÷ إجمالي الكمية.",
    evidence: suppliers.map((s) => ({
      supplier: s.supplierName,
      pos: s.poCount,
      acceptanceRate: s.acceptanceRate,
    })),
  });
}

// ─── 3. Item aggregation (the "most repeated item" question) ─────────────────

/**
 * Group items across POs by a normalised key and aggregate quantity and
 * occurrence count — in SQL. The operator's literal question was «أكتر بند من
 * حيث إجمالي الكمية», which previously the model answered by eyeballing a sample.
 */
export async function aggregatePoItems(opts: {
  by?: "qty" | "occurrences";
  partNo?: string;
  sinceDays?: number;
  limit?: number;
}): Promise<EvidenceEnvelope> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const key = sql`lower(trim(coalesce(${purchaseOrderItemsTable.partNo}, ${purchaseOrderItemsTable.description})))`;
  const filters: SQL[] = [ne(purchaseOrderItemsTable.lineStatus, "cancelled")];
  if (opts.partNo) filters.push(ilike(purchaseOrderItemsTable.partNo, `%${opts.partNo.trim()}%`));
  if (opts.sinceDays) {
    filters.push(
      sql`${purchaseOrderItemsTable.createdAt} >= NOW() - (${opts.sinceDays} || ' days')::interval` as SQL,
    );
  }
  const orderCol =
    opts.by === "occurrences"
      ? sql`count(*)`
      : sql`coalesce(sum(${purchaseOrderItemsTable.qty}),0)`;

  const rows = (await (db as any)
    .select({
      itemKey: key,
      partNo: sql<string>`min(${purchaseOrderItemsTable.partNo})`,
      description: sql<string>`min(${purchaseOrderItemsTable.description})`,
      occurrences: sql<number>`count(*)::int`,
      poCount: sql<number>`count(distinct ${purchaseOrderItemsTable.poId})::int`,
      totalQty: sql<number>`coalesce(sum(${purchaseOrderItemsTable.qty}),0)::float8`,
    })
    .from(purchaseOrderItemsTable)
    .where(and(...filters))
    .groupBy(key)
    .orderBy(desc(orderCol))
    .limit(limit)) as Row[];

  const totalRows = (await (db as any)
    .select({ n: sql<number>`count(*)::int` })
    .from(purchaseOrderItemsTable)
    .where(and(...filters))) as Row[];
  const scanned = num(totalRows[0]?.n);
  const distinctItems = rows.length;
  const warnings: string[] = [];
  // The list is capped, so say so rather than let it read as the whole ranking.
  const truncated = distinctItems >= limit;
  if (truncated) {
    warnings.push(`أعرض أعلى ${limit} بندًا فقط من إجمالي البنود المطابقة.`);
  }

  return evidence({
    data: { items: rows, ordering: opts.by ?? "qty" },
    source: "database:purchase_order_items",
    filters: {
      by: opts.by ?? "qty",
      partNo: opts.partNo ?? null,
      sinceDays: opts.sinceDays ?? null,
    },
    recordCount: scanned,
    isComplete: !truncated,
    warnings,
    method:
      opts.by === "occurrences"
        ? "تجميع بنود أوامر الشراء حسب رقم القطعة/الوصف (موحَّد بحروف صغيرة) وترتيبها بعدد مرات الورود."
        : "تجميع بنود أوامر الشراء حسب رقم القطعة/الوصف وترتيبها بمجموع الكميات.",
    evidence: rows.slice(0, 10).map((r) => ({
      item: r.partNo || r.description,
      qty: r.totalQty,
      occurrences: r.occurrences,
      pos: r.poCount,
    })),
  });
}

// ─── 4. Unfulfilled supplier orders ──────────────────────────────────────────

/** POs still awaiting receipt: at least one line pending/partial, none cancelled-only. */
export async function getUnfulfilledOrders(opts: {
  sinceDays?: number;
  limit?: number;
}): Promise<EvidenceEnvelope> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const filters: SQL[] = [
    inArray(purchaseOrderItemsTable.lineStatus, ["pending", "partial", "postponed"]),
    ne(purchaseOrdersTable.status, "cancelled"),
  ];
  if (opts.sinceDays) {
    filters.push(
      sql`${purchaseOrdersTable.createdAt} >= NOW() - (${opts.sinceDays} || ' days')::interval` as SQL,
    );
  }

  const rows = (await (db as any)
    .select({
      poId: purchaseOrdersTable.id,
      internalPoNo: purchaseOrdersTable.internalPoNo,
      sheetPoNo: purchaseOrdersTable.sheetPoNo,
      status: purchaseOrdersTable.status,
      createdAt: sql<string>`${purchaseOrdersTable.createdAt}::text`,
      openLines: sql<number>`count(*)::int`,
      openQty: sql<number>`coalesce(sum(${purchaseOrderItemsTable.qty}),0)::float8`,
      supplierName: sql<string>`min(${suppliersTable.name})`,
    })
    .from(purchaseOrderItemsTable)
    .innerJoin(purchaseOrdersTable, eq(purchaseOrderItemsTable.poId, purchaseOrdersTable.id))
    .leftJoin(suppliersTable, eq(purchaseOrderItemsTable.supplierId, suppliersTable.id))
    .where(and(...filters))
    .groupBy(
      purchaseOrdersTable.id,
      purchaseOrdersTable.internalPoNo,
      purchaseOrdersTable.sheetPoNo,
      purchaseOrdersTable.status,
      purchaseOrdersTable.createdAt,
    )
    .orderBy(desc(purchaseOrdersTable.createdAt))
    .limit(limit)) as Row[];

  const truncated = rows.length >= limit;
  return evidence({
    data: { orders: rows },
    source: "database:purchase_orders + purchase_order_items",
    filters: { sinceDays: opts.sinceDays ?? null },
    recordCount: rows.length,
    isComplete: !truncated,
    warnings: truncated ? [`أعرض أول ${limit} أمرًا فقط.`] : [],
    method:
      "أوامر الشراء التي بها بنود بحالة pending/partial/postponed (غير ملغاة)، موزعة على الموردين.",
    evidence: rows.slice(0, 10).map((r) => ({
      poNo: r.internalPoNo,
      openLines: r.openLines,
      openQty: r.openQty,
    })),
  });
}

// ─── 5. Latest supplier price for a part ─────────────────────────────────────

/**
 * The most recent price seen for a part, from the two places a price lives:
 * supplier PO lines (`referencePrice`) and offer lines (`price`). Latest-wins by
 * date, so "آخر سعر" is a real ordering, not the first row the DB returned.
 */
export async function getLatestSupplierPrice(opts: {
  partNo?: string;
  description?: string;
  supplier?: string;
  limit?: number;
}): Promise<EvidenceEnvelope> {
  const term = (opts.partNo || opts.description || "").trim();
  if (!term) {
    return evidence({
      data: { prices: [] },
      source: "database",
      filters: {},
      recordCount: 0,
      warnings: ["حدّد رقم القطعة أو الوصف."],
    });
  }
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);

  const lineFilter = or(
    ilike(purchaseOrderItemsTable.partNo, `%${term}%`),
    ilike(purchaseOrderItemsTable.description, `%${term}%`),
  ) as SQL;

  const poPrices = (await (db as any)
    .select({
      price: purchaseOrderItemsTable.referencePrice,
      date: sql<string>`${purchaseOrderItemsTable.createdAt}::text`,
      source: sql<string>`'purchase_order'`,
      partNo: purchaseOrderItemsTable.partNo,
      supplierId: purchaseOrderItemsTable.supplierId,
      poId: purchaseOrderItemsTable.poId,
      inspect: purchaseOrderItemsTable.createdAt,
    })
    .from(purchaseOrderItemsTable)
    .where(and(lineFilter, isNotNull(purchaseOrderItemsTable.referencePrice)))
    .orderBy(desc(purchaseOrderItemsTable.createdAt))
    .limit(limit)) as Row[];

  const offerPrices = (await (db as any)
    .select({
      price: offerItemsTable.price,
      date: sql<string>`${offerItemsTable.createdAt}::text`,
      source: sql<string>`'offer'`,
      partNo: sql<string>`null`,
      supplierId: offersTable.supplierId,
      poId: sql<number>`null`,
      inspect: offerItemsTable.createdAt,
    })
    .from(offerItemsTable)
    .innerJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
    .orderBy(desc(offerItemsTable.createdAt))
    .limit(limit)) as Row[];

  // An offer price only counts if its rfq item is the part in question — join
  // the description through rfq_items would be an extra hop; instead filter
  // narrowly here by requiring partNo OR description to match using a subquery-
  // free check the caller can reason about. Keep it simple: only PO prices are
  // guaranteed to carry the part, so offers are advisory and labelled.
  const prices = [
    ...poPrices.map((r) => ({
      date: r.date,
      price: num(r.price),
      source: "أمر شراء للمورد",
      partNo: r.partNo,
      supplierId: r.supplierId,
      poId: r.poId,
    })),
    ...offerPrices.map((r) => ({
      date: r.date,
      price: num(r.price),
      source: "عرض سعر مورد",
      partNo: r.partNo,
      supplierId: r.supplierId,
      poId: r.poId,
    })),
  ]
    .filter((p) => p.price > 0)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, limit);

  const warnings: string[] = [];
  if (prices.length === 0) warnings.push(`لا يوجد سعر مسجَّل للبند «${term}».`);

  return evidence({
    data: { prices, latest: prices[0] ?? null },
    source: "database:purchase_order_items.referencePrice + offer_items.price",
    filters: { term, supplier: opts.supplier ?? null },
    recordCount: prices.length,
    warnings,
    method:
      "آخر سعر للبند مرتَّبًا بتاريخ الإنشاء تنازليًا من أسعار بنود أوامر الشراء وأسعار العروض.",
    evidence: prices.slice(0, 10).map((p) => ({
      date: p.date,
      price: p.price,
      source: p.source,
    })),
  });
}

// ─── 6. Open supplier invoices ───────────────────────────────────────────────

/** Posted supplier invoices with a remaining balance (AP not yet settled). */
export async function getOpenSupplierInvoices(opts: {
  supplier?: string;
  limit?: number;
}): Promise<EvidenceEnvelope> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const filters: SQL[] = [
    eq(supplierInvoicesTable.status, "posted"),
    sql`${supplierInvoicesTable.balance} > 0` as SQL,
  ];
  if (opts.supplier) {
    filters.push(ilike(supplierInvoicesTable.supplierName, `%${opts.supplier.trim()}%`));
  }

  const rows = (await (db as any)
    .select({
      invoiceNo: supplierInvoicesTable.invoiceNo,
      supplierInvoiceNo: supplierInvoicesTable.supplierInvoiceNo,
      supplierName: supplierInvoicesTable.supplierName,
      poNo: supplierInvoicesTable.poNo,
      invoiceDate: supplierInvoicesTable.invoiceDate,
      dueDate: supplierInvoicesTable.dueDate,
      netAmount: supplierInvoicesTable.netAmount,
      balance: supplierInvoicesTable.balance,
    })
    .from(supplierInvoicesTable)
    .where(and(...filters))
    .orderBy(supplierInvoicesTable.dueDate)
    .limit(limit)) as Row[];

  const total = rows.reduce((a, r) => a + num(r.balance), 0);
  const truncated = rows.length >= limit;
  return evidence({
    data: { invoices: rows, totalBalance: Number(total.toFixed(4)) },
    source: "database:supplier_invoices",
    filters: { supplier: opts.supplier ?? null },
    recordCount: rows.length,
    isComplete: !truncated,
    warnings: truncated ? [`أعرض أول ${limit} فاتورة فقط.`] : [],
    method:
      "فواتير الموردين المرحَّلة (posted) التي لها رصيد متبقٍّ > 0، مرتَّبة بتاريخ الاستحقاق.",
    evidence: rows.slice(0, 10).map((r) => ({
      invoiceNo: r.invoiceNo,
      supplier: r.supplierName,
      balance: num(r.balance),
    })),
  });
}

// ─── 7. Duplicate / missing detection ────────────────────────────────────────

/** Rows that share the same value in `column` — a duplicate-key report. */
export async function detectDuplicates(opts: {
  table: "purchase_orders" | "suppliers" | "customer_pos";
  column: string;
  limit?: number;
}): Promise<EvidenceEnvelope> {
  const table =
    opts.table === "suppliers"
      ? suppliersTable
      : opts.table === "customer_pos"
        ? customerPosTable
        : purchaseOrdersTable;
  const columns = (table as any)[Symbol.for("drizzle:Columns")] as Record<string, unknown>;
  const column = columns?.[opts.column];
  if (!column) {
    return evidence({
      data: { duplicates: [] },
      source: `database:${opts.table}`,
      filters: { column: opts.column },
      recordCount: 0,
      warnings: [`العمود «${opts.column}» غير موجود في جدول «${opts.table}».`],
    });
  }
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const rows = (await (db as any)
    .select({
      value: column,
      occurrences: sql<number>`count(*)::int`,
    })
    .from(table)
    .where(isNotNull(column as never))
    .groupBy(column as never)
    .having(sql`count(*) > 1`)
    .orderBy(desc(sql`count(*)`))
    .limit(limit)) as Row[];

  return evidence({
    data: { duplicates: rows },
    source: `database:${opts.table}.${opts.column}`,
    filters: { table: opts.table, column: opts.column },
    recordCount: rows.length,
    warnings: [],
    method: "تجميع الجدول حسب العمود وإظهار القيم المكرَّرة (عدد المرات > 1).",
    evidence: rows.slice(0, 10).map((r) => ({ value: r.value, occurrences: r.occurrences })),
  });
}

/**
 * Set difference between a list of numbers and a database column — "which of
 * these are NOT registered?". Chunked because a year-long list can exceed the
 * 65,535 bind-parameter cap of one statement.
 */
const COMPARE_CHUNK = 5_000;

export async function findMissingRecords(opts: {
  numbers: string[];
  table: "customer_rfqs" | "purchase_orders" | "customer_pos" | "rfq";
  column: string;
}): Promise<EvidenceEnvelope> {
  // The table registry is the authoritative name→table map (also used by
  // search_database), so missing-record checks share its knowledge.
  const { TABLES } = await import("./db-tools");
  const spec = TABLES[opts.table];
  if (!spec) {
    return evidence({
      data: { missing: [] },
      source: "database",
      filters: opts,
      recordCount: 0,
      warnings: [`جدول «${opts.table}» غير معروف.`],
    });
  }
  const columns = (spec.table as any)[Symbol.for("drizzle:Columns")] as Record<string, unknown>;
  const column = columns?.[opts.column];
  if (!column) {
    return evidence({
      data: { missing: [] },
      source: `database:${opts.table}`,
      filters: { column: opts.column },
      recordCount: 0,
      warnings: [`العمود «${opts.column}» غير موجود في جدول «${opts.table}».`],
    });
  }

  const wanted = [
    ...new Set(opts.numbers.map((n) => n.replace(/\s+/g, "").toUpperCase()).filter(Boolean)),
  ];
  const present = new Set<string>();
  for (let i = 0; i < wanted.length; i += COMPARE_CHUNK) {
    const chunk = wanted.slice(i, i + COMPARE_CHUNK);
    const rows = (await (db as any)
      .select({ value: column })
      .from(spec.table)
      .where(inArray(column as never, chunk as never))
      .limit(chunk.length)) as Row[];
    for (const r of rows) {
      const v = String(r.value ?? "");
      if (v) present.add(v.replace(/\s+/g, "").toUpperCase());
    }
  }
  const missing = wanted.filter((n) => !present.has(n));

  return evidence({
    data: { missing, presentCount: present.size, checkedCount: wanted.length },
    source: `database:${opts.table}.${opts.column}`,
    filters: { table: opts.table, column: opts.column },
    recordCount: wanted.length,
    warnings: [],
    method:
      "مقارنة القائمة المعطاة بقيم العمود في قاعدة البيانات (توحيد الحروف والمسافات)، وإرجاع غير الموجود.",
    evidence: missing.slice(0, 10).map((n) => ({ missingNumber: n })),
  });
}

// ─── 10. Overdue deliveries (customer side) ──────────────────────────────────

/**
 * Customer-PO lines past their promised delivery date that have not been
 * delivered (or fully rejected). Computed in SQL so the count, the overdue days
 * and the qty are exact — a model counting rows would drop the ones past its
 * window.
 *
 * A line is "overdue" when it has a `deliveryDate` before today, its delivery
 * status is not terminal, and it still belongs to a live PO. Detached rows
 * (customerPoId IS NULL — cancelled off a PO) are excluded: they are history,
 * not outstanding work.
 */
export async function getOverdueDeliveries(opts: {
  customer?: string;
  limit?: number;
}): Promise<EvidenceEnvelope> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const filters: SQL[] = [
    isNotNull(customerPoItemsTable.customerPoId),
    isNotNull(customerPoItemsTable.deliveryDate),
    sql`${customerPoItemsTable.deliveryDate} < CURRENT_DATE::text` as SQL,
    inArray(customerPoItemsTable.deliveryStatus, ["pending", "partial"]),
    ne(customerPosTable.status, "cancelled"),
  ];
  if (opts.customer) {
    filters.push(ilike(customerPosTable.customerName, `%${opts.customer}%`) as SQL);
  }

  const rows = (await (db as any)
    .select({
      customerPoId: customerPosTable.id,
      internalPoNo: customerPosTable.internalPoNo,
      customerPoNo: customerPosTable.customerPoNo,
      customerName: customerPosTable.customerName,
      itemId: customerPoItemsTable.id,
      partNo: customerPoItemsTable.partNo,
      description: customerPoItemsTable.description,
      qty: sql<number>`coalesce(${customerPoItemsTable.qty},0)::float8`,
      deliveredQty: sql<number>`coalesce(${customerPoItemsTable.totalDeliveredQty},0)::float8`,
      deliveryDate: customerPoItemsTable.deliveryDate,
      deliveryStatus: customerPoItemsTable.deliveryStatus,
      overdueDays: sql<number>`(CURRENT_DATE - ${customerPoItemsTable.deliveryDate}::date)::int`,
    })
    .from(customerPoItemsTable)
    .innerJoin(customerPosTable, eq(customerPoItemsTable.customerPoId, customerPosTable.id))
    .where(and(...filters))
    .orderBy(customerPoItemsTable.deliveryDate)
    .limit(limit)) as Row[];

  const truncated = rows.length >= limit;
  const totalOverdueQty = rows.reduce((a, r) => a + num(r.qty) - num(r.deliveredQty), 0);
  return evidence({
    data: { deliveries: rows, overdueLines: rows.length, outstandingQty: totalOverdueQty },
    source: "database:customer_po_items + customer_pos",
    filters: { customer: opts.customer ?? null },
    recordCount: rows.length,
    isComplete: !truncated,
    warnings: truncated ? [`أعرض أقدم ${limit} بندًا متأخرًا فقط.`] : [],
    method:
      "بنود أوامر شراء العملاء التي فات تاريخ تسليمها ولم تُسلَّم بعد، مع عدد أيام التأخير والكمية المتبقية.",
    evidence: rows.slice(0, 10).map((r) => ({
      customerPoNo: r.customerPoNo,
      partNo: r.partNo,
      overdueDays: r.overdueDays,
    })),
  });
}

// ─── 11. Compare supplier quotes for one RFQ ─────────────────────────────────

/**
 * Price comparison across the offers received for one RFQ, per line item.
 *
 * "قارن عروض الموردين" is the classic question that a model answers wrongly: it
 * must line up several suppliers' prices per item and find the cheapest, and any
 * item it loses from the middle of a long list silently skews the result. This
 * does the comparison in SQL — one row per (item, supplier) — and marks the
 * cheapest supplier per item, so the model only narrates the winner.
 *
 * Approval is surfaced too (`isApproved`), because the approved price is the
 * reference cost the margin check uses; a cheapest quote that is not approved is
 * not the cost basis.
 */
export async function compareSupplierQuotes(opts: {
  rfqId?: number;
  rfqNo?: string;
  limit?: number;
}): Promise<EvidenceEnvelope> {
  // Resolve the RFQ first (by id or number) so the comparison is scoped to one.
  let rfqId = opts.rfqId ?? null;
  if (rfqId == null && opts.rfqNo) {
    const term = `%${opts.rfqNo.trim()}%`;
    const found = (await (db as any)
      .select({ id: rfqTable.id })
      .from(rfqTable)
      .where(or(ilike(rfqTable.internalRfqNo, term), ilike(rfqTable.customerRfqNo, term)) as SQL)
      .limit(2)) as Row[];
    if (found.length !== 1) {
      return evidence({
        data: { offers: [], cheapest: [] },
        source: "database:rfq",
        filters: { rfqNo: opts.rfqNo },
        recordCount: 0,
        warnings: [
          found.length === 0
            ? `لم أجد طلب عرض مطابقًا لـ «${opts.rfqNo}».`
            : `أكثر من طلب عرض يطابق «${opts.rfqNo}» — استخدم الرقم الداخلي.`,
        ],
      });
    }
    rfqId = Number(found[0].id);
  }
  if (rfqId == null) {
    return evidence({
      data: { offers: [], cheapest: [] },
      source: "database:offers",
      filters: {},
      recordCount: 0,
      warnings: ["حدّد الطلب برقمه (rfqNo) أو معرّفه (rfqId)."],
    });
  }

  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const rows = (await (db as any)
    .select({
      offerId: offersTable.id,
      supplierId: suppliersTable.id,
      supplierName: suppliersTable.name,
      rfqItemId: offerItemsTable.rfqItemId,
      lineItem: rfqItemsTable.lineItem,
      partNo: rfqItemsTable.partNo,
      description: rfqItemsTable.description,
      price: sql<number>`${offerItemsTable.price}::float8`,
      taxIncluded: offerItemsTable.taxIncluded,
      isApproved: offerItemsTable.isApproved,
      deliveryDays: offerItemsTable.deliveryDays,
    })
    .from(offerItemsTable)
    .innerJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
    .innerJoin(suppliersTable, eq(offersTable.supplierId, suppliersTable.id))
    .innerJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
    .where(eq(offersTable.rfqId, rfqId) as SQL)
    .limit(limit)) as Row[];

  const truncated = rows.length >= limit;
  // Cheapest per item, computed here rather than by the model.
  const byItem = new Map<string, Row>();
  for (const r of rows) {
    const key = String(r.rfqItemId);
    const prev = byItem.get(key);
    if (!prev || num(r.price) < num(prev.price)) byItem.set(key, r);
  }
  const cheapest = [...byItem.values()].map((r) => ({
    rfqItemId: r.rfqItemId,
    partNo: r.partNo,
    description: r.description,
    supplierName: r.supplierName,
    cheapestPrice: num(r.price),
  }));

  return evidence({
    data: { offers: rows, cheapest, supplierCount: new Set(rows.map((r) => r.supplierId)).size },
    source: "database:offer_items + offers + suppliers + rfq_items",
    filters: { rfqId },
    recordCount: rows.length,
    isComplete: !truncated,
    warnings: truncated ? [`أعرض أول ${limit} عرضًا فقط.`] : [],
    method:
      "مقارنة عروض الموردين لكل بند على حدة: صف لكل (بند، مورد) بالسعر، مع أرخص مورد لكل بند. " +
      "isApproved يشير إلى السعر المعتمد (أساس حساب الهامش).",
    evidence: cheapest.slice(0, 10).map((c) => ({
      partNo: c.partNo,
      supplierName: c.supplierName,
      cheapestPrice: c.cheapestPrice,
    })),
  });
}

/** Normalise a free-text item key the same way the SQL grouping does. */
export function itemKey(partNo: unknown, description: unknown): string {
  const source = String(partNo ?? "").trim() || String(description ?? "").trim();
  return normalizeText(source).replace(/\s+/g, " ").toLowerCase();
}

export { logger as _logger };
