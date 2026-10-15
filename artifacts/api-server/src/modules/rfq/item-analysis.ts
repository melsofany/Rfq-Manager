/**
 * Item price analysis — تحليل البنود والاتجاه السعري
 *
 * The operator's request: search an item by description, part number or line
 * item, pick it, then see the price analysis, the price TREND, every time it was
 * priced, and who brought each price.
 *
 * ## Why this is not just «more of the same search»
 *
 * The existing `/items/search` returns one card PER rfq_item — the same article
 * quoted on ten different RFQs appears ten times, so no trend can be read from
 * it. Prices are also stored on two different bases (`tax_included` true/false),
 * and comparing a VAT-inclusive quote against a VAT-exclusive one reports a
 * price movement that never happened.
 *
 * So this module does two things the old search cannot:
 *
 *  1. **Groups the rows into ONE item** using the same identity rule the rest of
 *     the system uses (`item-identity.ts`): part number → ERP line-item code →
 *     folded description. Two different part numbers never merge, and a
 *     description-only row joins a part-numbered item only when exactly ONE
 *     cluster matches — an ambiguous match is left separate rather than
 *     silently attributed to the wrong article.
 *  2. **Normalises every price to a VAT-exclusive basis** (`netOfTax`, the
 *     accounts module's single convention) before any comparison, average or
 *     trend. The raw quoted figure is still shown, so nothing is hidden.
 *
 * ## Honesty rules carried over from the rest of this codebase
 *
 *  - A price of `0` is NOT a price. Suppliers routinely submit an empty quote
 *    (`offer_submitted` true, price 0), and counting those as prices drags the
 *    average to zero. They are counted separately (`zeroPriceCount`).
 *  - A trend is never invented: fewer than `MIN_TREND_POINTS` priced quotes
 *    returns `insufficient` rather than a direction guessed from one point.
 *  - The result reports whether the row read was cut (`truncated`), so a partial
 *    answer cannot be read as a total.
 */
import { Router } from "express";
import {
  db,
  rfqItemsTable,
  rfqTable,
  customerRfqItemsTable,
  customerRfqsTable,
  customersTable,
  offerItemsTable,
  offersTable,
  suppliersTable,
  employeesTable,
  sentLogTable,
  itemCategoriesTable,
} from "@workspace/db";
import { eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { canonicalDescription } from "../ai-assistant/sql-registry";
import { canonicalPartNo, buildItemIdentity, itemsEquivalent } from "../ai-assistant/item-identity";
import { loadTaxSettings } from "../accounts/helpers";
import { netOfTax, round2 } from "../accounts/tax";

const router = Router();

// ── Tuning ───────────────────────────────────────────────────────────────────
/** Matching rows examined per source. A cap exists so one query cannot exhaust
 *  memory; when it bites, the response says so (`truncated`). */
const SEARCH_ROW_CAP = 1_500;
/** Clusters returned for the picker list. */
const DEFAULT_CLUSTER_LIMIT = 40;
/** Priced quotes needed before a direction is stated. */
const MIN_TREND_POINTS = 3;
/** A change smaller than this (%) is reported as flat, not as a trend. */
const FLAT_BAND_PCT = 3;

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * The ERP's own article code (`5710.018.GENRAL.1306`, `1531.032.GENRAL.7513`).
 *
 * It is stable for one article and is what the operator actually searches by,
 * so it is a stronger identity than prose. The guard keeps a plain short line
 * number (`10`) from being treated as an article code — those are row numbers,
 * and two unrelated rows numbered `10` are not the same item.
 */
export function looksLikeErpCode(lineItem: string | null | undefined): boolean {
  const v = (lineItem ?? "").trim();
  if (!v) return false;
  if (v.length < 6) return false;
  return /[.\-/]/.test(v) || /[A-Za-z]/.test(v);
}

/**
 * The identity key of one row: part number → ERP line-item code → folded
 * description. A row carrying no identity at all is grouped by its raw
 * description so it can never vanish from the result.
 */
export function clusterKeyOf(row: {
  partNo?: string | null;
  lineItem?: string | null;
  description?: string | null;
}): string {
  const pn = canonicalPartNo(row.partNo);
  if (pn) return `pn:${pn}`;
  if (looksLikeErpCode(row.lineItem)) return `li:${String(row.lineItem).trim().toLowerCase()}`;
  const desc = canonicalDescription(row.description ?? "");
  if (desc) return `desc:${desc}`;
  return `raw:${String(row.description ?? "")
    .trim()
    .toLowerCase()}`;
}

/** The kind of a cluster key, used to build a targeted DB lookup. */
export type ClusterKeyKind = "pn" | "li" | "desc" | "raw";

export function parseClusterKey(key: string): { kind: ClusterKeyKind; value: string } | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const kind = key.slice(0, i);
  if (kind !== "pn" && kind !== "li" && kind !== "desc" && kind !== "raw") return null;
  return { kind, value: key.slice(i + 1) };
}

