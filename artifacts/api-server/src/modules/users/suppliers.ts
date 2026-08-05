import { Router } from "express";
import {
  db,
  suppliersTable,
  sentLogTable,
  offersTable,
  offerItemsTable,
  purchaseOrderItemsTable,
  purchaseOrdersTable,
  rfqTable,
} from "@workspace/db";
import { eq, ilike, or, and, ne, count, sql, avg, inArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";

const router = Router();

function toArray(cat: string | null | undefined): string[] {
  if (!cat) return [];
  return cat
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function toStored(cats: string | string[]): string {
  if (Array.isArray(cats))
    return cats
      .map((s) => s.trim())
      .filter(Boolean)
      .join(",");
  return String(cats).trim();
}

// ─── حساب تقييم المورد ─────────────────────────────────────────────────────
async function computeSupplierScore(supplierId: number) {
  // ── 1. سرعة الرد ───────────────────────────────────────────────────────────
  // متوسط الساعات من إرسال الطلب حتى تقديم العرض
  const responseTimeRows = await db.execute(sql`
      SELECT EXTRACT(EPOCH FROM (o.created_at - sl.created_at)) / 3600 AS hours
      FROM offers o
      JOIN sent_log sl ON o.sent_log_id = sl.id
      WHERE o.supplier_id = ${supplierId}
        AND sl.created_at IS NOT NULL
        AND o.sent_log_id IS NOT NULL
    `);
  const responseTimes = (responseTimeRows.rows as { hours: string }[])
    .map((r) => parseFloat(r.hours))
    .filter((h) => h >= 0 && h < 8760); // استثناء القيم الشاذة (> سنة)

  const avgResponseHours =
    responseTimes.length > 0
      ? Math.round((responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) * 10) / 10
      : null;

  // تحويل سرعة الرد إلى score (0-100) — كلما كان أسرع كان أفضل
  let responseSpeedScore = 50; // افتراضي لو مفيش بيانات
  if (avgResponseHours !== null) {
    if (avgResponseHours < 4) responseSpeedScore = 100;
    else if (avgResponseHours < 8) responseSpeedScore = 90;
    else if (avgResponseHours < 24) responseSpeedScore = 75;
    else if (avgResponseHours < 48) responseSpeedScore = 60;
    else if (avgResponseHours < 72) responseSpeedScore = 45;
    else if (avgResponseHours < 168) responseSpeedScore = 30;
    else responseSpeedScore = 15;
  }

  // ── 2. الالتزام (نسبة الاستجابة) ────────────────────────────────────────────
  const [sentStats] = await db
    .select({ total: count() })
    .from(sentLogTable)
    .where(eq(sentLogTable.supplierId, supplierId));
  const [offerStats] = await db
    .select({ total: count() })
    .from(offersTable)
    .where(eq(offersTable.supplierId, supplierId));

  const totalRfqsReceived = Number(sentStats?.total ?? 0);
  const totalOffersSubmitted = Number(offerStats?.total ?? 0);
  const responseRate =
    totalRfqsReceived > 0 ? Math.round((totalOffersSubmitted / totalRfqsReceived) * 1000) / 10 : 0;
  const commitmentScore = Math.min(Math.round(responseRate), 100);

  // ── 3. السعر (مقارنة بمتوسط السوق) ─────────────────────────────────────────
  // لكل بند قدّم عليه المورد عرض، نقارن سعره بمتوسط سعر كل الموردين على نفس البند
  const priceDeviationRows = await db.execute(sql`
      SELECT
        AVG(
          CASE WHEN market.avg_price > 0
               THEN (oi.price::numeric - market.avg_price) / market.avg_price * 100
               ELSE 0
          END
        ) AS avg_delta
      FROM offer_items oi
      JOIN offers o ON oi.offer_id = o.id
      JOIN (
        SELECT oi2.rfq_item_id,
               AVG(oi2.price::numeric) AS avg_price
        FROM offer_items oi2
        JOIN offers o2 ON oi2.offer_id = o2.id
        GROUP BY oi2.rfq_item_id
      ) market ON market.rfq_item_id = oi.rfq_item_id
      WHERE o.supplier_id = ${supplierId}
    `);
  const avgPriceDelta = priceDeviationRows.rows[0]
    ? parseFloat((priceDeviationRows.rows[0] as { avg_delta: string }).avg_delta ?? "0") || 0
    : 0;
  const roundedDelta = Math.round(avgPriceDelta * 10) / 10;

  // تحويل الفارق السعري إلى score (كلما كان أرخص كان أفضل)
  // -20% أو أقل = 100، 0% = 70، +20% أو أكثر = 40
  let priceScore: number;
  if (roundedDelta <= -20) priceScore = 100;
  else if (roundedDelta <= 0) priceScore = Math.round(70 + (Math.abs(roundedDelta) / 20) * 30);
  else if (roundedDelta <= 20) priceScore = Math.round(70 - (roundedDelta / 20) * 30);
  else priceScore = 40;
  priceScore = Math.max(0, Math.min(100, priceScore));

  // ── 4. عدد مرات الفوز والرفض ────────────────────────────────────────────────
  // الفوز: عدد بنود أوامر الشراء المرتبطة بهذا المورد
  const [winsRow] = await db
    .select({ cnt: count() })
    .from(purchaseOrderItemsTable)
    .where(eq(purchaseOrderItemsTable.supplierId, supplierId));
  const wins = Number(winsRow?.cnt ?? 0);

  // الرفض: عدد الـ RFQs اللي قدّم فيها عرض بس ما اتاخدش منه أي بند في PO
  const rejectionRows = await db.execute(sql`
      SELECT COUNT(DISTINCT o.rfq_id) AS rejections
      FROM offers o
      WHERE o.supplier_id = ${supplierId}
        AND o.rfq_id IN (
          SELECT DISTINCT poi.po_id
          FROM purchase_order_items poi
          WHERE poi.supplier_id IS NOT NULL
        )
        AND o.rfq_id NOT IN (
          SELECT DISTINCT poi2.po_id
          FROM purchase_order_items poi2
          WHERE poi2.supplier_id = ${supplierId}
        )
    `);
  const rejections = parseInt(
    String((rejectionRows.rows[0] as { rejections: string })?.rejections ?? "0"),
    10,
  );

  // ── 5. جودة المنتج (نسبة الفوز من العروض المقدمة) ──────────────────────────
  // نسبة البنود الفائزة من إجمالي البنود المعروضة
  const [itemsOfferedRow] = await db
    .select({ cnt: count() })
    .from(offerItemsTable)
    .leftJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
    .where(eq(offersTable.supplierId, supplierId));
  const totalItemsOffered = Number(itemsOfferedRow?.cnt ?? 0);

  const qualityScore =
    totalItemsOffered > 0
      ? Math.min(100, Math.round((wins / totalItemsOffered) * 100 * 1.5)) // تضخيم خفيف لأن win rate عادةً منخفض
      : 50;

  // ── 6. متوسط مدة التوريد ────────────────────────────────────────────────────
  const [deliveryRow] = await db
    .select({ avg: avg(offerItemsTable.deliveryDays) })
    .from(offerItemsTable)
    .leftJoin(offersTable, eq(offerItemsTable.offerId, offersTable.id))
    .where(eq(offersTable.supplierId, supplierId));
  const avgDeliveryDays = deliveryRow?.avg ? Math.round(parseFloat(String(deliveryRow.avg))) : null;

  // نسبة التأخير: لا يوجد تاريخ فعلي للتسليم، نستخدم متوسط أيام التوريد كمؤشر
  // (كلما كانت أيام التوريد أقل، كانت النسبة أفضل)
  let deliveryScore = 70; // افتراضي
  if (avgDeliveryDays !== null) {
    if (avgDeliveryDays <= 7) deliveryScore = 100;
    else if (avgDeliveryDays <= 14) deliveryScore = 85;
    else if (avgDeliveryDays <= 30) deliveryScore = 70;
    else if (avgDeliveryDays <= 60) deliveryScore = 55;
    else deliveryScore = 35;
  }

  // ── 7. الدرجة الإجمالية والتقييم بالنجوم ───────────────────────────────────
  // الأوزان: سرعة الرد 20% | الالتزام 25% | السعر 25% | الجودة 15% | مدة التوريد 15%
  const totalScore = Math.round(
    responseSpeedScore * 0.2 +
      commitmentScore * 0.25 +
      priceScore * 0.25 +
      qualityScore * 0.15 +
      deliveryScore * 0.15,
  );

  // تحويل إلى تقييم 5 نجوم (مع ضمان حد أدنى 1.0 لو عنده أي نشاط)
  const rawRating = (totalScore / 100) * 5;
  const rating = totalRfqsReceived > 0 ? Math.round(Math.max(1.0, rawRating) * 10) / 10 : 0;

  return {
    totalRfqsReceived,
    totalOffersSubmitted,
    responseRate,
    avgResponseHours,
    responseSpeedScore,
    commitmentScore,
    priceScore,
    qualityScore,
    avgPriceDelta: roundedDelta,
    wins,
    rejections,
    avgDeliveryDays,
    deliveryScore,
    totalScore,
    rating,
  };
}

// ─── Routes ────────────────────────────────────────────────────────────────

// ─── Bulk Import ───────────────────────────────────────────────────────────
router.post("/suppliers/bulk", requireAuth, async (req, res): Promise<void> => {
  const { suppliers } = req.body as { suppliers?: unknown[] };

  if (!Array.isArray(suppliers) || suppliers.length === 0) {
    res.status(400).json({ error: "suppliers array required" });
    return;
  }

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  const details: Array<{
    row: number;
    name: string;
    status: "imported" | "skipped" | "error";
    reason: string | null;
    supplier?: Record<string, unknown>;
  }> = [];

  for (let i = 0; i < suppliers.length; i++) {
    const row = suppliers[i] as Record<string, unknown>;
    const name = String(row.name ?? "").trim();
    const rawCats = row.categories ?? row.category;
    const category = rawCats ? toStored(rawCats as string | string[]) : "general";

    if (!name) {
      errors++;
      details.push({ row: i + 1, name: name || "(بدون اسم)", status: "error", reason: "الاسم مطلوب" });
      continue;
    }

    const email = row.email ? String(row.email).trim() : null;
    const phone = row.phone ? String(row.phone).trim() : null;

    // Check duplicate email
    if (email) {
      const [existingEmail] = await db
        .select()
        .from(suppliersTable)
        .where(ilike(suppliersTable.email, email))
        .limit(1);
      if (existingEmail) {
        skipped++;
        details.push({ row: i + 1, name, status: "skipped", reason: `الإيميل مسجل بالفعل للمورد: ${existingEmail.name}` });
        continue;
      }
    }

    // Check duplicate phone
    if (phone) {
      const cleaned = phone.replace(/\s+/g, "");
      const [existingPhone] = await db
        .select()
        .from(suppliersTable)
        .where(sql`replace(${suppliersTable.phone}, ' ', '') = ${cleaned}`)
        .limit(1);
      if (existingPhone) {
        skipped++;
        details.push({ row: i + 1, name, status: "skipped", reason: `رقم الهاتف مسجل بالفعل للمورد: ${existingPhone.name}` });
        continue;
      }
    }

    try {
      const [supplier] = await db
        .insert(suppliersTable)
        .values({
          supplierId: row.supplierId ? String(row.supplierId) : undefined,
          name,
          contactPerson: row.contactPerson ? String(row.contactPerson) : undefined,
          email: email || undefined,
          phone: phone || undefined,
          address: row.address ? String(row.address) : undefined,
          category,
        })
        .returning();

      imported++;
      details.push({
        row: i + 1,
        name,
        status: "imported",
        reason: null,
        supplier: {
          id: supplier.id,
          supplierId: supplier.supplierId,
          name: supplier.name,
          contactPerson: supplier.contactPerson,
          email: supplier.email,
          phone: supplier.phone,
          address: supplier.address,
          category: supplier.category,
          categories: toArray(supplier.category),
          isActive: supplier.isActive,
          createdAt: supplier.createdAt.toISOString(),
        },
      });
    } catch (err: unknown) {
      errors++;
      const msg = (err as { message?: string })?.message ?? "خطأ غير متوقع";
      details.push({ row: i + 1, name, status: "error", reason: msg });
    }
  }

  res.json({ imported, skipped, errors, details });
});

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
      ),
    );
  }
  if (search)
    conditions.push(
      or(
        ilike(suppliersTable.name, `%${search}%`),
        ilike(suppliersTable.contactPerson, `%${search}%`),
      ),
    );

  const suppliers = await db
    .select()
    .from(suppliersTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(suppliersTable.name);

  res.json(
    suppliers.map((s) => ({
      id: s.id,
      supplierId: s.supplierId,
      name: s.name,
      contactPerson: s.contactPerson,
      email: s.email,
      phone: s.phone,
      address: s.address,
      category: s.category,
      categories: toArray(s.category),
      isActive: s.isActive,
      createdAt: s.createdAt.toISOString(),
    })),
  );
});

