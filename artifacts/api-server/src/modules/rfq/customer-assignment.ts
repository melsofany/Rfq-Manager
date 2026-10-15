/**
 * Customer-item assignment engine — إسناد بنود طلبات العملاء
 *
 * `customer_rfq_items` is the SOURCE OF TRUTH for procurement responsibility.
 * The workflow starts when the customer request arrives: its items are
 * classified and each one is assigned to the responsible procurement employee.
 * A supplier RFQ created later for the same item reads that responsibility — it
 * never creates an independent one, so one customer item sent to N suppliers
 * still has exactly ONE owner.
 *
 * An item that cannot be classified (or whose category has no owner) is left
 * UNASSIGNED on purpose — assigning it would fabricate a responsibility nobody
 * owns.
 */
import {
  db,
  customerRfqItemsTable,
  customerRfqItemAssignmentsTable,
  itemAssignmentAuditTable,
  employeesTable,
  itemCategoriesTable,
  itemCategoryKeywordsTable,
} from "@workspace/db";
import { eq, and, inArray, asc, desc, isNull, isNotNull } from "drizzle-orm";
import {
  classifyItem,
  isFunctionalCategory,
  isOwnableAssignment,
  MIN_CONFIDENCE,
  normalizeText,
  pickLearnableKeywords,
  resolveDomainId,
} from "./classification";
import { classifyItemsWithAi, type AiClassifyResult } from "./ai-classifier";
import { classificationIdentityKey } from "./item-identity";
import { loadClassifierVocabulary } from "./keywords";
import {
  loadClassificationMap,
  rememberClassification,
  type RememberedClassification,
} from "./classification-memory";
import {
  buildContext,
  loadCategories,
  loadCustomerWorkloads,
  type AssignContext,
} from "./assignment";
import { closeAndOpenPeriod, dbClockTimestamp, lockItemRows } from "./attribution";

/** At most this many learned keywords are added per confirmed correction. */
const LEARN_KEYWORD_LIMIT = 5;

/** The slice of the drizzle handle the learning helper needs (db or a tx). */
type DbLike = Pick<typeof db, "select" | "insert">;

export interface CustomerAssignOutcome {
  customerRfqItemId: number;
  categoryId: number | null;
  employeeId: number | null;
  confidence: number;
  reason: "assigned" | "unclassified" | "no_owner" | "no_employees" | "kept";
}

/**
 * Pick the owner for a resolved category (primary first, then least loaded).
 *
 * The category is first resolved to its FUNCTIONAL DOMAIN: a subcategory
 * (قواطع/PLC/…) owns no responsibility of its own, so an item filed under one is
 * still owned by the domain's employee. A brand resolves to no domain and can
 * never own an item.
 */
function pickOwner(categoryId: number, ctx: AssignContext): number | null {
  const resolved = resolveDomainId(categoryId, ctx.categories);
  // A brand resolves to NO domain and can never own an item; only an unknown
  // category id falls back to itself.
  if (resolved == null) return null;
  const domainId = resolved;
  const eligible = ctx.owners.get(domainId) ?? [];
  if (eligible.length === 0) return null;
  const primary = ctx.primary.get(domainId);
  if (primary != null && eligible.includes(primary)) return primary;
  return [...eligible].sort((a, b) => {
    const la = ctx.load.get(a) ?? 0;
    const lb = ctx.load.get(b) ?? 0;
    return la - lb || a - b;
  })[0];
}

/**
 * Classify + assign the customer items of one RFQ.
 *
 * `newItemIds` — when provided, ONLY those items are processed (used by the
 * edit path to assign newly-added rows without touching unchanged ones). When
 * omitted, every item without an existing assignment is processed (create /
 * ensure path).
 *
 * Existing assignments are NEVER overwritten here, so editing a description or
 * a part number cannot silently move responsibility. A responsibility changes
 * only through the explicit manual path (with an audit row).
 */
