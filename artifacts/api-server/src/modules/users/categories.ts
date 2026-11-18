/**
 * Supplier trade categories — تصنيفات الموردين
 *
 * Routes (behind requireAuth):
 *   GET    /categories                 — list (active by default; ?includeDeleted=1)
 *   GET    /categories/report          — cleanup report (counts, unused, duplicates)
 *   POST   /categories                 — create (admin/manager)
 *   PATCH  /categories/:id             — rename / re-parent / reorder (admin/manager)
 *   DELETE /categories/:id             — SOFT delete (admin/manager) — hidden, restorable
 *   POST   /categories/:id/restore     — restore a soft-deleted category
 *   POST   /categories/merge           — merge two categories (admin/manager, explicit)
 *
 * Design rules, each from a live defect:
 *   • SOFT delete. A category with history is never removed — hiding it keeps
 *     every link, keyword and audit row intact, and restore is exact.
 *   • A name is normalised on write (trim + collapse whitespace) and compared by
 *     `categoryKey`, so «معدات  فندقيه» and «معدات فندقيه» are ONE category.
 *   • A merge is NEVER automatic. `POST /categories/merge` performs an explicit,
 *     audited move of every relation; nothing here decides on name similarity.
 *   • The parent cycle check uses `wouldCycle`, so a deep tree cannot loop.
 */
import { guardFor } from "../../shared/permissions";
import { Router } from "express";
import {
  db,
  supplierCategoriesTable,
  supplierCategoryLinksTable,
  itemCategoriesTable,
  auditLogTable,
  suppliersTable,
} from "@workspace/db";
import { eq, asc, count, and, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { rewriteSupplierCategoryName } from "../../shared/category-rename";
import {
  canonicalCategoryName,
  categoryKey,
  descendantIds,
  nonLeafHolders,
  redundantParentLinks,
  wouldCycle,
} from "../../shared/category-tree";
import { mergeSupplierCategories } from "../../shared/category-merge";
import { findActiveTwin } from "../../shared/category-dedupe";
import {
  isReviewPlaceholder,
  moveOrphansToPlaceholder,
  pruneEmptyReviewPlaceholders,
} from "../../shared/category-placeholder";

const router = Router();
router.use("/categories", guardFor("/categories"));

interface CategoryRow {
  id: number;
  name: string;
  parentId: number | null;
}

function serialize(row: typeof supplierCategoriesTable.$inferSelect, supplierCount = 0) {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId ?? null,
    isActive: row.isActive,
    deletedAt: row.deletedAt ?? null,
    sortOrder: row.sortOrder,
    supplierCount,
  };
}

/** Supplier counts per category, batched (one query, no N+1). */
async function loadSupplierCounts(): Promise<Map<number, number>> {
  const rows = await db
    .select({
      categoryId: supplierCategoryLinksTable.categoryId,
      n: count(),
    })
    .from(supplierCategoryLinksTable)
    .groupBy(supplierCategoryLinksTable.categoryId);
  return new Map(rows.map((r) => [r.categoryId, Number(r.n)]));
}

router.get("/categories", requireAuth, async (req, res): Promise<void> => {
  const includeDeleted = String(req.query.includeDeleted ?? "") === "1";
  const rows = await db
    .select()
    .from(supplierCategoriesTable)
    .where(includeDeleted ? undefined : eq(supplierCategoriesTable.isActive, true))
    .orderBy(asc(supplierCategoriesTable.sortOrder), asc(supplierCategoriesTable.name));
  const counts = await loadSupplierCounts();
  res.json(rows.map((r) => serialize(r, counts.get(r.id) ?? 0)));
});

/**
 * Cleanup report — what an operator needs before tidying the catalogue:
 * which categories are unused, which look like duplicates (same `categoryKey`),
 * and the totals. Read-only; it NEVER merges or deletes anything.
 */
