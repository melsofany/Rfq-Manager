/**
 * AI Assistant — SQL-computed data tools.
 *
 * The failure this module exists to prevent, reported live: the operator asked
 * for a PDF of every item supplied to customers in 2025–2026, with no order
 * numbers, no money, and no repeated items. The assistant produced a report with
 * **15 items**. The table holds **1,971** rows for those two years across
 * **570 distinct descriptions**.
 *
 * The cause was not a prompt mistake. The assistant only had "search a table,
 * up to N rows" and `generate_pdf`, so the model read a page of rows, grouped
 * them in its head, and wrote whatever it happened to remember. The whole
 * `customer_po_items` table is ~2k rows and a single `GROUP BY` answers the
 * question exactly — the failure was that **no tool computed it**. Industry
 * write-ups of this class say the same thing: totals computed in prose instead
 * of in SQL is the dominant agent failure on structured data.
 *
 * So this module gives the agent *governed, parameterised, read-only* SQL
 * aggregates. The three rules that must not be broken:
 *
 *  1. **Every row is retrievable in ONE call.** No default sample cap: a cap is
 *     what produced "15 items", and a correct-but-truncated answer is worse than
 *     an error because it reads as complete.
 *  2. **Dedupe by PRODUCT, not by part number.** The operator's "no repeated
 *     items" is about product identity, and part numbers are unreliable — the
 *     same article appears with a code in one order and by description alone in
 *     the next. Grouping on the raw description fails the same way (`CABLE 2X2.5`
 *     and `CABLE 2X2.5 MM` are one product written twice).
 *  3. **Never claim a count the database did not return.** The tool reports
 *     what it grouped, how many source rows went in, and anything it had to cut.
 */
import { getPool } from "@workspace/db";
import { logger } from "../../shared/logger";

/** Hard ceiling on rows one aggregate returns, so a query cannot exhaust memory. */
export const MAX_AGGREGATE_ROWS = 20_000;

/**
 * Description prefixes that describe an ACCOUNTING line, not a product.
 *
 * The ERP prints VAT as a normal table row, so `VALUE ADDED TAX LOCAL` grouped as
 * a "product" and topped the frequency ranking. Excluded here because it is not
 * stock (same rule as the email parser's totals-boundary handling).
 */
const NON_PRODUCT_RE = /\b(value added tax|vat\b|ضريبة|خصم|شحن|نقل|تركيب|ض\.ق\.م)/i;

export interface DescriptionCluster {
  /** The description the operator should read (the cluster's representative). */
  label: string;
  /** Distinct raw descriptions folded into this cluster (spelling variants). */
  variants: number;
}

/**
 * Canonical product key for a description.
 *
 * Deliberately DOCUMENTED as lossy: this is a normalisation for matching, not a
 * display value. The rules, in order, and why each is needed:
 *
 *  - **Fold case, punctuation, diacritics and whitespace.** `CABLE 2X2.5 MM`
 *    and `cable 2x2.5 mm` are one product.
 *  - **Drop the leading article.** `THE PUMP ...` and `PUMP ...` are one product.
 *  - **Ignore long leading numeric codes.** The EDC line-item code
 *    (`1531.032.GENRAL.7538`), a bare `1001`, or a dotted ticket number is an ERP
 *    identifier, not the article. A *short* leading number followed by a unit
 *    (`2X2.5 CABLE`) is part of the name and must stay.
 *  - **Ignore a stray leading number** on an otherwise textual description
 *    (`41 10HP SIEMENS MOTOR` → `10hp siemens motor`).
 *
 * Returns "" when nothing usable remains; the caller then groups by the raw
 * description so a row is never silently merged into a meaningless bucket.
 */