// ── Price statistics (pure) ──────────────────────────────────────────────────

export interface PricePoint {
  rfqItemId: number | null;
  /** The offer the quote belongs to — the identity of a price OBSERVATION. */
  offerId: number | null;
  date: string | null;
  supplierId: number | null;
  supplierName: string;
  /** The figure as the supplier quoted it. */
  price: number;
  /** The same figure on a VAT-exclusive basis (comparable across quotes). */
  priceNet: number;
  taxIncluded: boolean;
  rfqId: number | null;
  internalRfqNo: string | null;
  customerRfqNo: string | null;
  employeeId: number | null;
  employeeName: string | null;
  isApproved: boolean;
}

export interface TrendSeriesPoint {
  month: string;
  avgPriceNet: number;
  count: number;
}

export interface PriceStats {
  /** Quotes that actually carry a price (> 0). */
  pricedCount: number;
  /** Quotes submitted with no price at all (an empty offer is not a price). */
  zeroPriceCount: number;
  firstPriceNet: number | null;
  lastPriceNet: number | null;
  minPriceNet: number | null;
  maxPriceNet: number | null;
  avgPriceNet: number | null;
  medianPriceNet: number | null;
  lastPrice: number | null;
  lastPriceDate: string | null;
  lastSupplierName: string | null;
  /** Percentage change between the early and the recent half of the quotes. */
  changePct: number | null;
  direction: "up" | "down" | "flat" | "insufficient";
  series: TrendSeriesPoint[];
}

/** Sorted ascending by date; undated points keep their incoming order at the end. */
export function sortByDate(points: PricePoint[]): PricePoint[] {
  return [...points].sort((a, b) => {
    const at = a.date ? Date.parse(a.date) : Number.POSITIVE_INFINITY;
    const bt = b.date ? Date.parse(b.date) : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return 0;
  });
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : round2((s[mid - 1] + s[mid]) / 2);
}

/**
 * THE price-analysis rule — the single implementation both the list and the
 * detail endpoint use, so a badge and a chart can never disagree.
 *
 * The trend compares the average of the EARLIER half of the priced quotes with
 * the average of the LATER half. Comparing only the newest against the oldest
 * quote reports a 40% "movement" from one outlier; a half-to-half average is
 * stable on the noisy real data while still showing a genuine drift. Fewer than
 * `MIN_TREND_POINTS` quotes returns `insufficient` — a direction derived from a
 * single price is a fabrication, not an analysis.
 */
