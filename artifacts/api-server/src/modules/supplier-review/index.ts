/**
 * Supplier application review — the main system's side of the supplier portal.
 *
 * The portal (a SEPARATE service and repository) writes applications into its
 * own tables in the SAME database, plus the documents that prove them. This
 * module is where an employee reads them, matches the documents against the
 * declared data, and turns an approved application into a real supplier filed
 * under his own categories.
 *
 * Why raw SQL rather than Drizzle objects: those tables belong to the portal
 * repository. Mirroring them as Drizzle tables here would create two schemas
 * that drift — the portal would add a column and this module would keep
 * selecting the old shape, silently. Raw SQL against the known columns keeps
 * the coupling explicit and visible in one file.
 *
 * Nothing here writes to the portal's tables except the approval stamp, which is
 * the ONE fact both sides must agree on.
 */
import { Router } from "express";
import { ilike, sql } from "drizzle-orm";
import { db, pool, suppliersTable } from "@workspace/db";
import { requireAuth } from "../../middlewares/auth";
import { logger } from "../../shared/logger";
import { saveSupplierCategoryLinks } from "../../shared/supplier-category-links";
import { saveSupplierItemCategoryLinks } from "../../shared/supplier-item-category-links";

const router = Router();

/** The portal's application lifecycle — mirrors its own state machine. */
type PortalStatus = "draft" | "submitted" | "under_review" | "needs_info" | "approved" | "rejected";

interface PortalApplicationRow {
  id: number;
  reference: string;
  status: PortalStatus;
  name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  commercial_register: string | null;
  tax_registration: string | null;
  bank_name: string | null;
  bank_account_holder: string | null;
  bank_account_number: string | null;
  iban: string | null;
  swift_code: string | null;
  bank_branch: string | null;
  trade_categories: string[] | null;
  item_category_ids: number[] | null;
  other_trade_category: string | null;
  supplied_items: string[] | null;
  brand_names: string[] | null;
  notes: string | null;
  verification: Record<string, string> | null;
  supplier_id: number | null;
  created_at: Date;
}

const SLOT_LABELS: Record<string, string> = {
  commercial_register: "السجل التجاري",
  tax_card: "البطاقة الضريبية",
  bank_letter: "خطاب البنك / مستند الحساب",
  previous_invoice: "فاتورة ضريبية سابقة",
  previous_work: "أعمال سابقة",
};

/** The sentinel the portal stores when the applicant chose «أخرى». */
const OTHER_SENTINEL = "__other__";

function serialize(row: PortalApplicationRow) {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    name: row.name,
    contactPerson: row.contact_person,
    email: row.email,
    phone: row.phone,
    address: row.address,
    commercialRegister: row.commercial_register,
    taxRegistration: row.tax_registration,
    bankName: row.bank_name,
    bankAccountHolder: row.bank_account_holder,
    bankAccountNumber: row.bank_account_number,
    iban: row.iban,
    swiftCode: row.swift_code,
    bankBranch: row.bank_branch,
    tradeCategories: (row.trade_categories ?? []).filter((c) => c && c !== OTHER_SENTINEL),
    itemCategoryIds: row.item_category_ids ?? [],
    otherTradeCategory: row.other_trade_category,
    suppliedItems: row.supplied_items ?? [],
    brandNames: row.brand_names ?? [],
    notes: row.notes,
    verification: row.verification ?? {},
    supplierId: row.supplier_id,
    createdAt: row.created_at.toISOString(),
  };
}

const APPLICATION_COLUMNS = `id, reference, status, name, contact_person, email, phone, address,
  commercial_register, tax_registration, bank_name, bank_account_holder,
  bank_account_number, iban, swift_code, bank_branch, trade_categories,
  item_category_ids, other_trade_category, supplied_items, brand_names,
  notes, verification, supplier_id, created_at`;

/**
 * GET /supplier-review/applications
 *
 * The queue. `q` searches name, email, phone, reference AND the applicant's own
 * item/brand text — an operator who remembers «the cable supplier» must find him
 * without knowing his company name.
 */