// قائمة تقييمات جميع الموردين دفعة واحدة
router.get("/suppliers/scores", requireAuth, async (req, res): Promise<void> => {
  const suppliers = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.isActive, true))
    .orderBy(suppliersTable.name);

  const scores = await Promise.all(
    suppliers.map(async (s) => {
      const score = await computeSupplierScore(s.id);
      return { supplierId: s.id, supplierName: s.name, ...score };
    }),
  );

  // ترتيب حسب التقييم تنازلياً
  scores.sort((a, b) => b.rating - a.rating);
  res.json(scores);
});

// Any authenticated employee can add a supplier
router.post("/suppliers", requireAuth, async (req, res): Promise<void> => {
  const { supplierId, name, contactPerson, email, phone, address } = req.body as Record<
    string,
    string
  >;
  const rawCats = req.body.categories ?? req.body.category;
  const category = toStored(rawCats || "general");

  if (!name || !category) {
    res.status(400).json({ error: "Name and category required" });
    return;
  }

  if (email && email.trim()) {
    const [existing] = await db
      .select()
      .from(suppliersTable)
      .where(ilike(suppliersTable.email, email.trim()))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: `هذا الإيميل مسجل بالفعل للمورد: ${existing.name}` });
      return;
    }
  }

  if (phone && phone.trim()) {
    const cleaned = phone.trim().replace(/\s+/g, "");
    const [existing] = await db
      .select()
      .from(suppliersTable)
      .where(sql`replace(${suppliersTable.phone}, ' ', '') = ${cleaned}`)
      .limit(1);
    if (existing) {
      res.status(409).json({ error: `رقم الهاتف مسجل بالفعل للمورد: ${existing.name}` });
      return;
    }
  }

  const [supplier] = await db
    .insert(suppliersTable)
    .values({
      supplierId,
      name,
      contactPerson,
      email,
      phone,
      address,
      category,
    })
    .returning();
  res.status(201).json({
    id: supplier.id,
    supplierId: supplier.supplierId,
    name: supplier.name,
    contactPerson: supplier.contactPerson,
    email: supplier.email,
    phone: supplier.phone,
    address: supplier.address,
    category: supplier.category,
    categories: toArray(supplier.category),
    isActive: supplier.isActive,
    createdAt: supplier.createdAt.toISOString(),
  });
});

