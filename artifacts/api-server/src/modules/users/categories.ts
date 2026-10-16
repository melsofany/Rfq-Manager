import { Router } from "express";
import { db } from "@workspace/db";
import {
  supplierCategoriesTable,
  supplierCategoryLinksTable,
  itemCategoriesTable,
} from "@workspace/db";
import { eq, asc, count, or, ilike, and, isNotNull } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { rewriteSupplierCategoryName } from "../../shared/category-rename";

const router = Router();

router.get("/categories", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(supplierCategoriesTable)
    .orderBy(asc(supplierCategoriesTable.name));
  res.json(rows.map((r) => ({ id: r.id, name: r.name })));
});

router.post("/categories", requireRole("admin"), async (req, res): Promise<void> => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: "Name required" });
    return;
  }

  const existing = await db
    .select()
    .from(supplierCategoriesTable)
    .where(eq(supplierCategoriesTable.name, name.trim()));
  if (existing.length > 0) {
    res.status(409).json({ error: "Category already exists" });
    return;
  }

  const [row] = await db.insert(supplierCategoriesTable).values({ name: name.trim() }).returning();
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
  res.status(201).json({ id: row.id, name: row.name });
});

router.patch("/categories/:id", requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const { name } = req.body as { name?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: "Name required" });
    return;
  }

  const [current] = await db
    .select()
    .from(supplierCategoriesTable)
    .where(eq(supplierCategoriesTable.id, id));
  if (!current) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const existing = await db
    .select()
    .from(supplierCategoriesTable)
    .where(eq(supplierCategoriesTable.name, name.trim()));
  if (existing.length > 0 && existing[0].id !== id) {
    res.status(409).json({ error: "Category already exists" });
    return;
  }

  const [row] = await db
    .update(supplierCategoriesTable)
    .set({ name: name.trim() })
    .where(eq(supplierCategoriesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Keep the item categories in step with the supplier categories (the SAME
  // list). The OLD name is the key — a rename moves the item category too.
  try {
    await db
      .update(itemCategoriesTable)
      .set({ name: row.name })
      .where(eq(itemCategoriesTable.name, current.name));
  } catch {
    // best-effort — the startup mirror in init-db.ts re-syncs on the next boot.
  }
  // `suppliers.category` stores category NAMES as free text (not an FK), so the
  // rename must also rewrite it — otherwise the supplier-list filter (which
  // matches on the NAME) finds no supplier under the new name and every supplier
  // still shows the OLD one.
  await rewriteSupplierCategoryName(current.name, row.name);
  res.json({ id: row.id, name: row.name });
});

router.delete("/categories/:id", requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);

  const [category] = await db
    .select()
    .from(supplierCategoriesTable)
    .where(eq(supplierCategoriesTable.id, id));
  if (!category) {
    res.status(404).json({ error: "Not found" });
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