export async function ensureCustomerAssignments(
  customerRfqId: number,
  opts: { newItemIds?: number[] } = {},
): Promise<CustomerAssignOutcome[]> {
  const items = await db
    .select({
      id: customerRfqItemsTable.id,
      description: customerRfqItemsTable.description,
      partNo: customerRfqItemsTable.partNo,
      lineItem: customerRfqItemsTable.lineItem,
      categoryId: customerRfqItemsTable.categoryId,
    })
    .from(customerRfqItemsTable)
    .where(eq(customerRfqItemsTable.customerRfqId, customerRfqId))
    .orderBy(asc(customerRfqItemsTable.id));

  if (items.length === 0) return [];

  const targetItems =
    opts.newItemIds && opts.newItemIds.length > 0
      ? items.filter((i) => opts.newItemIds!.includes(i.id))
      : items;

  if (targetItems.length === 0) return [];

  const existing = await db
    .select({ customerRfqItemId: customerRfqItemAssignmentsTable.customerRfqItemId })
    .from(customerRfqItemAssignmentsTable)
    .where(
      inArray(
        customerRfqItemAssignmentsTable.customerRfqItemId,
        targetItems.map((i) => i.id),
      ),
    );
  const alreadyAssigned = new Set(existing.map((e) => e.customerRfqItemId));

  const [ctx, customerLoad] = await Promise.all([buildContext(), loadCustomerWorkloads()]);
  ctx.load = customerLoad;

  const outcomes: CustomerAssignOutcome[] = [];

  // ── Identity memory pass ──────────────────────────────────────────────────
  // Before asking the model, consult the classification MEMORY for each item's
  // identity. An item already classified (auto or manual) on an earlier RFQ is
  // classified the SAME way here — which is what stops the same Line Item from
  // being «كهرباء» on one request and «غير مصنّف» on the next, and keeps
  // classification working when the LLM quota is exhausted.
  const needsClassification = targetItems.filter(
    (i) => !alreadyAssigned.has(i.id) && (i.categoryId ?? null) == null,
  );
  const memoryMap = await loadClassificationMap(needsClassification).catch(
    () => new Map<string, RememberedClassification>(),
  );

  // ── AI classification pass ────────────────────────────────────────────────
  // Items that still have no category AND no memory entry are classified by the
  // LLM in ONE batched request, using the operator's own category catalogue. The
  // model may answer «غير معروف» — an unclassified item stays unassigned on
  // purpose (never invent a responsibility). If the request cannot be made
  // (unconfigured / provider error / unparsable), `aiResults` is null and every
  // item falls back to the deterministic keyword classifier below. Best-effort:
  // this must never fail the customer RFQ it is classifying.
  const needsAi = needsClassification.filter(
    (i) => !memoryMap.has(classificationIdentityKey(i) ?? ""),
  );
  const aiResults = needsAi.length > 0 ? await classifyItemsWithAi(needsAi, ctx.categories) : null;
  const aiByItemId = new Map<number, AiClassifyResult>();
  if (aiResults) {
    needsAi.forEach((it, i) => {
      const r = aiResults[i];
      if (r && r.categoryId != null) aiByItemId.set(it.id, r);
    });
  }

  for (const item of targetItems) {
    if (alreadyAssigned.has(item.id)) {
      outcomes.push({
        customerRfqItemId: item.id,
        categoryId: item.categoryId ?? null,
        employeeId: null,
        confidence: 100,
        reason: "kept",
      });
      continue;
    }

    let categoryId = item.categoryId ?? null;
    let confidence = 100;
    // The item's canonical identity — computed once, used both to consult the
    // memory and to remember the decision below.
    const identityKey = classificationIdentityKey(item);
    let analysis: {
      brandId: number | null;
      subcategoryIds: number[];
      attributes: Record<string, string> | null;
      reason: string | null;
    } | null = null;
    if (categoryId == null) {
      // 1. IDENTITY MEMORY — an item already classified elsewhere is classified
      //    the same way here, with no model call. This is the primary fix for the
      //    «same item, different categories» defect.
      const remembered = identityKey ? memoryMap.get(identityKey) : undefined;
      if (remembered && remembered.categoryId != null) {
        categoryId = remembered.categoryId;
        confidence = remembered.source === "manual" ? 100 : (remembered.confidence ?? 100);
        analysis = {
          brandId: remembered.brandId,
          subcategoryIds: remembered.subcategoryIds,
          attributes: null,
          reason: remembered.source === "manual" ? "identity: manual" : "identity: auto",
        };
      }
    }
    if (categoryId == null) {
      const ai = aiByItemId.get(item.id);
      if (ai && ai.categoryId != null && (ai.confidence ?? 0) >= MIN_CONFIDENCE) {
        categoryId = ai.categoryId;
        confidence = ai.confidence ?? 100;
        analysis = {
          brandId: ai.brandId,
          subcategoryIds: ai.subcategoryIds,
          attributes: ai.attributes,
          reason: ai.reason,
        };
      } else {
        // AI declined, was unavailable, or was not confident enough → the
        // deterministic keyword classifier gets the next say.
        const result = classifyItem(item, ctx.categories, ctx.vocabulary);
        categoryId = result.categoryId;
        confidence = result.confidence;
        if (categoryId != null) {
          analysis = {
            brandId: null,
            subcategoryIds: result.subcategoryIds ?? [],
            attributes: null,
            reason: result.matchedTerm ? `keyword: ${result.matchedTerm}` : null,
          };
        }
      }
    }

    if (categoryId != null && confidence >= MIN_CONFIDENCE) {
      // Store the PRIMARY (functional) category AND the classifier's analysis,
      // so the manager can review the suggestion beside the decision. Only the
      // category owns responsibility; the rest is evidence.
      const subIds = analysis?.subcategoryIds ?? [];
      await db
        .update(customerRfqItemsTable)
        .set({
          categoryId,
          ...(analysis
            ? {
                brandId: analysis.brandId,
                subcategoryIds: subIds.length ? JSON.stringify(subIds) : null,
                technicalAttributes: analysis.attributes
                  ? JSON.stringify(analysis.attributes)
                  : null,
                classifyConfidence: String(confidence),
                classifyReason: analysis.reason,
              }
            : {}),
        })
        .where(eq(customerRfqItemsTable.id, item.id));

      // Remember the decision against the item's IDENTITY so the next RFQ with
      // the same item resolves instantly. A decision that came FROM memory is
      // not re-written (it already exists); a manager's decision is authoritative
      // and is never overwritten by an automatic one (enforced in the memory
      // module). Best-effort — remembering must never fail the RFQ.
      if (identityKey && !memoryMap.has(identityKey)) {
        await rememberClassification({
          partNo: item.partNo,
          description: item.description,
          lineItem: item.lineItem,
          categoryId,
          subcategoryIds: subIds,
          brandId: analysis?.brandId ?? null,
          source: "auto",
          confidence,
        }).catch(() => {});
      }
    } else {
      categoryId = null;
    }

    if (categoryId == null) {
      outcomes.push({
        customerRfqItemId: item.id,
        categoryId: null,
        employeeId: null,
        confidence,
        reason: "unclassified",
      });
      continue;
    }

    const employeeId = pickOwner(categoryId, ctx);
    if (employeeId == null) {
      outcomes.push({
        customerRfqItemId: item.id,
        categoryId,
        employeeId: null,
        confidence,
        reason: ctx.owners.size === 0 ? "no_employees" : "no_owner",
      });
      continue;
    }

    // First assignment for this item ⇒ open its first period. `onConflictDoNothing`
    // absorbs a concurrent writer that opened the period first (the partial
    // unique index on the open period is the arbiter).
    await db
      .insert(customerRfqItemAssignmentsTable)
      .values({
        customerRfqItemId: item.id,
        categoryId,
        employeeId,
        source: "auto",
        confidence: String(confidence),
      })
      .onConflictDoNothing();

    ctx.load.set(employeeId, (ctx.load.get(employeeId) ?? 0) + 1);

    outcomes.push({
      customerRfqItemId: item.id,
      categoryId,
      employeeId,
      confidence,
      reason: "assigned",
    });
  }

  return outcomes;
}

