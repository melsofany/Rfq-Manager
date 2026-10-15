/**
 * Item categories + employee ownership — تصنيفات البنود واختصاص الموظفين
 *
 * Routes (behind requireAuth):
 *   GET    /item-categories                    — list (any authenticated)
 *   POST   /item-categories                    — create (admin/manager)
 *   PATCH  /item-categories/:id                — rename/toggle/order (admin/manager)
 *   DELETE /item-categories/:id                — delete (admin)
 *   GET    /item-categories/:id/owners         — who owns this category
 *   PUT    /item-categories/:id/owners         — replace owner set (admin/manager)
 *   GET    /employees/:id/categories           — categories an employee owns
 *   PUT    /employees/:id/categories           — replace (admin/manager)
 */
import { Router } from "express";
import {
  db,
  itemCategoriesTable,
  itemCategoryAliasesTable,
  employeeCategoriesTable,
  employeesTable,
  itemCategoryKeywordsTable,
  auditLogTable,
} from "@workspace/db";
import { eq, and, asc, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { isUniqueViolation } from "../../shared/pg-errors";

const router = Router();

const PRIMARY_CONFLICT_MESSAGE = "لا يمكن تعيين أكثر من مسؤول أساسي لنفس التصنيف";

/** functional | subcategory | brand. Anything else is rejected. */
const CATEGORY_KINDS = new Set(["functional", "subcategory", "brand"]);

/**
 * Only a FUNCTIONAL domain may carry procurement responsibility: a subcategory
 * inherits its domain's owner and a brand is metadata. Refusing an owner on a
 * non-functional category is what keeps a brand from ever deciding who handles
 * an item.
 */
async function assertOwnableCategory(categoryId: number): Promise<boolean> {
  const [row] = await db
    .select({ kind: itemCategoriesTable.kind })
    .from(itemCategoriesTable)
    .where(eq(itemCategoriesTable.id, categoryId))
    .limit(1);
  return !!row && (row.kind ?? "functional") === "functional";
}

/** At most one primary owner per category (0 or 1) — mirrors the DB index. */
function assertAtMostOnePrimary(items: Array<{ isPrimary?: boolean }>): boolean {
  return items.filter((o) => o.isPrimary).length <= 1;
}

function serializeCategory(c: typeof itemCategoriesTable.$inferSelect, aliases: string[] = []) {
  return {
    id: c.id,
    name: c.name,
    code: c.code,
    kind: c.kind,
    parentId: c.parentId,
    isActive: c.isActive,
    sortOrder: c.sortOrder,
    aliases,
  };
}

/** All aliases grouped by category id (one query, no N+1). */
async function loadAliases(): Promise<Map<number, string[]>> {
  const rows = await db
    .select({
      categoryId: itemCategoryAliasesTable.categoryId,
      alias: itemCategoryAliasesTable.alias,
    })
    .from(itemCategoryAliasesTable);
  const byCat = new Map<number, string[]>();
  for (const r of rows) {
    const list = byCat.get(r.categoryId) ?? [];
    list.push(r.alias);
    byCat.set(r.categoryId, list);
  }
  return byCat;
}

// ── Classification keywords (admin-managed vocabulary) ──────────────────────
// The classifier reads these terms instead of a hardcoded table. A category
// with no ENABLED keyword produces no candidate, so it can never be assigned
// automatically until its vocabulary is configured.

function serializeKeyword(k: typeof itemCategoryKeywordsTable.$inferSelect) {
  return {
    id: k.id,
    categoryId: k.categoryId,
    keyword: k.keyword,
    weight: k.weight,
    language: k.language,
    enabled: k.enabled,
  };
}

router.get("/item-categories/:id/keywords", requireAuth, async (req, res): Promise<void> => {
  const categoryId = parseInt(req.params.id as string, 10);
  const rows = await db
    .select()
    .from(itemCategoryKeywordsTable)
    .where(eq(itemCategoryKeywordsTable.categoryId, categoryId))
    .orderBy(asc(itemCategoryKeywordsTable.keyword));
  res.json(rows.map(serializeKeyword));
});

router.post(
  "/item-categories/:id/keywords",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const categoryId = parseInt(req.params.id as string, 10);
    const { keyword, weight, language } = req.body as {
      keyword?: string;
      weight?: number;
      language?: string | null;
    };
    const term = keyword?.trim();
    if (!term) {
      res.status(400).json({ error: "keyword required" });
      return;
    }
    try {
      const [created] = await db
        .insert(itemCategoryKeywordsTable)
        .values({
          categoryId,
          keyword: term,
          weight: Number.isFinite(weight) ? Number(weight) : 0,
          language: language ?? null,
        })
        .returning();
      await db.insert(auditLogTable).values({
        action: "item_category.keyword_added",
        entityType: "item_category",
        entityId: categoryId,
        employeeId: req.session.employeeId,
        description: `Category ${categoryId} keyword added: ${term}`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });
      res.status(201).json(serializeKeyword(created));
    } catch (err) {
      // UNIQUE(category_id, keyword) — the DB is the real guard.
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: "الكلمة موجودة بالفعل في هذا التصنيف" });
        return;
      }
      throw err;
    }
  },
);

