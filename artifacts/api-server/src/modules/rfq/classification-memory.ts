/**
 * Classification memory — ذاكرة تصنيف البنود
 *
 * Stores the classification decided for an item IDENTITY (see
 * `item-identity.ts`) so the SAME item is classified the same way in every RFQ.
 *
 * Precedence, enforced here and nowhere else:
 *
 *  • A MANAGER decision (`source = 'manual'`) is authoritative. An automatic
 *    classification may NEVER overwrite it — the operator's rule that «التصحيح
 *    اليدوي المعتمد لا يلغيه التصنيف الآلي».
 *  • An automatic decision may UPDATE an existing automatic row (the classifier
 *    improved) and may CREATE a row. It may never touch a manual one.
 *
 * A write failure is swallowed by callers: remembering is an optimisation, and
 * it must never fail the RFQ it is classifying.
 */
import { db, itemClassificationIdentityTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { classificationIdentityKey, descriptionSignature } from "./item-identity";

export interface RememberedClassification {
  categoryId: number | null;
  subcategoryIds: number[];
  brandId: number | null;
  source: "manual" | "auto";
  confidence: number | null;
}

export interface RememberClassificationInput {
  /** Explicit identity key (e.g. customer-scoped). Derived from the item when absent. */
  key?: string | null;
  partNo?: string | null;
  description?: string | null;
  lineItem?: string | null;
  categoryId: number | null;
  subcategoryIds?: number[];
  brandId?: number | null;
  source: "manual" | "auto";
  confidence?: number | null;
  decidedBy?: number | null;
}

/** The slice of the drizzle handle these helpers need (db or a tx). */
type DbLike = Pick<typeof db, "select" | "insert">;

function serializeSubs(ids: number[] | undefined): string | null {
  return ids && ids.length ? JSON.stringify(ids) : null;
}

function parseSubs(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
}

/**
 * Remember the classification for an item identity. Idempotent; a manual
 * decision is never overwritten by an automatic one.
 *
 * Returns the identity key that was written, or null when the item carries no
 * usable identity.
 */
export async function rememberClassification(
  input: RememberClassificationInput,
  handle: DbLike = db,
): Promise<string | null> {
  const key = input.key ?? classificationIdentityKey(input);
  if (key == null) return null;

  const values = {
    identityKey: key,
    partNo: input.partNo?.trim() || null,
    descriptionSig: descriptionSignature(input.description),
    categoryId: input.categoryId,
    subcategoryIds: serializeSubs(input.subcategoryIds),
    brandId: input.brandId ?? null,
    source: input.source,
    confidence: input.confidence != null ? String(input.confidence) : null,
    decidedBy: input.decidedBy ?? null,
    timesSeen: 1,
  };

  // A manual decision wins unconditionally; an automatic one only touches a row
  // that is still automatic (`setWhere` scopes the UPDATE, never the INSERT).
  await handle
    .insert(itemClassificationIdentityTable)
    .values(values)
    .onConflictDoUpdate({
      target: itemClassificationIdentityTable.identityKey,
      set: {
        categoryId: values.categoryId,
        subcategoryIds: values.subcategoryIds,
        brandId: values.brandId,
        source: values.source,
        confidence: values.confidence,
        decidedBy: values.decidedBy,
        updatedAt: new Date(),
        timesSeen: sql`${itemClassificationIdentityTable.timesSeen} + 1`,
      },
      setWhere:
        input.source === "manual" ? undefined : eq(itemClassificationIdentityTable.source, "auto"),
    });

  return key;
}

/** Look up a single identity's remembered classification. */
export async function lookupClassification(
  key: string,
  handle: DbLike = db,
): Promise<RememberedClassification | null> {
  const [row] = await handle
    .select({
      categoryId: itemClassificationIdentityTable.categoryId,
      subcategoryIds: itemClassificationIdentityTable.subcategoryIds,
      brandId: itemClassificationIdentityTable.brandId,
      source: itemClassificationIdentityTable.source,
      confidence: itemClassificationIdentityTable.confidence,
    })
    .from(itemClassificationIdentityTable)
    .where(eq(itemClassificationIdentityTable.identityKey, key))
    .limit(1);
  if (!row) return null;
  return {
    categoryId: row.categoryId ?? null,
    subcategoryIds: parseSubs(row.subcategoryIds),
    brandId: row.brandId ?? null,
    source: row.source === "manual" ? "manual" : "auto",
    confidence: row.confidence != null ? Number(row.confidence) : null,
  };
}

/**
 * Batch lookup — one query for many identities (no N+1). Only rows with a usable
 * identity key are looked up; the map is keyed by that key.
 */
export async function loadClassificationMap(
  items: Array<{
    key?: string | null;
    partNo?: string | null;
    description?: string | null;
    lineItem?: string | null;
  }>,
  handle: DbLike = db,
): Promise<Map<string, RememberedClassification>> {
  const keys: string[] = [];
  for (const it of items) {
    const k = it.key ?? classificationIdentityKey(it);
    if (k) keys.push(k);
  }
  const out = new Map<string, RememberedClassification>();
  if (keys.length === 0) return out;

  const rows = await handle
    .select({
      identityKey: itemClassificationIdentityTable.identityKey,
      categoryId: itemClassificationIdentityTable.categoryId,
      subcategoryIds: itemClassificationIdentityTable.subcategoryIds,
      brandId: itemClassificationIdentityTable.brandId,
      source: itemClassificationIdentityTable.source,
      confidence: itemClassificationIdentityTable.confidence,
    })
    .from(itemClassificationIdentityTable)
    .where(inArray(itemClassificationIdentityTable.identityKey, [...new Set(keys)]));

  for (const r of rows) {
    out.set(r.identityKey, {
      categoryId: r.categoryId ?? null,
      subcategoryIds: parseSubs(r.subcategoryIds),
      brandId: r.brandId ?? null,
      source: r.source === "manual" ? "manual" : "auto",
      confidence: r.confidence != null ? Number(r.confidence) : null,
    });
  }
  return out;
}

/** A category a set of same-identity items disagree on. */
export interface IdentityDisagreement {
  identityKey: string;
  /** Distinct category ids seen across the identity's items. */
  categoryIds: number[];
  /** How many items carry the identity. */
  itemCount: number;
}

/**
 * Find identities whose items DISAGREE on their category — the exact defect the
 * operator reported («نفس البند: كهرباء في طلب، إضاءة في طلب، غير مصنّف في الباقي»).
 * One pass over every non-cancelled item, grouped in JS by identity key. Only
 * identities with TWO OR MORE distinct categories are returned, so a consistent
 * item is never rewritten.
 *
 * `items` are supplied by the caller (it already reads the table) so this stays
 * a pure grouping — no extra query.
 */
export function findIdentityDisagreements(
  items: Array<{
    id: number;
    categoryId: number | null;
    partNo?: string | null;
    description?: string | null;
    lineItem?: string | null;
  }>,
): IdentityDisagreement[] {
  const byKey = new Map<string, { ids: Set<number>; count: number }>();
  for (const it of items) {
    const key = classificationIdentityKey(it);
    if (!key) continue;
    const entry = byKey.get(key) ?? { ids: new Set<number>(), count: 0 };
    entry.ids.add(it.categoryId ?? -1); // -1 = unclassified
    entry.count += 1;
    byKey.set(key, entry);
  }
  const out: IdentityDisagreement[] = [];
  for (const [identityKey, entry] of byKey) {
    // Unclassified is not a decision — only two or more REAL categories are a
    // disagreement worth repairing.
    const real = [...entry.ids].filter((id) => id >= 0);
    if (real.length < 2) continue;
    out.push({ identityKey, categoryIds: real.sort((a, b) => a - b), itemCount: entry.count });
  }
  return out;
}