/** Best-effort wrapper for the create/edit flows — never fails the parent. */
export async function ensureCustomerAssignmentsSafe(
  customerRfqId: number,
  opts: { newItemIds?: number[] } = {},
): Promise<void> {
  try {
    await ensureCustomerAssignments(customerRfqId, opts);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("customer assignment failed (non-fatal)", err);
  }
}

/**
 * Startup backfill — the legacy data pass. Classifies every still-unclassified
 * customer item and remembers each decision by identity, so the historical
 * backlog is repaired with the SAME rules as new items and becomes reusable
 * afterwards.
 *
 * Idempotent: it only touches `category_id IS NULL` rows, so running it again
 * (or after a partial run) neither duplicates work nor rewrites a decided item.
 * Deterministic-only by default (`useAi: false`) — this runs on EVERY boot, and
 * it must not depend on, or spend, the LLM quota. Reversible: every item it
 * classifies carries a `classify_reason` and an `auto` memory row that a manager
 * can override.
 *
 * Bounded by `limit` so a huge backlog cannot delay a boot.
 */
export async function backfillItemClassification(
  opts: { limit?: number; useAi?: boolean } = {},
): Promise<{
  scanned: number;
  classified: number;
  batches: number;
  repairedIdentities: number;
  repairedItems: number;
}> {
  // Repair items that were classified INCONSISTENTLY before the memory existed
  // (the same item as «كهرباء» on one RFQ and «إضاءة»/«غير مصنّف» on another) —
  // memory alone cannot fix those, because they already carry a category. This
  // unifies each identity onto ONE domain FIRST, so the seed below learns from
  // consistent data and the unclassified pass reuses the unified value.
  const repaired = await repairClassificationConsistency({ limit: opts.limit ?? 20000 }).catch(
    () => ({ identities: 0, itemsFixed: 0 }),
  );
  // Seed memory from items that ALREADY have a category (from before this
  // feature), so the identity memory starts populated from the real corpus and
  // the SAME item is recognised on the very next request — not only after it is
  // classified once more.
  await seedClassificationMemoryFromClassified(opts.limit ?? 2000).catch(() => {});
  const filled = await classifyUnclassifiedItems({
    useAi: false,
    limit: opts.limit ?? 2000,
    ...opts,
  });
  return {
    ...filled,
    repairedIdentities: repaired.identities,
    repairedItems: repaired.itemsFixed,
  };
}