router.get("/categories/report", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(supplierCategoriesTable);
  const counts = await loadSupplierCounts();

  const byKey = new Map<string, CategoryRow[]>();
  for (const r of rows) {
    const key = categoryKey(r.name);
    const list = byKey.get(key) ?? [];
    list.push({ id: r.id, name: r.name, parentId: r.parentId ?? null });
    byKey.set(key, list);
  }
  const duplicates = [...byKey.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({ key: categoryKey(g[0].name), categories: g }));

  const unused = rows
    .filter((r) => r.isActive && (counts.get(r.id) ?? 0) === 0)
    .map((r) => serialize(r, 0));

  res.json({
    totals: {
      total: rows.length,
      active: rows.filter((r) => r.isActive).length,
      deleted: rows.filter((r) => !r.isActive).length,
      unused: unused.length,
      duplicateGroups: duplicates.length,
    },
    unused,
    duplicates,
  });
});

/**
 * READ-ONLY: the categories that are NOT leaves but still hold suppliers — the
 * list the operator must re-file by hand before the leaf-only rule is fully
 * satisfied. Nothing is moved or deleted here: an automatic re-file would
 * silently change which trade a supplier belongs to, and the operator asked
 * explicitly that no assignment change without review.
 */
router.get("/categories/parent-assignments", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(supplierCategoriesTable);
  const live = rows.filter((r) => r.deletedAt == null);
  const nodes = live.map((r) => ({ id: r.id, name: r.name, parentId: r.parentId ?? null }));
  const liveIds = new Set(nodes.map((n) => n.id));

  const links = await db
    .select({
      categoryId: supplierCategoryLinksTable.categoryId,
      supplierId: supplierCategoryLinksTable.supplierId,
      supplierName: suppliersTable.name,
    })
    .from(supplierCategoryLinksTable)
    .innerJoin(suppliersTable, eq(suppliersTable.id, supplierCategoryLinksTable.supplierId));

  const holders = new Map<number, Array<{ id: number; name: string }>>();
  for (const l of links) {
    const list = holders.get(l.categoryId) ?? [];
    list.push({ id: l.supplierId, name: l.supplierName });
    holders.set(l.categoryId, list);
  }

  // The placeholder is a WORKING STATE, not a category to review — it must not
  // appear in its own report.
  const groups = nonLeafHolders(nodes, holders, liveIds).filter(
    (g) => !isReviewPlaceholder(g.name),
  );

  // The PROVABLE half: a supplier filed under a grouping category AND under one
  // of its descendants. Filtering the tree already reaches him through the
  // subtree, so the parent link is redundant and can be dropped with no loss.
  const allLinks = await db
    .select({
      supplierId: supplierCategoryLinksTable.supplierId,
      categoryId: supplierCategoryLinksTable.categoryId,
    })
    .from(supplierCategoryLinksTable);
  const nameById = new Map(nodes.map((n) => [n.id, n.name]));
  const supplierNameById = new Map<number, string>();
  for (const l of links) supplierNameById.set(l.supplierId, l.supplierName);
  const redundant = redundantParentLinks(nodes, allLinks).map((l) => {
    const sub = descendantIds(nodes, l.categoryId);
    const keptOn = allLinks
      .filter(
        (x) =>
          x.supplierId === l.supplierId && x.categoryId !== l.categoryId && sub.has(x.categoryId),
      )
      .map((x) => nameById.get(x.categoryId) ?? `#${x.categoryId}`);
    return {
      supplierId: l.supplierId,
      supplierName: supplierNameById.get(l.supplierId) ?? `#${l.supplierId}`,
      categoryId: l.categoryId,
      categoryName: nameById.get(l.categoryId) ?? `#${l.categoryId}`,
      keptOn,
    };
  });

  const redundantByCategory = new Map<number, number>();
  for (const r of redundant) {
    redundantByCategory.set(r.categoryId, (redundantByCategory.get(r.categoryId) ?? 0) + 1);
  }

  // The «يحتاج للمراجعة» placeholders: the suppliers waiting to be re-filed.
  // This is the operator's actual to-do list once the cleanup has run.
  const placeholders = nodes
    .filter((n) => isReviewPlaceholder(n.name))
    .map((n) => ({
      id: n.id,
      parentId: n.parentId ?? null,
      parentName: n.parentId != null ? (nameById.get(n.parentId) ?? null) : null,
      holderCount: (holders.get(n.id) ?? []).length,
      holders: holders.get(n.id) ?? [],
    }))
    .filter((p) => p.holderCount > 0);

  res.json({
    totals: {
      categoriesWithSuppliers: groups.length,
      suppliersToRefile: groups.reduce((n, g) => n + g.holderCount, 0),
      redundantLinks: redundant.length,
      onlyOnParent: groups.reduce((n, g) => n + g.holderCount, 0) - redundant.length,
    },
    groups: groups.map((g) => ({ ...g, redundantCount: redundantByCategory.get(g.id) ?? 0 })),
    redundant,
    placeholders,
  });
});

