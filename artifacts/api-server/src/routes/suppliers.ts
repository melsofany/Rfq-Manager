import { Router } from "express";
import { db, suppliersTable, sentLogTable, offersTable } from "@workspace/db";
import { eq, ilike, or, and, ne, count, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";

const router = Router();

function toArray(cat: string | null | undefined): string[] {
  if (!cat) return [];
  return cat.split(",").map((s) => s.trim()).filter(Boolean);
}

function toStored(cats: string | string[]): string {
  if (Array.isArray(cats)) return cats.map((s) => s.trim()).filter(Boolean).join(",");
  return String(cats).trim();
}

router.get("/suppliers", requireAuth, async (req, res): Promise<void> => {
  const { category, search } = req.query as Record<string, string>;

  const conditions = [];
  if (category) {
    conditions.push(
      or(
        eq(suppliersTable.category, category),
        ilike(suppliersTable.category, `${category},%`),
        ilike(suppliersTable.category, `%,${category},%`),
        ilike(suppliersTable.category, `%,${category}`),
      )
    );
  }
  if (search) conditions.push(or(
    ilike(suppliersTable.name, `%${search}%`),
    ilike(suppliersTable.contactPerson, `%${search}%`),
  ));

  const suppliers = await db.select().from(suppliersTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(suppliersTable.name);

  res.json(suppliers.map(s => ({
    id: s.id, supplierId: s.supplierId, name: s.name,
    contactPerson: s.contactPerson, email: s.email, phone: s.phone,
    address: s.address, category: s.category, categories: toArray(s.category),
    isActive: s.isActive, createdAt: s.createdAt.toISOString(),
  })));
});

// Any authenticated employee can add a supplier
router.post("/suppliers", requireAuth, async (req, res): Promise<void> => {
  const { supplierId, name, contactPerson, email, phone, address } = req.body as Record<string, string>;
  const rawCats = req.body.categories ?? req.body.category;
  const category = toStored(rawCats || "general");

  if (!name || !category) {
    res.status(400).json({ error: "Name and category required" });
    return;
  }

  if (email && email.trim()) {
    const [existing] = await db.select().from(suppliersTable)
      .where(ilike(suppliersTable.email, email.trim())).limit(1);
    if (existing) {
      res.status(409).json({ error: `هذا الإيميل مسجل بالفعل للمورد: ${existing.name}` });
      return;
    }
  }

  if (phone && phone.trim()) {
    const cleaned = phone.trim().replace(/\s+/g, "");
    const [existing] = await db.select().from(suppliersTable)
      .where(sql`replace(${suppliersTable.phone}, ' ', '') = ${cleaned}`).limit(1);
    if (existing) {
      res.status(409).json({ error: `رقم الهاتف مسجل بالفعل للمورد: ${existing.name}` });
      return;
    }
  }

  const [supplier] = await db.insert(suppliersTable).values({
    supplierId, name, contactPerson, email, phone, address, category,
  }).returning();
  res.status(201).json({
    id: supplier.id, supplierId: supplier.supplierId, name: supplier.name,
    contactPerson: supplier.contactPerson, email: supplier.email, phone: supplier.phone,
    address: supplier.address, category: supplier.category, categories: toArray(supplier.category),
    isActive: supplier.isActive, createdAt: supplier.createdAt.toISOString(),
  });
});

router.get("/suppliers/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [supplier] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, id));
  if (!supplier) { res.status(404).json({ error: "Not found" }); return; }
  res.json({
    id: supplier.id, supplierId: supplier.supplierId, name: supplier.name,
    contactPerson: supplier.contactPerson, email: supplier.email, phone: supplier.phone,
    address: supplier.address, category: supplier.category, categories: toArray(supplier.category),
    isActive: supplier.isActive, createdAt: supplier.createdAt.toISOString(),
  });
});

router.patch("/suppliers/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const updates: Record<string, unknown> = {};
  const allowed = ["name", "contactPerson", "email", "phone", "address", "isActive"];
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (req.body.categories !== undefined || req.body.category !== undefined) {
    const rawCats = req.body.categories ?? req.body.category;
    updates.category = toStored(rawCats);
  }

  if (updates.email && String(updates.email).trim()) {
    const emailVal = String(updates.email).trim();
    const [existing] = await db.select().from(suppliersTable)
      .where(and(ilike(suppliersTable.email, emailVal), ne(suppliersTable.id, id))).limit(1);
    if (existing) {
      res.status(409).json({ error: `هذا الإيميل مسجل بالفعل للمورد: ${existing.name}` });
      return;
    }
  }

  if (updates.phone && String(updates.phone).trim()) {
    const cleaned = String(updates.phone).trim().replace(/\s+/g, "");
    const [existing] = await db.select().from(suppliersTable)
      .where(and(sql`replace(${suppliersTable.phone}, ' ', '') = ${cleaned}`, ne(suppliersTable.id, id))).limit(1);
    if (existing) {
      res.status(409).json({ error: `رقم الهاتف مسجل بالفعل للمورد: ${existing.name}` });
      return;
    }
  }

  const [supplier] = await db.update(suppliersTable).set(updates).where(eq(suppliersTable.id, id)).returning();
  if (!supplier) { res.status(404).json({ error: "Not found" }); return; }
  res.json({
    id: supplier.id, supplierId: supplier.supplierId, name: supplier.name,
    contactPerson: supplier.contactPerson, email: supplier.email, phone: supplier.phone,
    address: supplier.address, category: supplier.category, categories: toArray(supplier.category),
    isActive: supplier.isActive, createdAt: supplier.createdAt.toISOString(),
  });
});

// Only admin or manager can delete a supplier
router.delete("/suppliers/:id", requireRole("admin", "manager"), async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [deleted] = await db.delete(suppliersTable).where(eq(suppliersTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "Not found" }); return; }
  res.status(204).end();
});

router.get("/suppliers/:id/score", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const supplierId = parseInt(raw, 10);

  const [supplier] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, supplierId));
  if (!supplier) { res.status(404).json({ error: "Not found" }); return; }

  const [sentStats] = await db.select({ total: count() })
    .from(sentLogTable).where(eq(sentLogTable.supplierId, supplierId));

  const [offerStats] = await db.select({ total: count() })
    .from(offersTable).where(eq(offersTable.supplierId, supplierId));

  const totalSent = sentStats?.total ?? 0;
  const totalOffers = offerStats?.total ?? 0;
  const responseRate = totalSent > 0 ? (totalOffers / totalSent) * 100 : 0;
  const responseRateScore = Math.min(responseRate, 100);
  const priceScore = 70;
  const onTimeScore = 80;
  const qualityScore = 75;
  const totalScore = (responseRateScore * 0.3 + priceScore * 0.4 + onTimeScore * 0.2 + qualityScore * 0.1);

  res.json({
    supplierId,
    supplierName: supplier.name,
    totalScore: Math.round(totalScore),
    onTimeScore,
    priceScore,
    responseRateScore: Math.round(responseRateScore),
    qualityScore,
    totalRfqsReceived: totalSent,
    totalOffersSubmitted: totalOffers,
    responseRate: Math.round(responseRate * 10) / 10,
    avgPriceDelta: 0,
  });
});

export default router;