router.get("/suppliers/:id", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = parseInt(raw, 10);
  const [supplier] = await db.select().from(suppliersTable).where(eq(suppliersTable.id, id));
  if (!supplier) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({
    id: supplier.id,
    supplierId: supplier.supplierId,
    name: supplier.name,
    contactPerson: supplier.contactPerson,
    email: supplier.email,
    phone: supplier.phone,
    address: supplier.address,
    category: supplier.category,
    categories: toArray(supplier.category),
    isActive: supplier.isActive,
    createdAt: supplier.createdAt.toISOString(),
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
    const [existing] = await db
      .select()
      .from(suppliersTable)
      .where(and(ilike(suppliersTable.email, emailVal), ne(suppliersTable.id, id)))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: `هذا الإيميل مسجل بالفعل للمورد: ${existing.name}` });
      return;
    }
  }

  if (updates.phone && String(updates.phone).trim()) {
    const cleaned = String(updates.phone).trim().replace(/\s+/g, "");
    const [existing] = await db
      .select()
      .from(suppliersTable)
      .where(
        and(sql`replace(${suppliersTable.phone}, ' ', '') = ${cleaned}`, ne(suppliersTable.id, id)),
      )
      .limit(1);
    if (existing) {
      res.status(409).json({ error: `رقم الهاتف مسجل بالفعل للمورد: ${existing.name}` });
      return;
    }
  }

  const [supplier] = await db
    .update(suppliersTable)
    .set(updates)
    .where(eq(suppliersTable.id, id))
    .returning();
  if (!supplier) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({
    id: supplier.id,
    supplierId: supplier.supplierId,
    name: supplier.name,
    contactPerson: supplier.contactPerson,
    email: supplier.email,
    phone: supplier.phone,
    address: supplier.address,
    category: supplier.category,
    categories: toArray(supplier.category),
    isActive: supplier.isActive,
    createdAt: supplier.createdAt.toISOString(),
  });
});