export function canonicalDescription(desc: string): string {
  let s = (desc || "")
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "") // Arabic harakat + tatweel
    .replace(/[إأآٱا]/g, "ا")
    .replace(/[ىي]/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .trim();
  // Strip the leading ERP code BEFORE folding punctuation: the code is
  // dot-separated (`1531.032.GENRAL.7538`) and folding turns it into ordinary
  // words (`1531 032 genral 7538`) which then cannot be recognised. The length
  // guard is what keeps a short size token (`2X2.5`) — which IS the product name
  // — from being mistaken for a code.
  s = s.replace(/^(?:[a-z0-9]+[._-]){1,}[a-z0-9]+\s*/, (m) => (m.trim().length >= 8 ? "" : m));
  // Fold every run of non-alphanumeric (Latin or Arabic) into one space.
  s = s.replace(/[^a-z0-9\u0600-\u06FF]+/g, " ").trim();
  s = s.replace(/^(the|a|an)\s+/, "");
  // A single long alphanumeric code token (>=6 chars with digits) at the head.
  s = s.replace(/^[a-z]*\d[a-z0-9]{5,}\s+/, "");
  // A stray leading number followed by a code-like token (`41 10HP …` → the `41`
  // is a line number). Deliberately NOT applied when the next token is a plain
  // unit word (`50 MM CABLE` keeps its `50` — the size is the product identity).
  s = s.replace(/^\d{1,3}\s+(?=\d+[a-z])/, "");
  return s.trim();
}

/**
 * A short, human-facing label for a cluster.
 *
 * NOTE it is **not unique** — two genuinely different articles can share a
 * leading token (`METER 3PHASE` and `METER 1PHASE` both label `meter`), and the
 * operator's «بدون تكرار» requirement makes a duplicated-looking name a failure
 * in their eyes. So this is a convenience for a compact line only; the report
 * must print `description`, which IS unique per cluster.
 */
export function clusterLabel(desc: string): string {
  const canon = canonicalDescription(desc);
  if (!canon) return (desc || "").trim();
  const words = canon.split(" ").filter((w) => w.length >= 2);
  if (!words.length) return canon;
  return words[0];
}

/**
 * Would a total this large be a PRODUCT-level line rather than a single part?
 *
 * The operator rejected category rows ("water filters") — but dropping every big
 * number would hide a genuine high-volume article. So the big ones are KEPT and
 * FLAGGED: the full per-row detail travels in the same payload, and the model is
 * told to present those lines with their detail rather than as one "item".
 */
export function isProductLevelTotal(total: number, totals: number[]): boolean {
  const sorted = [...totals].sort((a, b) => a - b);
  if (!sorted.length) return false;
  // MEDIAN of the upper quartile rather than the overall median: real data is
  // heavily skewed (a handful of huge lines, hundreds of tiny ones), so the
  // overall median sits at ~1 and flags everything. The upper-quartile median
  // is a stable "big but ordinary" reference.
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const reference = sorted.length >= 4 ? q3 : sorted[Math.floor(sorted.length / 2)];
  if (reference <= 0) return false;
  return total > reference * 4;
}

export interface CustomerItemRow {
  /** Canonical product key (matching identity). */
  key: string;
  /** Representative description for display — the longest variant seen. */
  description: string;
  /** Short label (brand/model) for a compact report. */
  label: string;
  /** Distinct raw descriptions folded into this row (spelling variants). */
  variants: number;
  /** Distinct part numbers seen for this product (informational). */
  partNos: string[];
  /** Unit of measure(s) seen. */
  uoms: string[];
  /** Total supplied quantity — computed by SQL, never by the model. */
  totalQty: number;
  /** How many customer-PO lines contributed (occurrences). */
  occurrences: number;
  /** Heuristic: this total looks like a category, not one part. */
  productLevel: boolean;
  /** True when this row rests on description/part number rather than a code. */
  identityUncertain: boolean;
}

export interface CustomerItemsResult {
  rows: CustomerItemRow[];
  /** Customer-PO lines that went INTO the grouping (the denominator). */
  sourceRows: number;
  /** Distinct products found before any filtering. */
  groupsBeforeFilter: number;
  /** Groups dropped by the `minQty` filter. */
  droppedByMinQty: number;
  /** Groups dropped as non-stock (VAT and other accounting lines). */
  droppedNonProduct: number;
  /** True when a ceiling cut the row count (never silently). */
  truncated: boolean;
  /** The filters actually applied, echoed so the answer can cite them. */
  appliedFilters: Record<string, unknown>;
}

