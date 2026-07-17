import { Router } from "express";
import { db } from "@workspace/db";
import { supplierCategoriesTable, suppliersTable } from "@workspace/db";
import { eq, asc, count, or, ilike } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";

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
  res.status(201).json({ id: row.id, name: row.name });
});

router.patch("/categories/:id", requireRole("admin"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const { name } = req.body as { name?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: "Name required" });
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

  const [{ supplierCount }] = await db
    .select({ supplierCount: count() })
    .from(suppliersTable)
    .where(eq(suppliersTable.category, category.name));

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