export function computePriceStats(points: PricePoint[]): PriceStats {
  const priced = sortByDate(points.filter((p) => p.price > 0));
  const zeroPriceCount = points.length - priced.length;
  const nets = priced.map((p) => p.priceNet);

  const seriesMap = new Map<string, { sum: number; count: number }>();
  for (const p of priced) {
    if (!p.date) continue;
    const month = p.date.slice(0, 7);
    const cur = seriesMap.get(month) ?? { sum: 0, count: 0 };
    cur.sum += p.priceNet;
    cur.count += 1;
    seriesMap.set(month, cur);
  }
  const series: TrendSeriesPoint[] = [...seriesMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, avgPriceNet: round2(v.sum / v.count), count: v.count }));

  let changePct: number | null = null;
  let direction: PriceStats["direction"] = "insufficient";
  if (priced.length >= MIN_TREND_POINTS) {
    const half = Math.floor(priced.length / 2);
    const early = nets.slice(0, half);
    const recent = nets.slice(priced.length - half);
    const earlyAvg = early.reduce((a, b) => a + b, 0) / early.length;
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (earlyAvg > 0) {
      changePct = round2(((recentAvg - earlyAvg) / earlyAvg) * 100);
      direction = Math.abs(changePct) < FLAT_BAND_PCT ? "flat" : changePct > 0 ? "up" : "down";
    }
  }

  const last = priced.length ? priced[priced.length - 1] : null;
  return {
    pricedCount: priced.length,
    zeroPriceCount,
    firstPriceNet: nets.length ? nets[0] : null,
    lastPriceNet: last ? last.priceNet : null,
    minPriceNet: nets.length ? Math.min(...nets) : null,
    maxPriceNet: nets.length ? Math.max(...nets) : null,
    avgPriceNet: nets.length ? round2(nets.reduce((a, b) => a + b, 0) / nets.length) : null,
    medianPriceNet: median(nets),
    lastPrice: last ? last.price : null,
    lastPriceDate: last ? last.date : null,
    lastSupplierName: last ? last.supplierName : null,
    changePct,
    direction,
    series,
  };
}

// ── Clustering ───────────────────────────────────────────────────────────────

export interface ClusterMember {
  source: "supplier_rfq" | "customer_rfq";
  rfqItemId: number | null;
  customerRfqItemId: number | null;
  partNo: string | null;
  lineItem: string | null;
  description: string | null;
  uom: string | null;
  qty: number | null;
  rfqId: number | null;
  internalRfqNo: string | null;
  customerRfqNo: string | null;
  customerRfqId: number | null;
  customerName: string | null;
  date: string | null;
  categoryId: number | null;
}

export interface ItemCluster {
  key: string;
  partNos: string[];
  lineItems: string[];
  /** The LONGEST description seen — the most complete rendering of the item. */
  description: string;
  uom: string | null;
  categoryId: number | null;
  /** Distinct customer requests + distinct supplier RFQs this item appeared on. */
  requestCount: number;
  supplierRfqCount: number;
  totalQty: number;
  lastRequestedAt: string | null;
  members: ClusterMember[];
}

function longestDescription(rows: ClusterMember[]): string | null {
  let best: string | null = null;
  for (const r of rows) {
    const d = (r.description ?? "").trim();
    if (d && (!best || d.length > best.length)) best = d;
  }
  return best;
}

/**
 * Group the matched rows into items.
 *
 * Part-numbered rows are keyed directly. A row with NO part number is first
 * keyed on its ERP code / description, then — when exactly ONE part-numbered
 * cluster is equivalent to it — folded into that cluster. This is the operator's
 * documented case (the same article printed with a code on one RFQ and by
 * description on the next). An ambiguous match is deliberately NOT merged: a
 * wrong merge misreports a price history, which is worse than a split one.
 */