/**
 * Remove ONLY the provable redundant parent links (see `redundantParentLinks`).
 * A supplier filed under a grouping category AND one of its descendants keeps
 * the descendant link; the parent link adds nothing and is dropped. A supplier
 * filed under the grouping category ALONE is never touched — nobody knows which
 * leaf his trade belongs to, so the operator re-files him by hand.
 */
router.post(
  "/categories/parent-assignments/cleanup",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const rows = await db.select().from(supplierCategoriesTable);
    const live = rows.filter((r) => r.deletedAt == null);
    const nodes = live.map((r) => ({ id: r.id, name: r.name, parentId: r.parentId ?? null }));
    const liveIds = new Set(nodes.map((n) => n.id));

    const allLinks = await db
      .select({
        supplierId: supplierCategoryLinksTable.supplierId,
        categoryId: supplierCategoryLinksTable.categoryId,
        supplierName: suppliersTable.name,
      })
      .from(supplierCategoryLinksTable)
      .innerJoin(suppliersTable, eq(suppliersTable.id, supplierCategoryLinksTable.supplierId));

    const links = allLinks.map((l) => ({ supplierId: l.supplierId, categoryId: l.categoryId }));

    // 1) Drop the provable redundant parent links.
    const redundant = redundantParentLinks(nodes, links);
    const nameById = new Map(nodes.map((n) => [n.id, n.name]));
    const removedBySupplier = new Map<number, Set<number>>();
    for (const l of redundant) {
      const set = removedBySupplier.get(l.supplierId) ?? new Set<number>();
      set.add(l.categoryId);
      removedBySupplier.set(l.supplierId, set);
    }
    const survivingNames = new Map<number, string[]>();
    for (const [supplierId, removed] of removedBySupplier) {
      const names = links
        .filter((x) => x.supplierId === supplierId && !removed.has(x.categoryId))
        .map((x) => nameById.get(x.categoryId))
        .filter((n): n is string => Boolean(n));
      survivingNames.set(supplierId, names);
    }

    if (redundant.length > 0) {
      await db.transaction(async (tx) => {
        for (const l of redundant) {
          await tx
            .delete(supplierCategoryLinksTable)
            .where(
              and(
                eq(supplierCategoryLinksTable.supplierId, l.supplierId),
                eq(supplierCategoryLinksTable.categoryId, l.categoryId),
              ),
            );
        }
        // The free-text mirror on `suppliers.category` is a comma-joined name
        // list; leaving it stale would make the list show a category the link no
        // longer holds. Rewrite it from the SURVIVING links.
        for (const [supplierId, names] of survivingNames) {
          await tx
            .update(suppliersTable)
            .set({ category: names.join(",") })
            .where(eq(suppliersTable.id, supplierId));
        }
        await tx.insert(auditLogTable).values({
          action: "supplier_category.parent_links_cleaned",
          entityType: "supplier_category",
          employeeId: req.session.employeeId,
          description: `Removed ${redundant.length} redundant parent-category supplier link(s)`,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        });
      });
    }

    // 2) Move every supplier who is STILL on a grouping category ALONE into that
    //    category's «يحتاج للمراجعة» placeholder leaf. Recompute the holders from
    //    the links that survive step 1, so a supplier just cleaned up is not
    //    moved as well.
    const removedKeys = new Set(redundant.map((l) => `${l.supplierId}:${l.categoryId}`));
    const survivingLinks = links.filter((l) => !removedKeys.has(`${l.supplierId}:${l.categoryId}`));
    const holders = new Map<number, Array<{ id: number; name: string }>>();
    for (const l of allLinks) {
      if (removedKeys.has(`${l.supplierId}:${l.categoryId}`)) continue;
      const list = holders.get(l.categoryId) ?? [];
      list.push({ id: l.supplierId, name: l.supplierName });
      holders.set(l.categoryId, list);
    }
    const groups = nonLeafHolders(nodes, holders, liveIds).filter(
      (g) => !isReviewPlaceholder(g.name),
    );

    let moved = 0;
    for (const g of groups) {
      moved += await moveOrphansToPlaceholder(g.id, g.name, g.holders);
    }

    // 3) A placeholder that now holds nothing (its suppliers were all re-filed)
    //    is removed. Runs even when nothing moved, so a placeholder emptied by
    //    hand disappears on the next run.
    const pruned = await pruneEmptyReviewPlaceholders();

    res.json({
      ok: true,
      removed: redundant.length,
      moved,
      pruned,
      remaining: survivingLinks.length,
    });
  },
);

