import { Router } from "express";
import { db, customersTable } from "@workspace/db";
import { eq, ilike, or, and, ne, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";

const router = Router();

// ─── Routes ────────────────────────────────────────────────────────────────

// GET /customers — قائمة العملاء مع بحث اختياري
router.get("/customers", requireAuth, async (req, res): Promise<void> => {
  const { search, active } = req.query as Record<string, string>;

  const conditions = [];
  if (search)
    conditions.push(
      or(
        ilike(customersTable.name, `%${search}%`),
        ilike(customersTable.nickname, `%${search}%`),
        ilike(customersTable.phone, `%${search}%`),
        ilike(customersTable.customerId, `%${search}%`),
      ),
    );
  if (active === "true" || active === "false")
    conditions.push(eq(customersTable.isActive, active === "true"));

  const customers = await db
    .select()
    .from(customersTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(customersTable.name);

  res.json(customers.map((c) => serializeCustomer(c)));
});

// GET /customers/:id — عميل واحد
router.get("/customers/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, id));
  if (!customer) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeCustomer(customer));
});

// POST /customers — إضافة عميل
router.post("/customers", requireAuth, async (req, res): Promise<void> => {
  const { customerId, name, nickname, contactPerson, email, phone, address, taxId, notes } =
    req.body as Record<string, string>;

  if (!name || !phone || !address) {
    res.status(400).json({ error: "الاسم ورقم الهاتف والعنوان مطلوبة" });
    return;
  }

  if (email && email.trim()) {
    const [existing] = await db
      .select()
      .from(customersTable)
      .where(ilike(customersTable.email, email.trim()))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: `هذا البريد الإلكتروني مسجل بالفعل للعميل: ${existing.name}` });
      return;
    }
  }

  if (phone && phone.trim()) {
    const cleaned = phone.trim().replace(/\s+/g, "");
    const [existing] = await db
      .select()
      .from(customersTable)
      .where(sql`replace(${customersTable.phone}, ' ', '') = ${cleaned}`)
      .limit(1);
    if (existing) {
      res.status(409).json({ error: `رقم الهاتف مسجل بالفعل للعميل: ${existing.name}` });
      return;
    }
  }

  const [customer] = await db
    .insert(customersTable)
    .values({
      customerId,
      name,
      nickname,
      contactPerson,
      email,
      phone,
      address,
      taxId,
      notes,
    })
    .returning();
  res.status(201).json(serializeCustomer(customer));
});

// PATCH /customers/:id — تعديل عميل
router.patch("/customers/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const updates: Record<string, unknown> = {};
  const allowed = [
    "customerId",
    "name",
    "nickname",
    "contactPerson",
    "email",
    "phone",
    "address",
    "taxId",
    "notes",
    "isActive",
  ];
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (updates.email && String(updates.email).trim()) {
    const emailVal = String(updates.email).trim();
    const [existing] = await db
      .select()
      .from(customersTable)
      .where(and(ilike(customersTable.email, emailVal), ne(customersTable.id, id)))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: `هذا البريد الإلكتروني مسجل بالفعل للعميل: ${existing.name}` });
      return;
    }
  }

  if (updates.phone && String(updates.phone).trim()) {
    const cleaned = String(updates.phone).trim().replace(/\s+/g, "");
    const [existing] = await db
      .select()
      .from(customersTable)
      .where(
        and(sql`replace(${customersTable.phone}, ' ', '') = ${cleaned}`, ne(customersTable.id, id)),
      )
      .limit(1);
    if (existing) {
      res.status(409).json({ error: `رقم الهاتف مسجل بالفعل للعميل: ${existing.name}` });
      return;
    }
  }

  const [customer] = await db
    .update(customersTable)
    .set(updates)
    .where(eq(customersTable.id, id))
    .returning();
  if (!customer) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeCustomer(customer));
});

// DELETE /customers/:id — حذف عميل (admin/manager فقط)
router.delete(
  "/customers/:id",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw, 10);
    try {
      const [deleted] = await db
        .delete(customersTable)
        .where(eq(customersTable.id, id))
        .returning();
      if (!deleted) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.status(204).end();
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? "";
      if (msg.includes("violates foreign key constraint")) {
        res.status(409).json({
          error:
            "لا يمكن حذف هذا العميل لوجود طلبات تسعير أو أوامر شراء مرتبطة به. يمكنك تعطيله بدلاً من حذفه.",
        });
        return;
      }
      throw err;
    }
  },
);

function serializeCustomer(c: typeof customersTable.$inferSelect) {
  return {
    id: c.id,
    customerId: c.customerId,
    name: c.name,
    nickname: c.nickname,
    contactPerson: c.contactPerson,
    email: c.email,
    phone: c.phone,
    address: c.address,
    taxId: c.taxId,
    notes: c.notes,
    isActive: c.isActive,
    createdAt: c.createdAt.toISOString(),
  };
}

export default router;