router.get("/supplier-review/applications", requireAuth, async (req, res): Promise<void> => {
  const status = String(req.query.status ?? "").trim();
  const q = String(req.query.q ?? "").trim();

  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    where.push(`(
      name ILIKE ${p} OR email ILIKE ${p} OR phone ILIKE ${p} OR reference ILIKE ${p}
      OR supplied_items::text ILIKE ${p} OR brand_names::text ILIKE ${p}
      OR other_trade_category ILIKE ${p}
    )`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const { rows } = await pool.query<PortalApplicationRow>(
    `SELECT ${APPLICATION_COLUMNS} FROM supplier_applications ${whereSql}
      ORDER BY created_at DESC LIMIT 200`,
    params,
  );
  const counts = await pool.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM supplier_applications GROUP BY status`,
  );

  res.json({
    applications: rows.map(serialize),
    counts: Object.fromEntries(counts.rows.map((c) => [c.status, Number(c.count)])),
  });
});

/** GET /supplier-review/applications/:id — one application with its documents. */
router.get("/supplier-review/applications/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "رقم الطلب غير صحيح" });
    return;
  }
  const { rows } = await pool.query<PortalApplicationRow>(
    `SELECT ${APPLICATION_COLUMNS} FROM supplier_applications WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "الطلب غير موجود" });
    return;
  }

  // Metadata ONLY. The bytes are fetched by the content route when the reviewer
  // actually opens a file — loading every document with the application is what
  // makes a review screen slow enough that reviewers stop using it.
  const docs = await pool.query<{
    id: number;
    slot: string;
    original_name: string;
    mime_type: string | null;
    size_bytes: number | null;
    uploaded_at: Date;
  }>(
    `SELECT id, slot, original_name, mime_type, size_bytes, uploaded_at
       FROM supplier_application_documents WHERE application_id = $1
      ORDER BY uploaded_at ASC, id ASC`,
    [id],
  );

  // Resolve the ITEM category names here: the console must show the operator
  // what he is about to file the supplier under, in words, before he approves.
  const itemIds = row.item_category_ids ?? [];
  let itemCategoryNames: Array<{ id: number; name: string }> = [];
  if (itemIds.length > 0) {
    const cats = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM item_categories WHERE id = ANY($1::int[]) ORDER BY name`,
      [itemIds],
    );
    itemCategoryNames = cats.rows;
  }

  res.json({
    application: serialize(row),
    documents: docs.rows.map((d) => ({
      id: d.id,
      slot: d.slot,
      label: SLOT_LABELS[d.slot] ?? d.slot,
      originalName: d.original_name,
      mimeType: d.mime_type,
      sizeBytes: d.size_bytes,
      uploadedAt: d.uploaded_at.toISOString(),
    })),
    itemCategoryNames,
  });
});

/** GET /supplier-review/documents/:docId — the file itself, for the viewer. */
router.get("/supplier-review/documents/:docId", requireAuth, async (req, res): Promise<void> => {
  const docId = Number(req.params.docId);
  if (!Number.isInteger(docId) || docId <= 0) {
    res.status(400).json({ error: "رقم المستند غير صحيح" });
    return;
  }
  const { rows } = await pool.query<{
    original_name: string;
    mime_type: string | null;
    content: string;
  }>(`SELECT original_name, mime_type, content FROM supplier_application_documents WHERE id = $1`, [
    docId,
  ]);
  const doc = rows[0];
  if (!doc) {
    res.status(404).json({ error: "المستند غير موجود" });
    return;
  }
  const buf = Buffer.from(doc.content, "base64");
  res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
  res.setHeader("Content-Length", String(buf.length));
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(doc.original_name)}"`,
  );
  res.send(buf);
});

/**
 * POST /supplier-review/applications/:id/verification
 *
 * Save the reviewer's per-FIELD verdicts (matched / mismatch / unchecked).
 *
 * Saved as they are made, not on approval: a reviewer interrupted mid-review
 * resumes where he stopped, and the decision that follows carries the evidence
 * it was based on. Only the three known verdicts are stored — an unknown value
 * would make the console's summary count a state it cannot render.
 */