router.patch(
  "/item-categories/:id/keywords/:keywordId",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const categoryId = parseInt(req.params.id as string, 10);
    const keywordId = parseInt(req.params.keywordId as string, 10);
    const { keyword, weight, language, enabled } = req.body as {
      keyword?: string;
      weight?: number;
      language?: string | null;
      enabled?: boolean;
    };
    const patch: Record<string, unknown> = {};
    if (keyword != null) {
      const term = keyword.trim();
      if (!term) {
        res.status(400).json({ error: "keyword cannot be empty" });
        return;
      }
      patch.keyword = term;
    }
    if (weight != null) patch.weight = Number(weight);
    if (language !== undefined) patch.language = language;
    if (enabled != null) patch.enabled = !!enabled;

    try {
      const [updated] = await db
        .update(itemCategoryKeywordsTable)
        .set(patch)
        .where(
          and(
            eq(itemCategoryKeywordsTable.id, keywordId),
            eq(itemCategoryKeywordsTable.categoryId, categoryId),
          ),
        )
        .returning();
      if (!updated) {
        res.status(404).json({ error: "الكلمة غير موجودة" });
        return;
      }
      await db.insert(auditLogTable).values({
        action: "item_category.keyword_updated",
        entityType: "item_category",
        entityId: categoryId,
        employeeId: req.session.employeeId,
        description: `Category ${categoryId} keyword ${keywordId} updated: ${JSON.stringify(patch)}`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });
      res.json(serializeKeyword(updated));
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: "الكلمة موجودة بالفعل في هذا التصنيف" });
        return;
      }
      throw err;
    }
  },
);

router.delete(
  "/item-categories/:id/keywords/:keywordId",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const categoryId = parseInt(req.params.id as string, 10);
    const keywordId = parseInt(req.params.keywordId as string, 10);
    await db
      .delete(itemCategoryKeywordsTable)
      .where(
        and(
          eq(itemCategoryKeywordsTable.id, keywordId),
          eq(itemCategoryKeywordsTable.categoryId, categoryId),
        ),
      );
    await db.insert(auditLogTable).values({
      action: "item_category.keyword_deleted",
      entityType: "item_category",
      entityId: categoryId,
      employeeId: req.session.employeeId,
      description: `Category ${categoryId} keyword ${keywordId} deleted`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });
    res.json({ ok: true });
  },
);

router.get("/item-categories", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(itemCategoriesTable)
    .orderBy(asc(itemCategoriesTable.sortOrder), asc(itemCategoriesTable.name));
  const aliases = await loadAliases();
  res.json(rows.map((c) => serializeCategory(c, aliases.get(c.id) ?? [])));
});