export function clusterMembers(members: ClusterMember[]): ItemCluster[] {
  const byKey = new Map<string, ClusterMember[]>();
  for (const m of members) {
    const key = clusterKeyOf(m);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(m);
  }

  const partNumbered = [...byKey.entries()].filter(([k]) => k.startsWith("pn:"));
  if (partNumbered.length) {
    const identities = partNumbered.map(([k, rows]) => ({
      key: k,
      identity: buildItemIdentity({
        partNo: rows[0].partNo,
        description: longestDescription(rows) ?? "",
      }),
    }));
    for (const [key, rows] of [...byKey.entries()]) {
      if (key.startsWith("pn:")) continue;
      const own = buildItemIdentity({
        partNo: null,
        description: longestDescription(rows) ?? "",
      });
      const matches = identities.filter((c) => itemsEquivalent(own, c.identity));
      if (matches.length === 1) {
        byKey.get(matches[0].key)!.push(...rows);
        byKey.delete(key);
      }
    }
  }

  const clusters: ItemCluster[] = [];
  for (const [key, rows] of byKey.entries()) {
    const partNos = new Set<string>();
    const lineItems = new Set<string>();
    const supplierRfqs = new Set<number>();
    const customerRfqs = new Set<number>();
    let totalQty = 0;
    let uom: string | null = null;
    let categoryId: number | null = null;
    let lastRequestedAt: string | null = null;

    for (const r of rows) {
      const pn = (r.partNo ?? "").trim();
      if (pn) partNos.add(pn);
      const li = (r.lineItem ?? "").trim();
      if (li) lineItems.add(li);
      if (r.rfqId != null) supplierRfqs.add(r.rfqId);
      if (r.customerRfqId != null) customerRfqs.add(r.customerRfqId);
      totalQty += r.qty ?? 0;
      if (!uom && r.uom) uom = r.uom;
      if (categoryId == null && r.categoryId != null) categoryId = r.categoryId;
      if (r.date && (!lastRequestedAt || r.date > lastRequestedAt)) lastRequestedAt = r.date;
    }

    clusters.push({
      key,
      partNos: [...partNos],
      lineItems: [...lineItems],
      description: longestDescription(rows) ?? "",
      uom,
      categoryId,
      requestCount: customerRfqs.size,
      supplierRfqCount: supplierRfqs.size,
      totalQty: round2(totalQty),
      lastRequestedAt,
      members: rows,
    });
  }
  return clusters;
}

/** Sort the picker list: most-quoted first, then most-requested, then newest. */
export function rankClusters(clusters: ItemCluster[], pricedByKey: Map<string, number>) {
  return [...clusters].sort((a, b) => {
    const pa = pricedByKey.get(a.key) ?? 0;
    const pb = pricedByKey.get(b.key) ?? 0;
    if (pa !== pb) return pb - pa;
    if (a.requestCount !== b.requestCount) return b.requestCount - a.requestCount;
    return (b.lastRequestedAt ?? "").localeCompare(a.lastRequestedAt ?? "");
  });
}

// ── DB loading ───────────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Load supplier-RFQ item rows matching `where`. */
async function loadSupplierRows(
  where: SQL | undefined,
  cap = SEARCH_ROW_CAP,
): Promise<ClusterMember[]> {
  const rows = await db
    .select({
      rfqItemId: rfqItemsTable.id,
      rfqId: rfqItemsTable.rfqId,
      internalRfqNo: rfqTable.internalRfqNo,
      customerRfqNo: rfqTable.customerRfqNo,
      partNo: rfqItemsTable.partNo,
      lineItem: rfqItemsTable.lineItem,
      description: rfqItemsTable.description,
      uom: rfqItemsTable.uom,
      qty: rfqItemsTable.qty,
      categoryId: rfqItemsTable.categoryId,
      createdAt: rfqTable.createdAt,
    })
    .from(rfqItemsTable)
    .innerJoin(rfqTable, eq(rfqItemsTable.rfqId, rfqTable.id))
    .where(where)
    .orderBy(sql`${rfqTable.createdAt} DESC`)
    .limit(cap);

  return rows.map((r) => ({
    source: "supplier_rfq" as const,
    rfqItemId: r.rfqItemId,
    customerRfqItemId: null,
    partNo: r.partNo ?? null,
    lineItem: r.lineItem ?? null,
    description: r.description ?? null,
    uom: r.uom ?? null,
    qty: toNum(r.qty),
    rfqId: r.rfqId,
    internalRfqNo: r.internalRfqNo ?? null,
    customerRfqNo: r.customerRfqNo ?? null,
    customerRfqId: null,
    customerName: null,
    date: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    categoryId: r.categoryId ?? null,
  }));
}