/** A customer-PO item row compacted to the columns a report needs. */
function itemCsvRow(r: CustomerItemRow): string[] {
  return [
    r.description,
    r.partNos.join(" | "),
    r.uoms.join(" | "),
    String(r.totalQty),
    String(r.occurrences),
    r.productLevel ? "نعم" : "لا",
  ];
}

const CSV_HEADER = ["الصنف", "رقم القطعة", "الوحدة", "إجمالي الكمية", "عدد الأوامر", "وصف تصنيفي"];

/**
 * CSV of every product — built HERE, from the complete result.
 *
 * The model cannot be trusted to carry the rows: it must emit them inside a tool
 * call, and a 449-row payload exceeds what it can produce in one response, so a
 * model-built file would be truncated exactly like the report this module fixes.
 */
export function customerItemsCsv(result: CustomerItemsResult): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [CSV_HEADER, ...result.rows.map(itemCsvRow)].map((row) => row.map(esc).join(","));
  // BOM so Excel renders the Arabic headers correctly.
  return "\ufeff" + lines.join("\r\n");
}

/**
 * PDF table of every product — built from the complete result.
 *
 * Deliberately delegates to `generateAssistantPdf` (imported lazily to avoid a
 * module cycle with `pdf.ts`) with the full row set, so the artifact carries
 * every item rather than the model's recollection of them.
 */
export async function customerItemsPdf(
  result: CustomerItemsResult,
  opts: { title?: string; subtitle?: string | null; source?: string | null; limit?: number },
): Promise<Buffer> {
  const { generateAssistantPdf } = await import("./pdf");
  const rows = opts.limit != null ? result.rows.slice(0, opts.limit) : result.rows;
  return generateAssistantPdf({
    title: opts.title || "تقرير الأصناف المورَّدة للعملاء",
    subtitle:
      opts.subtitle ??
      `${result.rows.length} صنفًا من ${result.sourceRows} سطر أمر شراء` +
        (rows.length < result.rows.length ? ` (أول ${rows.length})` : ""),
    source: opts.source ?? null,
    sections: [
      {
        paragraphs: [
          `إجمالي الأصناف المميزة: ${result.rows.length} — من ${result.sourceRows} سطر في أوامر شراء العملاء.`,
          rows.length < result.rows.length
            ? `هذا الملف يعرض أول ${rows.length} صنفًا؛ الملف الكامل (CSV) يحمل كل الأصناف.`
            : "هذا الملف يحمل كل الأصناف بلا اقتطاع.",
        ],
      },
      {
        heading: "الأصناف والكميات",
        table: {
          columns: ["#", "الصنف (الوصف)", "رقم القطعة", "الوحدة", "إجمالي الكمية", "عدد الأوامر"],
          rows: rows.map((r, i) => [
            i + 1,
            r.description,
            r.partNos.join(" | "),
            r.uoms.join(" | "),
            r.totalQty,
            r.occurrences,
          ]),
        },
      },
    ],
  });
}

export interface CustomerItemsOptions {
  /** Inclusive lower bound on the customer-PO date, `YYYY-MM-DD`. */
  fromDate?: string;
  /** Exclusive upper bound on the customer-PO date, `YYYY-MM-DD`. */
  toDate?: string;
  /** Include rows whose customer-PO link was severed (cancelled items). */
  includeDetached?: boolean;
  /** Drop clusters whose total quantity is below this. */
  minQty?: number;
  /** Case-insensitive substring filter on the item description / part number. */
  match?: string;
}

/**
 * Compute the customer-supplied-items report **in SQL**.
 *
 * One `GROUP BY` over the item rows joined to their customer PO for the date
 * window, then the canonical-product folding in JS (the ERP codes and spelling
 * variants cannot be folded in SQL portably). Every contributing row is read —
 * there is no sample window.
 */