/** Create a category. The name is normalised; a duplicate key is refused. */
router.post("/categories", requireRole("admin", "manager"), async (req, res): Promise<void> => {
  const { name, parentId } = req.body as { name?: string; parentId?: number | null };
  if (!name?.trim()) {
    res.status(400).json({ error: "اسم التصنيف مطلوب" });
    return;
  }
  const clean = canonicalCategoryName(name);
  const pId = parentId ? Number(parentId) : null;

  const all = await db
    .select({
      id: supplierCategoriesTable.id,
      name: supplierCategoriesTable.name,
      parentId: supplierCategoriesTable.parentId,
    })
    .from(supplierCategoriesTable);
  if (pId != null && !all.some((c) => c.id === pId)) {
    res.status(400).json({ error: "التصنيف الأب غير موجود" });
    return;
  }
  const clash = all.find(
    (c) => (c.parentId ?? null) === pId && categoryKey(c.name) === categoryKey(clean),
  );
  if (clash) {
    res.status(409).json({ error: "التصنيف موجود بالفعل", existingId: clash.id });
    return;
  }

  const [row] = await db
    .insert(supplierCategoriesTable)
    .values({ name: clean, parentId: pId })
    .returning();
  // Mirror into the item catalogue ONLY when the name is already a CANONICAL
  // item category (it carries a code). A free-text spelling must never create a
  // junk functional domain that classifies no item and owns no responsibility.
  try {
    const canonical = await db
      .select({ id: itemCategoriesTable.id })
      .from(itemCategoriesTable)
      .where(
        and(eq(itemCategoriesTable.name, row.name), sql`${itemCategoriesTable.code} IS NOT NULL`),
      )
      .limit(1);
    if (canonical.length > 0) {
      await db
        .insert(itemCategoriesTable)
        .values({ name: row.name, sortOrder: 100 })
        .onConflictDoNothing();
    }
  } catch {
    // best-effort — the startup mirror in init-db.ts re-syncs on the next boot.
  }
  await db.insert(auditLogTable).values({
    action: "supplier_category.created",
    entityType: "supplier_category",
    entityId: row.id,
    employeeId: req.session.employeeId,
    description: `Supplier category created: ${row.name}`,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });
  res.status(201).json(serialize(row, 0));
});

