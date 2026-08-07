import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, representativesTable } from "@workspace/db";

const router = Router();

function normalizeDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}

function normalizePhone(value: string): string {
  const digits = normalizeDigits(value).trim().replace(/[\s().-]/g, "");
  return digits.startsWith("00") ? `+${digits.slice(2)}` : digits;
}

function isValidPhone(phone: string): boolean {
  return /^\+?[1-9]\d{7,14}$/.test(phone);
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isThreePartName(name: string): boolean {
  return name.split(" ").filter(Boolean).length >= 3;
}

function isAdmin(req: { session?: { employeeId?: number; role?: string } }): boolean {
  return Boolean(req.session?.employeeId && req.session.role === "admin");
}

function serializeRepresentative(rep: typeof representativesTable.$inferSelect) {
  return {
    id: rep.id,
    name: rep.name,
    phone: rep.phone,
    isActive: rep.isActive,
    createdAt: rep.createdAt.toISOString(),
    updatedAt: rep.updatedAt.toISOString(),
  };
}

router.get("/representatives", async (req, res): Promise<void> => {
  if (!req.session.employeeId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const representatives = await db
    .select()
    .from(representativesTable)
    .orderBy(representativesTable.createdAt);
  res.json(representatives.map(serializeRepresentative));
});

router.post("/representatives", async (req, res): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const name = normalizeName(String(req.body?.name ?? ""));
  const phone = normalizePhone(String(req.body?.phone ?? ""));
  if (!isThreePartName(name)) {
    res.status(400).json({ error: "برجاء إدخال الاسم ثلاثيًا على الأقل" });
    return;
  }
  if (!isValidPhone(phone)) {
    res.status(400).json({ error: "برجاء إدخال رقم هاتف صحيح بصيغة دولية ومسجل على واتساب" });
    return;
  }

  const [existing] = await db
    .select({ id: representativesTable.id })
    .from(representativesTable)
    .where(eq(representativesTable.phone, phone))
    .limit(1);
  if (existing) {
    res.status(409).json({ error: "رقم الهاتف مسجل بالفعل لمندوب آخر" });
    return;
  }

  const [representative] = await db
    .insert(representativesTable)
    .values({ name, phone })
    .returning();
  res.status(201).json(serializeRepresentative(representative));
});

router.patch("/representatives/:id", async (req, res): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "معرّف المندوب غير صحيح" });
    return;
  }

  const updates: Partial<typeof representativesTable.$inferInsert> = {};
  if (req.body?.name !== undefined) {
    const name = normalizeName(String(req.body.name));
    if (!isThreePartName(name)) {
      res.status(400).json({ error: "برجاء إدخال الاسم ثلاثيًا على الأقل" });
      return;
    }
    updates.name = name;
  }
  if (req.body?.phone !== undefined) {
    const phone = normalizePhone(String(req.body.phone));
    if (!isValidPhone(phone)) {
      res.status(400).json({ error: "برجاء إدخال رقم هاتف صحيح بصيغة دولية ومسجل على واتساب" });
      return;
    }
    const [existing] = await db
      .select({ id: representativesTable.id })
      .from(representativesTable)
      .where(eq(representativesTable.phone, phone))
      .limit(1);
    if (existing && existing.id !== id) {
      res.status(409).json({ error: "رقم الهاتف مسجل بالفعل لمندوب آخر" });
      return;
    }
    updates.phone = phone;
  }
  if (req.body?.isActive !== undefined) updates.isActive = Boolean(req.body.isActive);

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "لا توجد بيانات للتعديل" });
    return;
  }

  const [representative] = await db
    .update(representativesTable)
    .set(updates)
    .where(eq(representativesTable.id, id))
    .returning();
  if (!representative) {
    res.status(404).json({ error: "المندوب غير موجود" });
    return;
  }
  res.json(serializeRepresentative(representative));
});

router.delete("/representatives/:id", async (req, res): Promise<void> => {
  if (!isAdmin(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const id = Number.parseInt(String(req.params.id), 10);
  const [deleted] = await db
    .delete(representativesTable)
    .where(eq(representativesTable.id, id))
    .returning({ id: representativesTable.id });
  if (!deleted) {
    res.status(404).json({ error: "المندوب غير موجود" });
    return;
  }
  res.json({ ok: true });
});

export default router;