/**
 * Seed the identity memory from items that already carry a category. Only
 * identities NOT already remembered are inserted, so a repeated boot does not
 * inflate `times_seen`. Bounded, best-effort and model-free.
 */
export async function seedClassificationMemoryFromClassified(limit = 2000): Promise<number> {
  const rows = await db
    .select({
      partNo: customerRfqItemsTable.partNo,
      description: customerRfqItemsTable.description,
      lineItem: customerRfqItemsTable.lineItem,
      categoryId: customerRfqItemsTable.categoryId,
      subcategoryIds: customerRfqItemsTable.subcategoryIds,
      brandId: customerRfqItemsTable.brandId,
    })
    .from(customerRfqItemsTable)
    .where(
      and(
        isNotNull(customerRfqItemsTable.categoryId),
        eq(customerRfqItemsTable.isCancelled, false),
      ),
    )
    .orderBy(desc(customerRfqItemsTable.id))
    .limit(Math.min(Math.max(limit, 1), 5000));

  if (rows.length === 0) return 0;

  // One batched lookup of what is already remembered, then insert only the rest.
  const existing = await loadClassificationMap(rows).catch(
    () => new Map<string, RememberedClassification>(),
  );
  let seeded = 0;
  for (const r of rows) {
    if (r.categoryId == null) continue; // the query filters these; guard defensively
    const key = classificationIdentityKey(r);
    if (!key || existing.has(key)) continue;
    existing.set(key, {
      categoryId: r.categoryId ?? null,
      subcategoryIds: [],
      brandId: null,
      source: "auto",
      confidence: null,
    });
    await rememberClassification({
      partNo: r.partNo,
      description: r.description,
      lineItem: r.lineItem,
      categoryId: r.categoryId ?? null,
      source: "auto",
    }).catch(() => {});
    seeded += 1;
  }
  return seeded;
}

/**
 * Repair inconsistent classifications — إصلاح تضارب التصنيف.
 *
 * The gap this closes: a decision made ONCE is now reused (identity memory), but
 * items classified BEFORE that memory existed are already stored inconsistently
 * — the same item is «كهرباء» on one RFQ, «إضاءة» on another and «غير مصنّف» on
 * the rest. Memory cannot fix those, because the items already carry a category
 * and the classifier only ever looks at UNCLASSIFIED rows.
 *
 * This pass groups every item by identity and, for an identity whose items
 * DISAGREE on a category, rewrites them all to ONE canonical value:
 *
 *   1. A MANAGER decision in the memory (source = 'manual') wins outright.
 *   2. Otherwise the MAJORITY existing category (tie → the newer id, which is
 *      stable because items are read newest-first).
 *   3. Otherwise the deterministic classifier, as a last resort.
 *
 * Only identities with TWO OR MORE real categories are touched — a consistent
 * item, and an item that is merely unclassified, are never rewritten. Every
 * change is attributed to the identity, so the next RFQ reuses it with no model
 * call. Best-effort at boot; runnable on demand from the «تصنيفات البنود» tab.
 */