router.patch(
  "/categories/:id",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    const { name, parentId, sortOrder } = req.body as {
      name?: string;
      parentId?: number | null;
      sortOrder?: number;
    };

    const [current] = await db
      .select()
      .from(supplierCategoriesTable)
      .where(eq(supplierCategoriesTable.id, id));
    if (!current) {
      res.status(404).json({ error: "التصنيف غير موجود" });
      return;
    }

    const newName = name !== undefined ? canonicalCategoryName(name) : current.name;
    if (!newName) {
      res.status(400).json({ error: "اسم التصنيف مطلوب" });
      return;
    }
    const pId = parentId !== undefined ? (parentId ? Number(parentId) : null) : current.parentId;

    const all = await db
      .select({
        id: supplierCategoriesTable.id,
        name: supplierCategoriesTable.name,
        parentId: supplierCategoriesTable.parentId,
      })
      .from(supplierCategoriesTable);
    if (pId != null && !all.some((c) => c.id === pId)) {
      res.status(400).json({ error: "التصنيف الأب غير موجود" });
      return;
    }
    if (pId != null && wouldCycle(all, id, pId)) {
      res.status(400).json({ error: "لا يمكن أن يصبح التصنيف تابعًا لنفسه أو لأحد أبنائه" });
      return;
    }
    // Uniqueness is per PARENT: the same name may exist under another branch.
    const clash = all.find(
      (c) =>
        c.id !== id && (c.parentId ?? null) === pId && categoryKey(c.name) === categoryKey(newName),
    );
    if (clash) {
      res.status(409).json({ error: "التصنيف موجود بالفعل", existingId: clash.id });
      return;
    }

    // REPARENTING must not lose data: every supplier link follows by id, so
    // nothing is rewritten here. The move CAN leave this category a non-leaf
    // that still holds suppliers (it already has children), which the leaf-only
    // rule must eventually resolve. We never move those suppliers — the operator
    // reviews them — but the response SAYS so, so the state is not silent.
    const suppliersOnCategory = (await loadSupplierCounts()).get(id) ?? 0;
    const hasChildren = all.some((c) => c.id !== id && c.parentId === id);
    const becomesNonLeaf = suppliersOnCategory > 0 && hasChildren;

    const updates: Record<string, unknown> = { name: newName, parentId: pId };
    if (sortOrder !== undefined) updates.sortOrder = Number(sortOrder) || 0;

    const [row] = await db
      .update(supplierCategoriesTable)
      .set(updates)
      .where(eq(supplierCategoriesTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "التصنيف غير موجود" });
      return;
    }
    // Keep the item categories in step with the supplier categories (the SAME
    // list). The OLD name is the key — a rename moves the item category too.
    if (newName !== current.name) {
      try {
        await db
          .update(itemCategoriesTable)
          .set({ name: row.name })
          .where(eq(itemCategoriesTable.name, current.name));
      } catch {
        // best-effort — the startup mirror in init-db.ts re-syncs on the next boot.
      }
      await rewriteSupplierCategoryName(current.name, row.name);
    }
    await db.insert(auditLogTable).values({
      action: "supplier_category.updated",
      entityType: "supplier_category",
      entityId: row.id,
      employeeId: req.session.employeeId,
      description: `Supplier category updated: ${current.name} → ${row.name}`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });
    res.json({
      ...serialize(row, suppliersOnCategory),
      // Present only when the move creates a state the leaf-only rule must
      // eventually resolve. Informational: nothing was moved or deleted.
      ...(becomesNonLeaf
        ? {
            reviewNeeded: {
              suppliersOnCategory,
              reason:
                "التصنيف أصبح رئيسيًا وعليه موردون — أعد إسنادهم لتصنيف فرعي (لم يتم تغيير أي ارتباط تلقائيًا)",
            },
          }
        : {}),
    });
  },
);

/**
 * SOFT delete — hide the category, never remove it. Every relation (links,
 * keywords, history) is preserved so `restore` is exact. The guard that used to
 * block a delete when suppliers were linked is GONE on purpose: soft delete
 * cannot break a relation, so a used category is now deletable and restorable.
 */