router.post(
  "/item-categories",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const { name, code, sortOrder, kind, parentId, aliases } = req.body as {
      name?: string;
      code?: string | null;
      sortOrder?: number;
      kind?: string | null;
      parentId?: number | null;
      aliases?: string[];
    };
    if (!name?.trim()) {
      res.status(400).json({ error: "اسم التصنيف مطلوب" });
      return;
    }
    const trimmed = name.trim();
    const kindValue = kind?.trim() || "functional";
    if (!CATEGORY_KINDS.has(kindValue)) {
      res.status(400).json({ error: "نوع التصنيف غير صالح (functional/subcategory/brand)" });
      return;
    }
    // A subcategory must point at a FUNCTIONAL domain — a brand or another
    // subcategory cannot be its parent.
    if (kindValue === "subcategory") {
      if (!parentId || !(await assertOwnableCategory(Number(parentId)))) {
        res.status(400).json({ error: "التخصص الفرعي يجب أن يتبع مجالًا وظيفيًا صالحًا" });
        return;
      }
    }
    const [existing] = await db
      .select({ id: itemCategoriesTable.id })
      .from(itemCategoriesTable)
      .where(eq(itemCategoriesTable.name, trimmed))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: "التصنيف موجود بالفعل" });
      return;
    }
    const [row] = await db
      .insert(itemCategoriesTable)
      .values({
        name: trimmed,
        code: code?.trim() || null,
        sortOrder: Number.isFinite(sortOrder) ? Number(sortOrder) : 0,
        kind: kindValue,
        parentId: kindValue === "subcategory" ? Number(parentId) : null,
      })
      .returning();
    const added = await saveAliases(row.id, aliases);
    await db.insert(auditLogTable).values({
      action: "item_category.created",
      entityType: "item_category",
      entityId: row.id,
      employeeId: req.session.employeeId,
      description: `Item category created: ${row.name} (${kindValue})`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });
    res.status(201).json(serializeCategory(row, added));
  },
);