router.post(
  "/supplier-review/applications/:id/verification",
  requireAuth,
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "رقم الطلب غير صحيح" });
      return;
    }
    const raw = (req.body ?? {}).verification as Record<string, unknown> | undefined;
    const allowed = new Set(["unchecked", "matched", "mismatch"]);
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw ?? {})) {
      if (typeof value === "string" && allowed.has(value)) clean[key] = value;
    }

    const { rowCount } = await pool.query(
      `UPDATE supplier_applications SET verification = $2::jsonb, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(clean)],
    );
    if (rowCount === 0) {
      res.status(404).json({ error: "الطلب غير موجود" });
      return;
    }
    res.json({
      verification: clean,
      mismatched: Object.entries(clean)
        .filter(([, v]) => v === "mismatch")
        .map(([k]) => k),
    });
  },
);

/** Normalise a trade name the same way the category index does. */
function canonical(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** Trade categories that have live children — the ones a supplier may not sit on. */
async function nonLeafCategoryNames(names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const lower = names.map((n) => n.toLowerCase());
  const { rows } = await pool.query<{ name: string }>(
    `SELECT DISTINCT p.name
       FROM supplier_categories p
       JOIN supplier_categories c ON c.parent_id = p.id AND c.deleted_at IS NULL
      WHERE p.deleted_at IS NULL
        AND lower(btrim(regexp_replace(p.name, '\\s+', ' ', 'g'))) = ANY($1::text[])`,
    [lower],
  );
  return rows.map((r) => r.name);
}

/**
 * POST /supplier-review/applications/:id/approve
 *
 * Create the supplier and file him under the categories he applied with.
 *
 * The row and its approval stamp commit in ONE transaction: a supplier created
 * without the application being marked would be approved twice on a retry, and
 * an application marked approved with no supplier is worse still — it claims a
 * record that does not exist.
 */
router.post(
  "/supplier-review/applications/:id/approve",
  requireAuth,
  async (req, res): Promise<void> => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "رقم الطلب غير صحيح" });
      return;
    }

    const { rows } = await pool.query<PortalApplicationRow>(
      `SELECT ${APPLICATION_COLUMNS} FROM supplier_applications WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "الطلب غير موجود" });
      return;
    }
    if (row.status === "approved") {
      res.status(409).json({
        error: `تم قبول هذا الطلب بالفعل${row.supplier_id ? ` وإنشاء المورد برقم ${row.supplier_id}` : ""}`,
        supplierId: row.supplier_id,
      });
      return;
    }
    if (row.status === "rejected") {
      res.status(409).json({ error: "الطلب مرفوض — لا يمكن قبوله" });
      return;
    }

    // The trades the supplier is filed under. The sentinel is never a category:
    // filing under «__other__» would create a real catalogue row with that name.
    const trades = (row.trade_categories ?? []).filter((c) => c && c !== OTHER_SENTINEL);
    const typedOther = (row.other_trade_category ?? "").trim();
    if (typedOther) trades.push(typedOther);
    const categories = [...new Set(trades.map(canonical).filter(Boolean))];
    if (categories.length === 0) {
      res.status(400).json({ error: "لا يوجد تصنيف تجارة لهذا الطلب" });
      return;
    }

    // A supplier is filed under a LEAF trade only. The portal enforces this too,
    // but the catalogue can change between submission and approval, so it is
    // re-checked here — approving into a parent would double-count him.
    const nonLeaf = await nonLeafCategoryNames(categories);
    if (nonLeaf.length > 0) {
      res.status(400).json({
        error: `لا يمكن إسناد المورد لتصنيف رئيسي له تصنيفات فرعية: ${nonLeaf.join("، ")} — اختر تصنيفًا فرعيًا`,
        nonLeafCategories: nonLeaf,
      });
      return;
    }

    // Duplicate guard on email, matching the hand-created path: approving a
    // supplier we already hold would create a second row for one company.
    if (row.email && row.email.trim()) {
      const existing = await db
        .select({ id: suppliersTable.id, name: suppliersTable.name })
        .from(suppliersTable)
        .where(ilike(suppliersTable.email, row.email.trim()))
        .limit(1);
      if (existing.length > 0) {
        res.status(409).json({
          error: `هذا الإيميل مسجل بالفعل للمورد: ${existing[0].name}`,
          existingSupplierId: existing[0].id,
        });
        return;
      }
    }

    let supplierId: number;
    try {
      supplierId = await db.transaction(async (tx) => {
        const [supplier] = await tx
          .insert(suppliersTable)
          .values({
            name: row.name,
            contactPerson: row.contact_person,
            email: row.email?.toLowerCase() ?? null,
            phone: row.phone,
            address: row.address,
            commercialRegister: row.commercial_register,
            taxRegistration: row.tax_registration,
            bankName: row.bank_name,
            bankAccountHolder: row.bank_account_holder,
            bankAccountNumber: row.bank_account_number,
            iban: row.iban,
            swiftCode: row.swift_code,
            bankBranch: row.bank_branch,
            category: categories.join(","),
            isActive: true,
            suppliedItems: row.supplied_items ?? [],
            brandNames: row.brand_names ?? [],
            portalApplicationId: id,
          })
          .returning({ id: suppliersTable.id });

        await tx.execute(sql`
          UPDATE supplier_applications
             SET status = 'approved', supplier_id = ${supplier.id}, updated_at = now()
           WHERE id = ${id}
        `);
        return supplier.id;
      });
    } catch (err) {
      logger.error({ err, applicationId: id }, "supplier approval failed");
      res.status(500).json({ error: "تعذّر إنشاء المورد — لم يتم حفظ أي تغيير" });
      return;
    }

    // Category links are reconciled by the SHARED helpers the hand-created path
    // uses, so a supplier from the portal and one typed by hand cannot end up
    // filed by two different rules.
    try {
      await saveSupplierCategoryLinks(supplierId, categories);
    } catch (err) {
      logger.warn({ err, supplierId }, "trade category links failed after approval");
    }
    try {
      await saveSupplierItemCategoryLinks(supplierId, row.item_category_ids ?? []);
    } catch (err) {
      logger.warn({ err, supplierId }, "item category links failed after approval");
    }

    res.json({
      ok: true,
      supplierId,
      categories,
      itemCategoryIds: row.item_category_ids ?? [],
    });
  },
);

export default router;