/** Load customer-request rows matching `where` (the «times requested» side). */
async function loadCustomerRows(
  where: SQL | undefined,
  cap = SEARCH_ROW_CAP,
): Promise<ClusterMember[]> {
  const rows = await db
    .select({
      customerRfqItemId: customerRfqItemsTable.id,
      customerRfqId: customerRfqItemsTable.customerRfqId,
      customerRfqNo: customerRfqsTable.customerRfqNo,
      internalNo: customerRfqsTable.internalNo,
      customerName: customerRfqsTable.customerName,
      storedCustomerName: customersTable.name,
      partNo: customerRfqItemsTable.partNo,
      lineItem: customerRfqItemsTable.lineItem,
      description: customerRfqItemsTable.description,
      uom: customerRfqItemsTable.uom,
      qty: customerRfqItemsTable.qty,
      categoryId: customerRfqItemsTable.categoryId,
      createdAt: customerRfqsTable.createdAt,
    })
    .from(customerRfqItemsTable)
    .innerJoin(customerRfqsTable, eq(customerRfqItemsTable.customerRfqId, customerRfqsTable.id))
    .leftJoin(customersTable, eq(customerRfqsTable.customerId, customersTable.id))
    .where(where)
    .orderBy(sql`${customerRfqsTable.createdAt} DESC`)
    .limit(cap);

  return rows.map((r) => ({
    source: "customer_rfq" as const,
    rfqItemId: null,
    customerRfqItemId: r.customerRfqItemId,
    partNo: r.partNo ?? null,
    lineItem: r.lineItem ?? null,
    description: r.description ?? null,
    uom: r.uom ?? null,
    qty: toNum(r.qty),
    rfqId: null,
    internalRfqNo: r.internalNo ?? null,
    customerRfqNo: r.customerRfqNo ?? null,
    customerRfqId: r.customerRfqId,
    customerName: (r.customerName ?? r.storedCustomerName ?? null) as string | null,
    date: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    categoryId: r.categoryId ?? null,
  }));
}

/** Resolve category names for a set of ids in ONE query (never an N+1). */
async function categoryNames(ids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  if (!unique.length) return new Map();
  const rows = await db
    .select({ id: itemCategoriesTable.id, name: itemCategoriesTable.name })
    .from(itemCategoriesTable)
    .where(inArray(itemCategoriesTable.id, unique));
  return new Map(rows.map((r) => [r.id, r.name ?? ""]));
}

/**
 * Load the price history for a set of supplier-RFQ item ids, in ONE query.
 *
 * `price > 0` is NOT filtered here — an empty quote is real information (the
 * supplier was asked and did not price it) and is counted separately rather
 * than silently dropped. The employee credited is the one who SENT the RFQ to
 * that supplier (`sent_log.employee_id`), falling back to the offer's own
 * employee — the same precedence the attribution module uses.
 */
async function loadPricePoints(
  rfqItemIds: (number | null)[],
  vatRate: number,
): Promise<PricePoint[]> {
  const ids = [...new Set(rfqItemIds.filter((n): n is number => n != null))];
  if (!ids.length) return [];

  const rows = await db
    .select({
      rfqItemId: offerItemsTable.rfqItemId,
      offerId: offersTable.id,
      price: offerItemsTable.price,
      taxIncluded: offerItemsTable.taxIncluded,
      isApproved: offerItemsTable.isApproved,
      offerCreatedAt: offersTable.createdAt,
      offerEmployeeId: offersTable.employeeId,
      sentEmployeeId: sentLogTable.employeeId,
      supplierId: suppliersTable.id,
      supplierName: suppliersTable.name,
      rfqId: rfqTable.id,
      internalRfqNo: rfqTable.internalRfqNo,
      customerRfqNo: rfqTable.customerRfqNo,
    })
    .from(offerItemsTable)
    .innerJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
    .leftJoin(sentLogTable, eq(offersTable.sentLogId, sentLogTable.id))
    .leftJoin(suppliersTable, eq(offersTable.supplierId, suppliersTable.id))
    .leftJoin(rfqItemsTable, eq(offerItemsTable.rfqItemId, rfqItemsTable.id))
    .leftJoin(rfqTable, eq(rfqItemsTable.rfqId, rfqTable.id))
    .where(inArray(offerItemsTable.rfqItemId, ids));

  const employeeIds = new Set<number>();
  for (const r of rows) {
    const id = r.offerEmployeeId ?? r.sentEmployeeId;
    if (id != null) employeeIds.add(id);
  }
  const employeeName = new Map<number, string>();
  if (employeeIds.size) {
    const emps = await db
      .select({ id: employeesTable.id, name: employeesTable.name })
      .from(employeesTable)
      .where(inArray(employeesTable.id, [...employeeIds]));
    for (const e of emps) employeeName.set(e.id, e.name ?? "");
  }

  return rows.map((r) => {
    const price = toNum(r.price) ?? 0;
    const empId = r.offerEmployeeId ?? r.sentEmployeeId ?? null;
    return {
      rfqItemId: r.rfqItemId,
      offerId: r.offerId ?? null,
      date: r.offerCreatedAt ? new Date(r.offerCreatedAt).toISOString() : null,
      supplierId: r.supplierId ?? null,
      supplierName: r.supplierName ?? "",
      price,
      priceNet: round2(netOfTax(price, r.taxIncluded ?? false, vatRate)),
      taxIncluded: r.taxIncluded ?? false,
      rfqId: r.rfqId ?? null,
      internalRfqNo: r.internalRfqNo ?? null,
      customerRfqNo: r.customerRfqNo ?? null,
      employeeId: empId,
      employeeName: empId != null ? (employeeName.get(empId) ?? null) : null,
      isApproved: r.isApproved ?? false,
    };
  });
}

