/**
 * Extra line-level filters for an item lookup: an exact quantity and a list of
 * words that must ALL appear in the row.
 *
 * `contains` alone cannot express «Cable Lug مقاس 70×12 بكمية 230»: the model
 * shortened it to the single word «lug», which matched water heaters (…PLUG…) and
 * returned a ranked report that never answered the question. The quantity is a
 * property of the line, not of the description, so it needs its own filter, and
 * the size words need an all-of match rather than a lone fragment.
 */

export interface LineExtras {
  /** Exact quantity the line must carry, or null for no quantity filter. */
  qty: number | null;
  /** Words that must each appear somewhere in the row (case-insensitive). */
  terms: string[];
}

const MAX_TERMS = 6;

export function normalizeLineExtras(args: Record<string, unknown> | undefined): LineExtras {
  const a = args ?? {};
  const qtyRaw = Number(a.qty);
  const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : null;

  const raw = a.terms;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,،;\n]+/) : [];
  const terms = list
    .map((t) => String(t ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_TERMS);
  return { qty, terms };
}

export function hasLineExtras(e: LineExtras): boolean {
  return e.qty !== null || e.terms.length > 0;
}

function fold(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[×*]/g, "x")
    .replace(/\s+/g, " ");
}

/** Does this parsed row satisfy the quantity and every extra term? */
export function matchesLineExtras(
  it: { description?: unknown; partNo?: unknown; lineItemNo?: unknown; qty?: unknown },
  e: LineExtras,
): boolean {
  if (e.qty !== null && Number(it.qty) !== e.qty) return false;
  if (e.terms.length === 0) return true;
  const hay = fold(`${it.description ?? ""} ${it.partNo ?? ""} ${it.lineItemNo ?? ""}`);
  return e.terms.every((t) => hay.includes(fold(t)));
}

/** A short Arabic label for a report header, or an empty string. */
export function describeLineExtras(e: LineExtras): string {
  const bits: string[] = [];
  if (e.terms.length) bits.push(`كلمات: ${e.terms.join(" + ")}`);
  if (e.qty !== null) bits.push(`كمية ${e.qty}`);
  return bits.join(" · ");
}