export async function repairClassificationConsistency(
  opts: { limit?: number } = {},
): Promise<{ identities: number; itemsFixed: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 5000, 1), 20000);
  const items = await db
    .select({
      id: customerRfqItemsTable.id,
      customerRfqId: customerRfqItemsTable.customerRfqId,
      description: customerRfqItemsTable.description,
      partNo: customerRfqItemsTable.partNo,
      lineItem: customerRfqItemsTable.lineItem,
      categoryId: customerRfqItemsTable.categoryId,
      subcategoryIds: customerRfqItemsTable.subcategoryIds,
    })
    .from(customerRfqItemsTable)
    .where(eq(customerRfqItemsTable.isCancelled, false))
    .orderBy(desc(customerRfqItemsTable.id))
    .limit(limit);

  const categories = await loadCategories();
  // A category is resolved to its FUNCTIONAL DOMAIN before comparison: «إضاءة»
  // is a subcategory of «كهرباء», so storing إضاءة on one item and كهرباء on
  // another is NOT a real disagreement — both mean the same owner. Only two
  // different DOMAINS are a conflict worth repairing, and the canonical value
  // written back is always the domain (responsibility lives there).
  const domainIdOf = (categoryId: number | null): number | null =>
    categoryId == null ? null : resolveDomainId(categoryId, categories);

  const byKey = new Map<string, typeof items>();
  for (const it of items) {
    const key = classificationIdentityKey(it);
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(it);
    else byKey.set(key, [it]);
  }

  const conflicting: Array<{ key: string; rows: typeof items }> = [];
  for (const [key, rows] of byKey) {
    const domains = new Set(
      rows.map((r) => domainIdOf(r.categoryId)).filter((d): d is number => d != null),
    );
    const hasUnclassified = rows.some((r) => r.categoryId == null);
    // Inconsistent when the SAME identity resolves to more than one DOMAIN, OR
    // when only SOME of its items are classified and the rest are not — the
    // partial case is the same defect from the operator's view («البند نفسه
    // ظاهر مصنّفًا في طلب وغير مصنّف في الباقي»). Both are repaired the same way.
    if (domains.size >= 2 || (domains.size >= 1 && hasUnclassified)) {
      conflicting.push({ key, rows });
    }
  }
  if (conflicting.length === 0) return { identities: 0, itemsFixed: 0 };

  const memory = await loadClassificationMap(items).catch(
    () => new Map<string, RememberedClassification>(),
  );
  const vocabulary = await loadClassifierVocabulary();
  const affected = new Set<number>();
  let itemsFixed = 0;

  for (const { key, rows } of conflicting) {
    const remembered = memory.get(key);
    let canonical: number | null = null;
    let canonicalReason = "identity: unified";
    if (remembered?.source === "manual" && remembered.categoryId != null) {
      canonical = domainIdOf(remembered.categoryId);
      canonicalReason = "identity: manual";
    } else {
      // Majority DOMAIN (rows are newest-first, so the first max is the newer id).
      const counts = new Map<number, number>();
      for (const r of rows) {
        const d = domainIdOf(r.categoryId);
        if (d == null) continue;
        counts.set(d, (counts.get(d) ?? 0) + 1);
      }
      let bestN = -1;
      for (const [cid, n] of counts) {
        if (n > bestN) {
          bestN = n;
          canonical = cid;
        }
      }
      if (canonical == null) {
        // Every row was unclassified but two domains came from somewhere —
        // fall back to the classifier on the newest row.
        const kw = classifyItem(rows[0], categories, vocabulary);
        if (kw.categoryId != null && kw.confidence >= MIN_CONFIDENCE) canonical = kw.categoryId;
      }
    }
    if (canonical == null) continue;

    for (const r of rows) {
      // Skip only when the item ALREADY holds the canonical category exactly.
      // A subcategory (إضاءة) whose DOMAIN is canonical is still rewritten to the
      // domain, so every item of the identity DISPLAYS the same value — the whole
      // point of the repair. The subcategory is preserved in `subcategoryIds`.
      if (r.categoryId === canonical) continue;
      let nextSubs: string | null = r.subcategoryIds ?? null;
      if (r.categoryId != null && domainIdOf(r.categoryId) === canonical) {
        const parsed: number[] = (() => {
          try {
            const v = JSON.parse(r.subcategoryIds ?? "[]");
            return Array.isArray(v) ? v.filter((n) => typeof n === "number") : [];
          } catch {
            return [];
          }
        })();
        const merged = [...new Set([...parsed, r.categoryId])];
        nextSubs = JSON.stringify(merged);
      }
      await db
        .update(customerRfqItemsTable)
        .set({ categoryId: canonical, subcategoryIds: nextSubs, classifyReason: canonicalReason })
        .where(eq(customerRfqItemsTable.id, r.id));
      itemsFixed += 1;
      if (r.customerRfqId != null) affected.add(r.customerRfqId);
    }
    if (remembered?.source !== "manual") {
      await rememberClassification({
        partNo: rows[0].partNo,
        description: rows[0].description,
        lineItem: rows[0].lineItem,
        categoryId: canonical,
        source: "auto",
      }).catch(() => {});
    }
  }

  for (const rfqId of affected) await ensureCustomerAssignmentsSafe(rfqId);
  return { identities: conflicting.length, itemsFixed };
}

/**
 * Read-only view of the conflicts, for the «تصنيفات البنود» tab: which identities
 * disagree, on which categories, and a sample description. No writes.
 */
export async function listClassificationConflicts(limit = 5000): Promise<
  Array<{
    identityKey: string;
    itemCount: number;
    categories: Array<{ id: number; name: string; count: number }>;
    sampleDescription: string | null;
  }>