/** Price points belonging to one cluster, matched through its rfq_item ids. */
function pointsForCluster(cluster: ItemCluster, all: PricePoint[]): PricePoint[] {
  const ids = new Set(
    cluster.members.filter((m) => m.rfqItemId != null).map((m) => m.rfqItemId as number),
  );
  return all.filter((p) => p.rfqItemId != null && ids.has(p.rfqItemId));
}

/**
 * Collapse the raw offer rows into price OBSERVATIONS.
 *
 * One supplier's quote is stored once per RFQ line, so an RFQ that lists the
 * same article on three lines carries three rows for a SINGLE price — counted
 * three times they would triple-weight that quote in every average, and the
 * history would show the same offer repeated. The live data has exactly this
 * shape (RFQ `CRQ-2026-000135` quotes one contactor on 3 lines).
 *
 * An observation is identified by `(offer, unit price)`: the same offer quoting
 * the same article at the same price is ONE price. A genuinely different price
 * from the same offer is kept separate, because that IS two observations (two
 * lines quoted at different rates). The cluster is already one article, so the
 * part number needs no place in the key.
 */
export function dedupePriceObservations(points: PricePoint[]): PricePoint[] {
  const seen = new Set<string>();
  const out: PricePoint[] = [];
  for (const p of points) {
    const key = `${p.offerId ?? "?"}|${p.price}|${p.priceNet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** Per-supplier rollup of the priced quotes, cheapest first. */
export interface SupplierSummary {
  supplierId: number | null;
  supplierName: string;
  quotedCount: number;
  minPriceNet: number | null;
  lastPriceNet: number | null;
  avgPriceNet: number | null;
  lastDate: string | null;
}

export function summariseBySupplier(points: PricePoint[]): SupplierSummary[] {
  const map = new Map<number, SupplierSummary & { sum: number }>();
  for (const p of points) {
    if (p.price <= 0) continue;
    const sid = p.supplierId ?? -1;
    let entry = map.get(sid);
    if (!entry) {
      entry = {
        supplierId: p.supplierId,
        supplierName: p.supplierName,
        quotedCount: 0,
        minPriceNet: null,
        lastPriceNet: null,
        avgPriceNet: null,
        lastDate: null,
        sum: 0,
      };
      map.set(sid, entry);
    }
    entry.quotedCount += 1;
    entry.sum += p.priceNet;
    entry.minPriceNet =
      entry.minPriceNet == null ? p.priceNet : Math.min(entry.minPriceNet, p.priceNet);
    entry.lastPriceNet = p.priceNet;
    entry.lastDate = p.date;
    entry.avgPriceNet = round2(entry.sum / entry.quotedCount);
  }
  return [...map.values()]
    .map((e) => {
      const { sum, ...rest } = e;
      void sum;
      return rest;
    })
    .sort((a, b) => (a.minPriceNet ?? Infinity) - (b.minPriceNet ?? Infinity));
}

// ── Route: search ────────────────────────────────────────────────────────────

function itemMatch(q: string) {
  return buildItemMatch(rfqItemsTable, q);
}

function customerItemMatch(q: string) {
  return buildItemMatch(customerRfqItemsTable, q);
}

/**
 * The normalised form of a search term: uppercase, every non-alphanumeric
 * character removed.
 *
 * The operator types a part number the way they say it (`LC1D32M7`) while the
 * ERP stores it the way it prints it (`LC1D 32 M7`), so a raw substring match
 * silently finds NOTHING and the item looks absent. Matching both sides in this
 * normalised form is what makes the search usable — and it is also why the list
 * and the detail agree on how many times an item was requested.
 */
export function normalizeSearchToken(q: string): string {
  return (q ?? "").toUpperCase().replace(/[^A-Za-z0-9]/g, "");
}

/** SQL: the column reduced to the same normalised form as the search term. */
function normLike(col: unknown, norm: string) {
  return sql`upper(regexp_replace(COALESCE(${col}, ''), '[^A-Za-z0-9]', '', 'g')) LIKE ${`%${norm}%`}`;
}

/**
 * The WHERE clause for an item search: the raw phrase over the description
 * (so «circuit breaker» works as prose) OR the normalised term over all three
 * identity columns (so a code matches however it was punctuated).
 */
export function buildItemMatch(
  t: { description: unknown; partNo: unknown; lineItem: unknown },
  q: string,
) {
  const norm = normalizeSearchToken(q);
  const clauses: SQL[] = [ilike(sql`COALESCE(${t.description}, '')`, `%${q}%`)];
  if (norm.length >= 2) {
    clauses.push(
      normLike(t.partNo, norm),
      normLike(t.lineItem, norm),
      normLike(t.description, norm),
    );
  }
  return or(...clauses);
}

/**
 * GET /api/items/analysis/search?q=&limit=
 *
 * One row per ITEM (not per RFQ line), each carrying enough to pick the right
 * one: its codes, its full description, how often it was requested, and its
 * price summary. The caller then opens `/items/analysis/item?key=`.
 */
router.get("/items/analysis/search", requireAuth, async (req, res): Promise<void> => {
  const q = (req.query.q as string | undefined)?.trim() ?? "";
  if (q.length < 2) {
    res.json({ query: q, total: 0, truncated: false, items: [] });
    return;
  }
  const limit = Math.min(
    Math.max(Number(req.query.limit ?? DEFAULT_CLUSTER_LIMIT) || DEFAULT_CLUSTER_LIMIT, 1),
    200,
  );

  const [supplierRows, customerRows, { vatRate }] = await Promise.all([
    loadSupplierRows(itemMatch(q)),
    loadCustomerRows(customerItemMatch(q)),
    loadTaxSettings(),
  ]);

  const clusters = clusterMembers([...supplierRows, ...customerRows]);
  const prices = dedupePriceObservations(
    await loadPricePoints(
      clusters.flatMap((c) => c.members.map((m) => m.rfqItemId)),
      vatRate,
    ),
  );
  const categories = await categoryNames(
    clusters.map((c) => c.categoryId).filter((id): id is number => id != null),
  );

  const pricedByKey = new Map<string, number>();
  const statsByKey = new Map<string, PriceStats>();
  const suppliersByKey = new Map<string, number>();
  for (const c of clusters) {
    const pts = pointsForCluster(c, prices);
    const priced = pts.filter((p) => p.price > 0);
    statsByKey.set(c.key, computePriceStats(pts));
    pricedByKey.set(c.key, priced.length);
    suppliersByKey.set(c.key, new Set(priced.map((p) => p.supplierId)).size);
  }

  const items = rankClusters(clusters, pricedByKey)
    .slice(0, limit)
    .map((c) => ({
      key: c.key,
      partNos: c.partNos,
      lineItems: c.lineItems,
      description: c.description,
      uom: c.uom,
      categoryName: c.categoryId != null ? (categories.get(c.categoryId) ?? null) : null,
      requestCount: c.requestCount,
      supplierRfqCount: c.supplierRfqCount,
      totalQty: c.totalQty,
      lastRequestedAt: c.lastRequestedAt,
      supplierCount: suppliersByKey.get(c.key) ?? 0,
      ...(statsByKey.get(c.key) ?? computePriceStats([])),
    }));

  res.json({
    query: q,
    total: clusters.length,
    truncated: supplierRows.length >= SEARCH_ROW_CAP || customerRows.length >= SEARCH_ROW_CAP,
    items,
  });
});

// ── Route: one item's full analysis ──────────────────────────────────────────

/**
 * GET /api/items/analysis/item?key=pn%3ALC1D32M7
 *
 * The full picture for one item: identity, price statistics, the trend series,
 * EVERY quote with the supplier and the employee who brought it, the
 * per-supplier breakdown, and the requests it appeared on.
 */
router.get("/items/analysis/item", requireAuth, async (req, res): Promise<void> => {
  const key = (req.query.key as string | undefined)?.trim() ?? "";
  const parsed = parseClusterKey(key);
  if (!parsed) {
    res.status(400).json({ error: "مفتاح البند غير صالح" });
    return;
  }

  const { vatRate } = await loadTaxSettings();

  // Narrow on the server by the key's own kind, then confirm in JS so the key
  // is authoritative (the JS key is the single definition of identity).
  let supplierWhere: SQL | undefined;
  let customerWhere: SQL | undefined;
  if (parsed.kind === "pn") {
    supplierWhere = sql`upper(regexp_replace(COALESCE(${rfqItemsTable.partNo}, ''), '[^A-Za-z0-9]', '', 'g')) = ${parsed.value}`;
    customerWhere = sql`upper(regexp_replace(COALESCE(${customerRfqItemsTable.partNo}, ''), '[^A-Za-z0-9]', '', 'g')) = ${parsed.value}`;
  } else if (parsed.kind === "li") {
    supplierWhere = ilike(sql`COALESCE(${rfqItemsTable.lineItem}, '')`, parsed.value);
    customerWhere = ilike(sql`COALESCE(${customerRfqItemsTable.lineItem}, '')`, parsed.value);
  } else {
    const token = parsed.value.split(" ").filter(Boolean)[0] ?? parsed.value;
    supplierWhere = ilike(sql`COALESCE(${rfqItemsTable.description}, '')`, `%${token}%`);
    customerWhere = ilike(sql`COALESCE(${customerRfqItemsTable.description}, '')`, `%${token}%`);
  }

  const [supplierRows, customerRows] = await Promise.all([
    loadSupplierRows(supplierWhere, SEARCH_ROW_CAP),
    loadCustomerRows(customerWhere, SEARCH_ROW_CAP),
  ]);

  const cluster = clusterMembers([...supplierRows, ...customerRows]).find((c) => c.key === key);
  if (!cluster) {
    res.status(404).json({ error: "لم يتم العثور على البند" });
    return;
  }

  const points = sortByDate(
    dedupePriceObservations(
      await loadPricePoints(
        cluster.members.map((m) => m.rfqItemId),
        vatRate,
      ),
    ),
  );
  const stats = computePriceStats(points);
  const categories = await categoryNames(cluster.categoryId != null ? [cluster.categoryId] : []);

  const requests = cluster.members
    .filter((m) => m.source === "customer_rfq")
    .map((m) => ({
      customerRfqItemId: m.customerRfqItemId,
      customerRfqId: m.customerRfqId,
      customerRfqNo: m.customerRfqNo,
      internalNo: m.internalRfqNo,
      customerName: m.customerName,
      qty: m.qty,
      uom: m.uom,
      date: m.date,
      partNo: m.partNo,
      lineItem: m.lineItem,
    }))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  res.json({
    key: cluster.key,
    partNos: cluster.partNos,
    lineItems: cluster.lineItems,
    description: cluster.description,
    uom: cluster.uom,
    categoryName: cluster.categoryId != null ? (categories.get(cluster.categoryId) ?? null) : null,
    requestCount: cluster.requestCount,
    supplierRfqCount: cluster.supplierRfqCount,
    totalQty: cluster.totalQty,
    lastRequestedAt: cluster.lastRequestedAt,
    vatRate,
    stats,
    suppliers: summariseBySupplier(points),
    priceHistory: points,
    requests,
    truncated: supplierRows.length >= SEARCH_ROW_CAP || customerRows.length >= SEARCH_ROW_CAP,
  });
});

export default router;