// Only admin or manager can delete a supplier
router.delete(
  "/suppliers/:id",
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw, 10);
    try {
      const [deleted] = await db
        .delete(suppliersTable)
        .where(eq(suppliersTable.id, id))
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
            "لا يمكن حذف هذا المورد لوجود طلبات عروض أسعار أو عروض سعر مرتبطة به. يمكنك تعطيله بدلاً من حذفه.",
        });
        return;
      }
      throw err;
    }
  },
);

// GET /suppliers/:id/rfqs — طلبات التسعير المرسلة لهذا المورد
router.get("/suppliers/:id/rfqs", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const supplierId = parseInt(raw, 10);

  const rows = await db
    .select({
      rfqId: rfqTable.id,
      internalRfqNo: rfqTable.internalRfqNo,
      customerRfqNo: rfqTable.customerRfqNo,
      status: rfqTable.status,
      sentAt: sentLogTable.createdAt,
      rfqCreatedAt: rfqTable.createdAt,
    })
    .from(sentLogTable)
    .innerJoin(rfqTable, eq(sentLogTable.rfqId, rfqTable.id))
    .where(eq(sentLogTable.supplierId, supplierId))
    .orderBy(sql`${sentLogTable.createdAt} DESC`);

  const rfqIds = rows.map((r) => r.rfqId);
  const offerRows =
    rfqIds.length > 0
      ? await db
          .select({ rfqId: offersTable.rfqId, cnt: count() })
          .from(offersTable)
          .where(and(eq(offersTable.supplierId, supplierId), inArray(offersTable.rfqId, rfqIds)))
          .groupBy(offersTable.rfqId)
      : [];

  const offerMap = Object.fromEntries(offerRows.map((r) => [r.rfqId, Number(r.cnt)]));

  res.json(
    rows.map((r) => ({
      id: r.rfqId,
      internalRfqNo: r.internalRfqNo,
      customerRfqNo: r.customerRfqNo,
      status: r.status,
      sentAt: r.sentAt?.toISOString() ?? null,
      hasOffer: (offerMap[r.rfqId] ?? 0) > 0,
      createdAt: r.rfqCreatedAt.toISOString(),
    })),
  );
});