> {
  const items = await db
    .select({
      id: customerRfqItemsTable.id,
      description: customerRfqItemsTable.description,
      partNo: customerRfqItemsTable.partNo,
      lineItem: customerRfqItemsTable.lineItem,
      categoryId: customerRfqItemsTable.categoryId,
    })
    .from(customerRfqItemsTable)
    .where(eq(customerRfqItemsTable.isCancelled, false))
    .orderBy(desc(customerRfqItemsTable.id))
    .limit(Math.min(Math.max(limit, 1), 20000));

  const byKey = new Map<string, typeof items>();
  for (const it of items) {
    const key = classificationIdentityKey(it);
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(it);
    else byKey.set(key, [it]);
  }
  const categories = await loadCategories();
  const nameById = new Map(categories.map((c) => [c.id, c.name]));
  const domainIdOf = (categoryId: number | null): number | null =>
    categoryId == null ? null : resolveDomainId(categoryId, categories);

  const out: Array<{
    identityKey: string;
    itemCount: number;
    categories: Array<{ id: number; name: string; count: number }>;
    sampleDescription: string | null;
  }> = [];
  for (const [identityKey, rows] of byKey) {
    const counts = new Map<number, number>();
    for (const r of rows) {
      if (r.categoryId == null) continue;
      counts.set(r.categoryId, (counts.get(r.categoryId) ?? 0) + 1);
    }
    const domains = new Set(
      rows.map((r) => domainIdOf(r.categoryId)).filter((d): d is number => d != null),
    );
    const hasUnclassified = rows.some((r) => r.categoryId == null);
    // Same rule as `repairClassificationConsistency`: a conflicting identity is
    // one resolving to 2+ domains, or one that is only PARTIALLY classified.
    if (domains.size < 2 && !(domains.size >= 1 && hasUnclassified)) continue;
    out.push({
      identityKey,
      itemCount: rows.length,
      categories: [...counts]
        .map(([id, count]) => ({ id, name: nameById.get(id) ?? `#${id}`, count }))
        .sort((a, b) => b.count - a.count),
      sampleDescription: rows[0].description ?? null,
    });
  }
  return out.sort((a, b) => b.itemCount - a.itemCount);
}

/**
 * Backfill: classify every still-unclassified customer item with the LLM, in
 * batches, then assign each affected RFQ's items. Used by the «تصنيف آلي»
 * action so items created before the classifier could reach the whole catalogue
 * (or before AI was configured) get a category without re-saving each request.
 *
 * One batched provider request per `BATCH` items — never one per item. Items the
 * model declines stay unclassified on purpose (never invent a responsibility).
 * The run is bounded by `limit` so a single call cannot walk a huge backlog.
 */
export async function classifyUnclassifiedItems(
  opts: { limit?: number; useAi?: boolean } = {},
): Promise<{ scanned: number; classified: number; batches: number }> {
  const useAi = opts.useAi !== false;
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const items = await db
    .select({
      id: customerRfqItemsTable.id,
      customerRfqId: customerRfqItemsTable.customerRfqId,
      description: customerRfqItemsTable.description,
      partNo: customerRfqItemsTable.partNo,
      lineItem: customerRfqItemsTable.lineItem,
    })
    .from(customerRfqItemsTable)
    .where(
      and(isNull(customerRfqItemsTable.categoryId), eq(customerRfqItemsTable.isCancelled, false)),
    )
    .orderBy(asc(customerRfqItemsTable.id))
    .limit(limit);

  if (items.length === 0) return { scanned: 0, classified: 0, batches: 0 };

  const categories = await loadCategories();
  const vocabulary = await loadClassifierVocabulary();
  const BATCH = 40;
  const affectedRfqs = new Set<number>();
  let classified = 0;
  let batches = 0;

  for (let start = 0; start < items.length; start += BATCH) {
    const chunk = items.slice(start, start + BATCH);

    // Identity memory first — an item already classified elsewhere is resolved
    // from memory with no model call, and the rest go to the model together.
    const memory = await loadClassificationMap(chunk).catch(
      () => new Map<string, RememberedClassification>(),
    );
    const fromMemory = new Set<number>();
    for (const it of chunk) {
      const key = classificationIdentityKey(it);
      const m = key ? memory.get(key) : undefined;
      if (!m || m.categoryId == null) continue;
      await db
        .update(customerRfqItemsTable)
        .set({
          categoryId: m.categoryId,
          brandId: m.brandId,
          subcategoryIds: m.subcategoryIds.length ? JSON.stringify(m.subcategoryIds) : null,
          classifyConfidence: String(m.confidence ?? 100),
          classifyReason: m.source === "manual" ? "identity: manual" : "identity: auto",
        })
        .where(eq(customerRfqItemsTable.id, it.id));
      affectedRfqs.add(it.customerRfqId);
      fromMemory.add(it.id);
      classified += 1;
    }

    const needModel = chunk.filter((it) => !fromMemory.has(it.id));
    const results =
      useAi && needModel.length > 0 ? await classifyItemsWithAi(needModel, categories) : null;
    batches += 1;
    // A `null` means NO request could be made at all (provider down / quota
    // exhausted). The deterministic keyword classifier still runs below, so the
    // backlog is classified without the model — classification must never depend
    // on LLM availability.
    for (let i = 0; i < needModel.length; i += 1) {
      const it = needModel[i];
      const ai = results?.[i] ?? null;
      let categoryId = ai?.categoryId ?? null;
      let confidence = ai?.confidence ?? 0;
      let subIds = ai?.subcategoryIds ?? [];
      let brandId = ai?.brandId ?? null;
      let reason = ai?.reason ?? null;
      let attributes: Record<string, string> | null = ai?.attributes ?? null;
      if (categoryId == null || confidence < MIN_CONFIDENCE) {
        // Deterministic fallback (also covers a model decline / no provider).
        const kw = classifyItem(it, categories, vocabulary);
        if (kw.categoryId != null && kw.confidence >= MIN_CONFIDENCE) {
          categoryId = kw.categoryId;
          confidence = kw.confidence;
          subIds = kw.subcategoryIds ?? [];
          brandId = null;
          reason = kw.matchedTerm ? `keyword: ${kw.matchedTerm}` : null;
          attributes = null;
        }
      }
      if (categoryId == null || confidence < MIN_CONFIDENCE) continue;
      await db
        .update(customerRfqItemsTable)
        .set({
          categoryId,
          brandId,
          subcategoryIds: subIds.length ? JSON.stringify(subIds) : null,
          technicalAttributes: attributes ? JSON.stringify(attributes) : null,
          classifyConfidence: String(confidence),
          classifyReason: reason,
        })
        .where(eq(customerRfqItemsTable.id, it.id));
      affectedRfqs.add(it.customerRfqId);
      classified += 1;
      await rememberClassification({
        partNo: it.partNo,
        description: it.description,
        lineItem: it.lineItem,
        categoryId,
        subcategoryIds: subIds,
        brandId,
        source: "auto",
        confidence,
      }).catch(() => {});
    }
  }

  // Assign owners for the RFQs we touched (idempotent — only unassigned items).
  for (const rfqId of affectedRfqs) {
    await ensureCustomerAssignmentsSafe(rfqId);
  }

  return { scanned: items.length, classified, batches };
}

