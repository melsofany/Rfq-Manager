import { Router } from "express";
import { db } from "@workspace/db";
import {
  supplierCategoriesTable,
  supplierCategoryLinksTable,
  itemCategoriesTable,
} from "@workspace/db";
import { eq, asc, count, or, ilike, and, isNotNull } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { rewriteSupplierCategoryName } from "../../shared/category-rename";

const router = Router();

router.get("/categories", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(supplierCategoriesTable)
    .orderBy(asc(supplierCategoriesTable.name));
  res.json(rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parentId ?? null })));
});

router.post("/categories", async (req, res): Promise<void> => {
  const { name, parentId } = req.body as { name?: string; parentId?: number | null };
  if (!name?.trim()) {
    res.status(400).json({ error: "Name required" });
    return;
  }

  const pId = parentId ? Number(parentId) : null;
  if (pId) {
    const [parent] = await db
      .select()
      .from(supplierCategoriesTable)
      .where(eq(supplierCategoriesTable.id, pId));
    if (!parent) {
      res.status(400).json({ error: "Parent category not found" });
      return;
    }
  }

  const existing = await db
    .select()
    .from(supplierCategoriesTable)
    .where(eq(supplierCategoriesTable.name, name.trim()));
  if (existing.length > 0) {
    res.status(409).json({ error: "Category already exists" });
    return;
  }

  const [row] = await db
    .insert(supplierCategoriesTable)
    .values({ name: name.trim(), parentId: pId })
    .returning();
  // Mirror into the item categories ONLY when the name is already a CANONICAL
  // item category (it carries a code). A free-text supplier-category spelling
  // must never create a junk functional domain that classifies no item and owns
  // no responsibility — the class of orphan the operator reported
  // (`plumbing_sanitary_supplier` …). Best-effort: a mirror failure must never
  // fail the supplier-category create.
  try {
    const canonical = await db
      .select({ id: itemCategoriesTable.id })
      .from(itemCategoriesTable)
      .where(and(eq(itemCategoriesTable.name, row.name), isNotNull(itemCategoriesTable.code)))
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
  res.status(201).json({ id: row.id, name: row.name, parentId: row.parentId ?? null });
});

router.patch("/categories/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const { name, parentId } = req.body as { name?: string; parentId?: number | null };

  const [current] = await db
    .select()
    .from(supplierCategoriesTable)
    .where(eq(supplierCategoriesTable.id, id));
  if (!current) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const newName = name !== undefined ? name.trim() : current.name;
  if (!newName) {
    res.status(400).json({ error: "Name required" });
    return;
  }

  const pId = parentId !== undefined ? (parentId ? Number(parentId) : null) : current.parentId;
  if (pId === id) {
    res.status(400).json({ error: "Category cannot be its own parent" });
    return;
  }
  if (pId) {
    // check circular reference
    let curr: number | null = pId;
    while (curr) {
      if (curr === id) {
        res.status(400).json({ error: "Circular parent reference not allowed" });
        return;
      }
      const [par] = await db
        .select({ parentId: supplierCategoriesTable.parentId })
        .from(supplierCategoriesTable)
        .where(eq(supplierCategoriesTable.id, curr));
      if (!par) break;
      curr = par.parentId ?? null;
    }
  }

  const existing = await db
    .select()
    .from(supplierCategoriesTable)
    .where(eq(supplierCategoriesTable.name, newName));
  if (existing.length > 0 && existing[0].id !== id) {
    res.status(409).json({ error: "Category already exists" });
    return;
  }

  const [row] = await db
    .update(supplierCategoriesTable)
    .set({ name: newName, parentId: pId })
    .where(eq(supplierCategoriesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
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
  res.json({ id: row.id, name: row.name, parentId: row.parentId ?? null });
});

router.delete("/categories/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);

  const [category] = await db
    .select()
    .from(supplierCategoriesTable)
    .where(eq(supplierCategoriesTable.id, id));
  if (!category) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  // Check if category has subcategories
  const [{ subCount }] = await db
    .select({ subCount: count() })
    .from(supplierCategoriesTable)
    .where(eq(supplierCategoriesTable.parentId, id));
  if (subCount > 0) {
    res.status(409).json({ error: `Cannot delete: category has ${subCount} sub-category(ies)` });
    return;
  }

  // Guard via the LINK table (the authoritative relationship). The legacy text
  // is kept in step, but the link count is what decides — a supplier linked to
  // this category blocks the delete regardless of the stored spelling.
  const [{ supplierCount }] = await db
    .select({ supplierCount: count() })
    .from(supplierCategoryLinksTable)
    .where(eq(supplierCategoryLinksTable.categoryId, id));

  if (supplierCount > 0) {
    res
      .status(409)
      .json({ error: `Cannot delete: ${supplierCount} supplier(s) use this category` });
    return;
  }

  await db.delete(supplierCategoriesTable).where(eq(supplierCategoriesTable.id, id));
  res.status(204).end();
});

export default router;
