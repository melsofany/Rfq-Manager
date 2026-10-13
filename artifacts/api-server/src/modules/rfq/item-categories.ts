/**
 * Item categories + employee ownership — تصنيفات البنود واختصاص الموظفين
 *
 * Routes (behind requireAuth):
 *   GET    /item-categories                    — list (any authenticated)
 *   POST   /item-categories                    — create (admin/manager)
 *   PATCH  /item-categories/:id                — rename/toggle/order (admin/manager)
 *   DELETE /item-categories/:id                — delete (admin)
 *   GET    /item-categories/:id/owners         — who owns this category
 *   PUT    /item-categories/:id/owners         — replace owner set (admin)
 *   GET    /employees/:id/categories           — categories an employee owns
 *   PUT    /employees/:id/categories           — replace (admin)
 */
import { Router } from "express";
import {
  db,
  itemCategoriesTable,
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

/** At most one primary owner per category (0 or 1) — mirrors the DB index. */
function assertAtMostOnePrimary(items: Array<{ isPrimary?: boolean }>): boolean {
  return items.filter((o) => o.isPrimary).length <= 1;
}

function serializeCategory(c: typeof itemCategoriesTable.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    code: c.code,
    isActive: c.isActive,
    sortOrder: c.sortOrder,
  };
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
  res.json(rows.map(serializeCategory));
});

router.post(
  "/item-categories",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const { name, code, sortOrder } = req.body as {
      name?: string;
      code?: string | null;
      sortOrder?: number;
    };
    if (!name?.trim()) {
      res.status(400).json({ error: "اسم التصنيف مطلوب" });
      return;
    }
    const trimmed = name.trim();
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
      })
      .returning();
    await db.insert(auditLogTable).values({
      action: "item_category.created",
      entityType: "item_category",
      entityId: row.id,
      employeeId: req.session.employeeId,
      description: `Item category created: ${row.name}`,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });
    res.status(201).json(serializeCategory(row));
  },
);

router.patch(
  "/item-categories/:id",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    const { name, code, isActive, sortOrder } = req.body as {
      name?: string;
      code?: string | null;
      isActive?: boolean;
      sortOrder?: number;
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

    const [row] = await db
      .update(itemCategoriesTable)
      .set(updates)
      .where(eq(itemCategoriesTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(serializeCategory(row));
  },
);

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

router.put("/item-categories/:id/owners", requireRole("admin"), async (req, res): Promise<void> => {
  const categoryId = parseInt(req.params.id as string, 10);
  const { owners } = req.body as {
    owners?: Array<{ employeeId: number; isPrimary?: boolean }>;
  };
  if (!Array.isArray(owners)) {
    res.status(400).json({ error: "owners must be an array" });
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
});

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

router.put("/employees/:id/categories", requireRole("admin"), async (req, res): Promise<void> => {
  const employeeId = parseInt(req.params.id as string, 10);
  const { categories } = req.body as {
    categories?: Array<{ categoryId: number; isPrimary?: boolean }>;
  };
  if (!Array.isArray(categories)) {
    res.status(400).json({ error: "categories must be an array" });
    return;
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
});

export default router;