/**
 * Manual override / re-assignment of one customer item. Records an audit row
 * with the old and new values, the actor and an optional reason, so a change in
 * responsibility is always explainable after the fact.
 */
export async function assignCustomerItemManually(params: {
  customerRfqItemId: number;
  categoryId: number | null;
  employeeId: number | null;
  assignedBy: number | null;
  reason?: string | null;
}): Promise<void> {
  const { customerRfqItemId, categoryId, employeeId, assignedBy, reason } = params;

  await db.transaction(async (tx) => {
    // Lock the item row FIRST — serializes every writer of this item's periods.
    await lockItemRows(tx, [customerRfqItemId]);

    const [item] = await tx
      .select({
        id: customerRfqItemsTable.id,
        categoryId: customerRfqItemsTable.categoryId,
        description: customerRfqItemsTable.description,
        partNo: customerRfqItemsTable.partNo,
        lineItem: customerRfqItemsTable.lineItem,
      })
      .from(customerRfqItemsTable)
      .where(eq(customerRfqItemsTable.id, customerRfqItemId));
    if (!item) throw new Error("customer rfq item not found");

    const [prev] = await tx
      .select({
        categoryId: customerRfqItemAssignmentsTable.categoryId,
        employeeId: customerRfqItemAssignmentsTable.employeeId,
      })
      .from(customerRfqItemAssignmentsTable)
      .where(
        and(
          eq(customerRfqItemAssignmentsTable.customerRfqItemId, customerRfqItemId),
          isNull(customerRfqItemAssignmentsTable.validTo),
        ),
      );

    const categoryChanged = (prev?.categoryId ?? null) !== (categoryId ?? null);
    let employeeChanged = (prev?.employeeId ?? null) !== (employeeId ?? null);

    // «الماركة لا تكون مسؤولًا» — enforced HERE too, not only in the API routes.
    // Recording a category (even a subcategory/brand) for review is fine, but an
    // OWNER may only be recorded for a FUNCTIONAL domain: a non-functional
    // category leaves the owner unchanged rather than set to an invalid employee.
    let effectiveEmployeeId = employeeId;
    if (categoryId != null && employeeId != null) {
      const cats = await loadCategories();
      if (!isOwnableAssignment(categoryId, employeeId, cats)) {
        effectiveEmployeeId = prev?.employeeId ?? null;
      }
    }
    employeeChanged = (prev?.employeeId ?? null) !== (effectiveEmployeeId ?? null);

    if (categoryId != null) {
      await tx
        .update(customerRfqItemsTable)
        .set({ categoryId })
        .where(eq(customerRfqItemsTable.id, customerRfqItemId));
    }

    // A no-op re-save does not rewrite history — only a real change closes the
    // current period and opens a new one.
    if (categoryChanged || employeeChanged || !prev) {
      const at = await dbClockTimestamp(tx);
      await closeAndOpenPeriod(
        tx,
        {
          customerRfqItemId,
          categoryId,
          employeeId: effectiveEmployeeId,
          source: "manual",
          confidence: null,
          assignedBy,
        },
        at,
      );
      await tx.insert(itemAssignmentAuditTable).values({
        scope: "customer",
        customerRfqItemId,
        categoryIdOld: prev?.categoryId ?? item.categoryId ?? null,
        categoryIdNew: categoryId ?? null,
        employeeIdOld: prev?.employeeId ?? null,
        employeeIdNew: effectiveEmployeeId ?? null,
        changedBy: assignedBy,
        reason: reason ?? null,
      });
    }

    // The manager CONFIRMED this item's category: learn its decisive terms so a
    // similar item is classified next time without a model call. Best-effort —
    // a learning failure must never fail the correction itself.
    if (categoryId != null && categoryChanged) {
      await learnFromCorrection(tx, categoryId, {
        description: item.description,
        partNo: item.partNo,
        lineItem: item.lineItem,
      }).catch(() => {});
    }

    // Record the manager's decision against the item's IDENTITY. This is
    // AUTHORITATIVE: `source: 'manual'` is never overwritten by an automatic
    // classification, so the same item in a later RFQ keeps the manager's
    // category. Written even when only the OWNER changed (categoryId unchanged)
    // so a re-confirmation refreshes the memory's evidence.
    if (categoryId != null) {
      await rememberClassification(
        {
          partNo: item.partNo,
          description: item.description,
          lineItem: item.lineItem,
          categoryId,
          source: "manual",
          confidence: 100,
          decidedBy: assignedBy,
        },
        tx,
      ).catch(() => {});
    }
  });
}