router.patch(
  "/item-categories/:id",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    const { name, code, isActive, sortOrder, kind, parentId, aliases } = req.body as {
      name?: string;
      code?: string | null;
      isActive?: boolean;
      sortOrder?: number;
      kind?: string | null;
      parentId?: number | null;
      aliases?: string[];
    };

    const updates: Record<string, unknown> = {};
    if (name !== undefined) {
      if (!name.trim()) {
        res.status(400).json({ error: "اسم التصنيف مطلوب" });
        return;
      }
      updates.name = name.trim();
    }
    if (code !== undefined) updates.code = code?.trim() || null;
    if (isActive !== undefined) updates.isActive = !!isActive;
    if (sortOrder !== undefined) updates.sortOrder = Number(sortOrder) || 0;
    if (kind !== undefined) {
      const kindValue = kind?.trim() || "functional";
      if (!CATEGORY_KINDS.has(kindValue)) {
        res.status(400).json({ error: "نوع التصنيف غير صالح (functional/subcategory/brand)" });
        return;
      }
      updates.kind = kindValue;
    }
    if (parentId !== undefined) {
      if (parentId != null && !(await assertOwnableCategory(Number(parentId)))) {
        res.status(400).json({ error: "المجال الأب يجب أن يكون تصنيفًا وظيفيًا" });
        return;
      }
      updates.parentId = parentId == null ? null : Number(parentId);
    }

    const [row] = await db
      .update(itemCategoriesTable)
      .set(updates)
      .where(eq(itemCategoriesTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // A subcategory must always resolve to a domain; keep the invariant even
    // when only the kind changed.
    if (row.kind === "subcategory" && row.parentId == null) {
      res.status(400).json({ error: "التخصص الفرعي يجب أن يتبع مجالًا وظيفيًا" });
      return;
    }
    const added =
      aliases !== undefined
        ? await saveAliases(id, aliases)
        : ((await loadAliases()).get(id) ?? []);
    res.json(serializeCategory(row, added));
  },
);

/**
 * Replace a category's aliases (idempotent). Normalised and de-duplicated; a
 * name already used by ANOTHER category is skipped so the unique index is never
 * violated and two categories can never claim one spelling.
 */
async function saveAliases(categoryId: number, raw: unknown): Promise<string[]> {
  if (!Array.isArray(raw)) return (await loadAliases()).get(categoryId) ?? [];
  const wanted = [
    ...new Set(raw.map((a) => (typeof a === "string" ? a.trim() : "")).filter(Boolean)),
  ];
  await db
    .delete(itemCategoryAliasesTable)
    .where(eq(itemCategoryAliasesTable.categoryId, categoryId));
  if (wanted.length === 0) return [];
  await db
    .insert(itemCategoryAliasesTable)
    .values(wanted.map((alias) => ({ categoryId, alias })))
    .onConflictDoNothing();
  return (await loadAliases()).get(categoryId) ?? [];
}

router.delete("/item-categories/:id", requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const [row] = await db
    .select({ id: itemCategoriesTable.id })
    .from(itemCategoriesTable)
    .where(eq(itemCategoriesTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // employee_categories cascade-delete; rfq_item_assignments.category_id is
  // ON DELETE SET NULL, so an item's assignment survives as "unclassified".
  await db.delete(itemCategoriesTable).where(eq(itemCategoriesTable.id, id));
  res.status(204).end();
});

// ── Owners of a category ────────────────────────────────────────────────────
router.get("/item-categories/:id/owners", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const rows = await db
    .select({
      employeeId: employeeCategoriesTable.employeeId,
      isPrimary: employeeCategoriesTable.isPrimary,
      name: employeesTable.name,
    })
    .from(employeeCategoriesTable)
    .innerJoin(employeesTable, eq(employeeCategoriesTable.employeeId, employeesTable.id))
    .where(eq(employeeCategoriesTable.categoryId, id));
  res.json(rows);
});

router.put(
  "/item-categories/:id/owners",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const categoryId = parseInt(req.params.id as string, 10);
    const { owners } = req.body as {
      owners?: Array<{ employeeId: number; isPrimary?: boolean }>;
    };
    if (!Array.isArray(owners)) {
      res.status(400).json({ error: "owners must be an array" });
      return;
    }
    // Only a FUNCTIONAL domain carries responsibility. Assigning an owner to a
    // subcategory or a brand is refused — a brand must never own an item.
    if (owners.length > 0 && !(await assertOwnableCategory(categoryId))) {
      res.status(400).json({ error: "لا يمكن إسناد مسؤول إلا لمجال وظيفي" });
      return;
    }
    // Exactly one primary owner, at most.
    if (!assertAtMostOnePrimary(owners)) {
      res.status(400).json({ error: PRIMARY_CONFLICT_MESSAGE });
      return;
    }

    try {
      await db.transaction(async (tx) => {
        await tx
          .delete(employeeCategoriesTable)
          .where(eq(employeeCategoriesTable.categoryId, categoryId));
        if (owners.length > 0) {
          await tx.insert(employeeCategoriesTable).values(
            owners.map((o) => ({
              categoryId,
              employeeId: o.employeeId,
              isPrimary: !!o.isPrimary,
            })),
          );
        }
      });
    } catch (err) {
      // The DB partial unique index is the real guard (the payload check above is
      // only a convenience). Surface a clean 400 instead of a 500.
      if (isUniqueViolation(err)) {
        res.status(400).json({ error: PRIMARY_CONFLICT_MESSAGE });
        return;
      }
      throw err;
    }

    await db.insert(auditLogTable).values({
      action: "item_category.owners_updated",
      entityType: "item_category",
      entityId: categoryId,
      employeeId: req.session.employeeId,
      description: `Category ${categoryId} owners set to ${owners.map((o) => o.employeeId).join(",") || "(none)"}`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    res.json({ ok: true, count: owners.length });
  },
);

// ── Categories owned by an employee ─────────────────────────────────────────
router.get("/employees/:id/categories", requireAuth, async (req, res): Promise<void> => {
  const employeeId = parseInt(req.params.id as string, 10);
  const rows = await db
    .select({
      categoryId: employeeCategoriesTable.categoryId,
      isPrimary: employeeCategoriesTable.isPrimary,
      name: itemCategoriesTable.name,
    })
    .from(employeeCategoriesTable)
    .innerJoin(itemCategoriesTable, eq(employeeCategoriesTable.categoryId, itemCategoriesTable.id))
    .where(eq(employeeCategoriesTable.employeeId, employeeId));
  res.json(rows);
});

/**
 * GET /employees/categories — every employee's owned categories in ONE request.
 * The employees table renders each row's specializations; calling the per-employee
 * endpoint for every row would be an N+1 on a page that lists the whole team.
 * Declared BEFORE `/employees/:id/categories` is irrelevant (different segment
 * count), but keep it adjacent so the pair is obvious.
 */
router.get("/employees/categories", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      employeeId: employeeCategoriesTable.employeeId,
      categoryId: employeeCategoriesTable.categoryId,
      isPrimary: employeeCategoriesTable.isPrimary,
      name: itemCategoriesTable.name,
    })
    .from(employeeCategoriesTable)
    .innerJoin(itemCategoriesTable, eq(employeeCategoriesTable.categoryId, itemCategoriesTable.id));
  const byEmployee: Record<
    number,
    Array<{ categoryId: number; name: string; isPrimary: boolean }>
  > = {};
  for (const r of rows) {
    (byEmployee[r.employeeId] ??= []).push({
      categoryId: r.categoryId,
      name: r.name,
      isPrimary: !!r.isPrimary,
    });
  }
  res.json(byEmployee);
});