// GET /suppliers/:id/pos — أوامر الشراء المرتبطة بهذا المورد
router.get("/suppliers/:id/pos", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const supplierId = parseInt(raw, 10);

  const rows = await db
    .selectDistinct({
      id: purchaseOrdersTable.id,
      internalPoNo: purchaseOrdersTable.internalPoNo,
      sheetPoNo: purchaseOrdersTable.sheetPoNo,
      status: purchaseOrdersTable.status,
      createdAt: purchaseOrdersTable.createdAt,
    })
    .from(purchaseOrderItemsTable)
    .innerJoin(purchaseOrdersTable, eq(purchaseOrderItemsTable.poId, purchaseOrdersTable.id))
    .where(eq(purchaseOrderItemsTable.supplierId, supplierId))
    .orderBy(sql`${purchaseOrdersTable.createdAt} DESC`);

  const poIds = rows.map((r) => r.id);
  const itemCountRows =
    poIds.length > 0
      ? await db
          .select({ poId: purchaseOrderItemsTable.poId, cnt: count() })
          .from(purchaseOrderItemsTable)
          .where(
            and(
              eq(purchaseOrderItemsTable.supplierId, supplierId),
              inArray(purchaseOrderItemsTable.poId, poIds),
            ),
          )
          .groupBy(purchaseOrderItemsTable.poId)
      : [];

  const itemMap = Object.fromEntries(itemCountRows.map((r) => [r.poId, Number(r.cnt)]));

  res.json(
    rows.map((r) => ({
      id: r.id,
      internalPoNo: r.internalPoNo,
      sheetPoNo: r.sheetPoNo,
      status: r.status,
      itemCount: itemMap[r.id] ?? 0,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

router.get("/suppliers/:id/score", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const supplierId = parseInt(raw, 10);

  const [supplier] = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.id, supplierId));
  if (!supplier) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const score = await computeSupplierScore(supplierId);

  res.json({
    supplierId,
    supplierName: supplier.name,
    ...score,
  });
});

export default router;