router.delete(
  "/categories/:id",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    const [category] = await db
      .select()
      .from(supplierCategoriesTable)
      .where(eq(supplierCategoriesTable.id, id));
    if (!category) {
      res.status(404).json({ error: "التصنيف غير موجود" });
      return;
    }
    await db
      .update(supplierCategoriesTable)
      .set({ isActive: false, deletedAt: new Date() })
      .where(eq(supplierCategoriesTable.id, id));
    await db.insert(auditLogTable).values({
      action: "supplier_category.soft_deleted",
      entityType: "supplier_category",
      entityId: id,
      employeeId: req.session.employeeId,
      description: `Supplier category soft-deleted: ${category.name}`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });
    res.json({ ok: true, id, restored: false });
  },
);

/** Restore a soft-deleted category. The relations were never touched. */
router.post(
  "/categories/:id/restore",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    const [category] = await db
      .select()
      .from(supplierCategoriesTable)
      .where(eq(supplierCategoriesTable.id, id));
    if (!category) {
      res.status(404).json({ error: "التصنيف غير موجود" });
      return;
    }
    // The uniqueness index is on the NORMALISED name, so restoring a retired
    // duplicate while its twin is still active would violate it and surface as
    // an opaque 500. Refuse with the real reason: the two names are one trade,
    // and the operator should merge them instead (which is the confirmed flow).
    const twin = await findActiveTwin(
      supplierCategoriesTable,
      category.name,
      id,
      category.parentId ?? null,
    );
    if (twin) {
      res.status(409).json({
        error: `يوجد تصنيف آخر بنفس الاسم: «${twin.name}» — استخدم «دمج» لضمّه إليه`,
        existingId: twin.id,
      });
      return;
    }
    await db
      .update(supplierCategoriesTable)
      .set({ isActive: true, deletedAt: null })
      .where(eq(supplierCategoriesTable.id, id));
    await db.insert(auditLogTable).values({
      action: "supplier_category.restored",
      entityType: "supplier_category",
      entityId: id,
      employeeId: req.session.employeeId,
      description: `Supplier category restored: ${category.name}`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });
    res.json({ ok: true, id, restored: true });
  },
);

/**
 * Merge two categories — EXPLICIT, admin/manager only, never automatic. Every
 * relation moves to the target and the source is soft-deleted. Audited with the
 * full before/after so the change is explainable later.
 */
router.post(
  "/categories/merge",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const { sourceId, targetId } = req.body as { sourceId?: number; targetId?: number };
    const src = Number(sourceId);
    const dst = Number(targetId);
    if (!Number.isInteger(src) || !Number.isInteger(dst)) {
      res.status(400).json({ error: "sourceId و targetId مطلوبان" });
      return;
    }
    if (src === dst) {
      res.status(400).json({ error: "لا يمكن دمج التصنيف مع نفسه" });
      return;
    }
    const [srcRow] = await db
      .select()
      .from(supplierCategoriesTable)
      .where(eq(supplierCategoriesTable.id, src));
    const [dstRow] = await db
      .select()
      .from(supplierCategoriesTable)
      .where(eq(supplierCategoriesTable.id, dst));
    if (!srcRow || !dstRow) {
      res.status(404).json({ error: "أحد التصنيفين غير موجود" });
      return;
    }
    try {
      const result = await mergeSupplierCategories(src, dst, req.session.employeeId ?? null);
      await db.insert(auditLogTable).values({
        action: "supplier_category.merged",
        entityType: "supplier_category",
        entityId: dst,
        employeeId: req.session.employeeId,
        description: `Merged supplier category «${srcRow.name}» (#${src}) into «${dstRow.name}» (#${dst}); links moved: ${result.movedLinks}`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });
      res.json({ ok: true, ...result, sourceName: srcRow.name, targetName: dstRow.name });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

export default router;