export async function aggregateCustomerPoItems(
  opts: CustomerItemsOptions = {},
): Promise<CustomerItemsResult> {
  const params: unknown[] = [];
  const where: string[] = [];

  if (!opts.includeDetached) {
    // Detached rows are items REMOVED from their PO (soft-cancelled); they carry
    // no quantity and belong to no order, so they must not inflate a supply total.
    where.push(`i.customer_po_id is not null`);
  }
  if (opts.fromDate) {
    params.push(opts.fromDate);
    where.push(`p.po_date >= $${params.length}`);
  }
  if (opts.toDate) {
    params.push(opts.toDate);
    where.push(`p.po_date < $${params.length}`);
  }
  if (opts.match) {
    params.push(`%${opts.match}%`);
    where.push(`(i.description ilike $${params.length} or i.part_no ilike $${params.length})`);
  }

  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  // Sum/round in SQL (NUMERIC is returned as a string by the driver) and count
  // the contributing lines, so the model never adds anything up.
  const sql = `
    select
      coalesce(i.description, '') as description,
      coalesce(i.part_no, '') as part_no,
      coalesce(i.uom, '') as uom,
      sum(coalesce(i.qty, 0))::float8 as total_qty,
      count(*)::int as occurrences
    from customer_po_items i
    join customer_pos p on p.id = i.customer_po_id
    ${whereSql}
    group by 1, 2, 3
  `;

  const res = await getPool().query<{
    description: string;
    part_no: string;
    uom: string;
    total_qty: number;
    occurrences: number;
  }>(sql, params);

  const sourceRows = res.rows.reduce((a, r) => a + Number(r.occurrences || 0), 0);
  logger.info(
    { sourceRows, groupedRows: res.rows.length, filters: opts },
    "AI assistant: customer item aggregate computed in SQL",
  );

  // Fold the SQL groups into canonical PRODUCT clusters (union by key).
  const clusters = new Map<
    string,
    {
      total: number;
      occurrences: number;
      variants: Set<string>;
      partNos: Set<string>;
      uoms: Set<string>;
      longest: string;
    }
  >();
  let droppedNonProduct = 0;

  for (const r of res.rows) {
    const desc = r.description || "";
    if (NON_PRODUCT_RE.test(desc)) {
      droppedNonProduct += 1;
      continue;
    }
    const key = canonicalDescription(desc) || desc.trim().toLowerCase();
    if (!key) {
      droppedNonProduct += 1;
      continue;
    }
    const cur = clusters.get(key) ?? {
      total: 0,
      occurrences: 0,
      variants: new Set<string>(),
      partNos: new Set<string>(),
      uoms: new Set<string>(),
      longest: "",
    };
    cur.total += Number(r.total_qty || 0);
    cur.occurrences += Number(r.occurrences || 0);
    if (desc.trim()) cur.variants.add(desc.trim());
    if (r.part_no && r.part_no.trim()) cur.partNos.add(r.part_no.trim());
    if (r.uom && r.uom.trim()) cur.uoms.add(r.uom.trim());
    if (desc.trim().length > cur.longest.length) cur.longest = desc.trim();
    clusters.set(key, cur);
  }

  const groupsBeforeFilter = clusters.size;
  const totals = [...clusters.values()].map((c) => c.total);
  let droppedByMinQty = 0;

  const rows: CustomerItemRow[] = [];
  for (const [key, c] of clusters) {
    if (opts.minQty != null && c.total < opts.minQty) {
      droppedByMinQty += 1;
      continue;
    }
    rows.push({
      key,
      description: c.longest || key,
      label: clusterLabel(c.longest || key),
      variants: c.variants.size,
      partNos: [...c.partNos],
      uoms: [...c.uoms],
      totalQty: Number(c.total.toFixed(4)),
      occurrences: c.occurrences,
      productLevel: isProductLevelTotal(c.total, totals),
      // A product identified only by prose is less certain than one with a code;
      // the operator asked for exactly this count, so it is surfaced.
      identityUncertain: c.partNos.size === 0,
    });
  }

  rows.sort((a, b) => b.totalQty - a.totalQty);

  const truncated = rows.length > MAX_AGGREGATE_ROWS;
  return {
    rows: truncated ? rows.slice(0, MAX_AGGREGATE_ROWS) : rows,
    sourceRows,
    groupsBeforeFilter,
    droppedByMinQty,
    droppedNonProduct,
    truncated,
    appliedFilters: {
      fromDate: opts.fromDate ?? null,
      toDate: opts.toDate ?? null,
      includeDetached: opts.includeDetached ?? false,
      minQty: opts.minQty ?? null,
      match: opts.match ?? null,
    },
  };
}