/**
 * Learn from a manager's confirmed classification. Extracts the decisive terms
 * from the item text and adds the ones the category does not already know to its
 * vocabulary — free (no model call), reversible (each is a normal keyword row a
 * manager can disable or delete) and conservative (brands, generic words and
 * pure numbers are refused, so a wrong rule is not created by a correction).
 *
 * Returns the terms actually added, for the audit/telemetry.
 */
export async function learnFromCorrection(
  tx: DbLike,
  categoryId: number,
  item: { description?: string | null; partNo?: string | null; lineItem?: string | null },
): Promise<string[]> {
  // Brand names must never become keywords: a brand is a maker, not a domain.
  const brandRows = await tx
    .select({ name: itemCategoriesTable.name })
    .from(itemCategoriesTable)
    .where(eq(itemCategoriesTable.kind, "brand"));
  const terms = pickLearnableKeywords(
    item,
    brandRows.map((b) => b.name),
    LEARN_KEYWORD_LIMIT,
  );
  if (terms.length === 0) return [];

  // Which of these does the category already know? Only NEW terms are added.
  const existing = await tx
    .select({ keyword: itemCategoryKeywordsTable.keyword })
    .from(itemCategoryKeywordsTable)
    .where(eq(itemCategoryKeywordsTable.categoryId, categoryId));
  const known = new Set(existing.map((e) => normalizeText(e.keyword)));
  const toAdd = terms.filter((t) => !known.has(t));
  if (toAdd.length === 0) return [];

  await tx
    .insert(itemCategoryKeywordsTable)
    .values(toAdd.map((keyword) => ({ categoryId, keyword, weight: 0, language: null })))
    .onConflictDoNothing();
  return toAdd;
}

/**
 * Resolve the responsible employee for a supplier RFQ item by reading its
 * originating CUSTOMER item. Returns null when the item has no customer origin
 * (a manually-created supplier RFQ) — such an item keeps its own independent
 * assignment and is NOT counted in the customer-item KPI.
 */
export async function responsibleForRfqItem(customerRfqItemId: number | null): Promise<{
  employeeId: number | null;
  categoryId: number | null;
  employeeName: string | null;
} | null> {
  if (customerRfqItemId == null) return null;
  const [row] = await db
    .select({
      employeeId: customerRfqItemAssignmentsTable.employeeId,
      categoryId: customerRfqItemAssignmentsTable.categoryId,
      employeeName: employeesTable.name,
    })
    .from(customerRfqItemAssignmentsTable)
    .leftJoin(employeesTable, eq(customerRfqItemAssignmentsTable.employeeId, employeesTable.id))
    .where(
      and(
        eq(customerRfqItemAssignmentsTable.customerRfqItemId, customerRfqItemId),
        isNull(customerRfqItemAssignmentsTable.validTo),
      ),
    );
  if (!row) return null;
  return {
    employeeId: row.employeeId ?? null,
    categoryId: row.categoryId ?? null,
    employeeName: row.employeeName ?? null,
  };
}
