import { Router } from "express";
import { db } from "@workspace/db";
import { supplierCategoriesTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router = Router();

router.get("/categories", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(supplierCategoriesTable).orderBy(asc(supplierCategoriesTable.name));
  res.json(rows.map(r => ({ id: r.id, name: r.name })));
});

router.post("/categories", requireAuth, async (req, res): Promise<void> => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: "Name required" }); return; }
  const [row] = await db.insert(supplierCategoriesTable).values({ name: name.trim() }).returning();
  res.status(201).json({ id: row.id, name: row.name });
});

router.patch("/categories/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: "Name required" }); return; }
  const [row] = await db.update(supplierCategoriesTable).set({ name: name.trim() }).where(eq(supplierCategoriesTable.id, id)).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ id: row.id, name: row.name });
});

router.delete("/categories/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const [deleted] = await db.delete(supplierCategoriesTable).where(eq(supplierCategoriesTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "Not found" }); return; }
  res.status(204).end();
});

export default router;