router.put(
  "/employees/:id/categories",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const employeeId = parseInt(req.params.id as string, 10);
    const { categories } = req.body as {
      categories?: Array<{ categoryId: number; isPrimary?: boolean }>;
    };
    if (!Array.isArray(categories)) {
      res.status(400).json({ error: "categories must be an array" });
      return;
    }
    // Only FUNCTIONAL domains may be owned: an employee's specialisation list
    // must not contain a subcategory or a brand (a brand never owns work).
    if (categories.length > 0) {
      const ids = [...new Set(categories.map((c) => Number(c.categoryId)).filter(Number.isFinite))];
      const rows = ids.length
        ? await db
            .select({ id: itemCategoriesTable.id, kind: itemCategoriesTable.kind })
            .from(itemCategoriesTable)
            .where(inArray(itemCategoriesTable.id, ids))
        : [];
      const functional = new Set(
        rows.filter((r) => (r.kind ?? "functional") === "functional").map((r) => r.id),
      );
      if (ids.some((id) => !functional.has(id))) {
        res.status(400).json({ error: "لا يمكن إسناد اختصاص إلا لمجال وظيفي" });
        return;
      }
    }
    // At most one primary for this employee's own list. The cross-employee
    // "one primary per CATEGORY" rule is enforced by the DB index below — this
    // payload check only catches the obvious in-request case.
    if (!assertAtMostOnePrimary(categories)) {
      res.status(400).json({ error: PRIMARY_CONFLICT_MESSAGE });
      return;
    }

    try {
      await db.transaction(async (tx) => {
        await tx
          .delete(employeeCategoriesTable)
          .where(eq(employeeCategoriesTable.employeeId, employeeId));
        if (categories.length > 0) {
          await tx.insert(employeeCategoriesTable).values(
            categories.map((c) => ({
              employeeId,
              categoryId: c.categoryId,
              isPrimary: !!c.isPrimary,
            })),
          );
        }
      });
    } catch (err) {
      // A second primary for a category already owned by another employee is
      // rejected by the partial unique index — report it as a clear 400 rather
      // than an opaque 500.
      if (isUniqueViolation(err)) {
        res.status(400).json({ error: PRIMARY_CONFLICT_MESSAGE });
        return;
      }
      throw err;
    }

    await db.insert(auditLogTable).values({
      action: "employee.categories_updated",
      entityType: "employee",
      entityId: employeeId,
      employeeId: req.session.employeeId,
      description: `Employee ${employeeId} categories set to ${categories.map((c) => c.categoryId).join(",") || "(none)"}`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    res.json({ ok: true, count: categories.length });
  },
);

export default router;
