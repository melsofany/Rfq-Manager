/**
 * استكمال بيانات المورد — the supplier self-registration link.
 *
 * Why this exists: a purchase order cannot be sent to a supplier we cannot pay.
 * Before this module, dispatch simply sent the PO anyway — the supplier received
 * an order, shipped it, and only then discovered we had no bank account for him.
 * The order was unactionable and nobody found out until the invoice arrived.
 *
 * So the dispatch is now GATED on the data (see `po/routes.ts`): a supplier with
 * no bank data gets a one-time link instead of the PO, enters the data himself,
 * confirms it by entering it a second time, and only then does the PO go out.
 *
 * The rules the operator fixed, and why each is implemented where it is:
 *
 *   • The link shows the data WE HOLD, read-only, so the supplier confirms our
 *     record instead of guessing at it.
 *   • It is SINGLE-USE: after a successful confirmation the token is dead and
 *     the page says so — «لا تظهر مرة أخرى بعد ملء البيانات».
 *   • The supplier types the data TWICE; a mismatch is refused, nothing is
 *     written, and he is told so (WhatsApp + email). A silent refusal would look
 *     like a saved form.
 *   • Any later correction is the COMPANY's job — the page tells the supplier to
 *     contact us, because a second submission could silently overwrite a record
 *     an accountant has already used.
 *   • A red notice states the data is the supplier's own responsibility.
 */
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import {
  db,
  suppliersTable,
  supplierRegistrationRequestsTable,
  auditLogTable,
  whatsappChatsTable,
  SUPPLIER_REGISTRATION_STATUS,
} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { logger } from "../../shared/logger";
import { generateToken } from "../../shared/token";
import { resolvePublicBaseUrl } from "../../shared/base-url";
import { pickSendablePhone } from "../../shared/phone";
import {
  isWhatsAppConfigured,
  sendSupplierRegistrationWhatsApp,
  sendSupplierRegistrationMismatchWhatsApp,
} from "../communications/service";
import { sendSupplierRegistrationEmail, sendRegistrationMismatchEmail } from "../../shared/email";
import {
  REGISTRATION_FIELD_LABELS,
  cleanValue,
  compareRegistrationEntries,
  describeFields,
  heldDataSnapshot,
  missingRegistrationFields,
  validateRegistrationSubmission,
  type RegistrationField,
  type RegistrationValues,
} from "../../shared/supplier-registration";

const router = Router();

/** A registration link lives two weeks by default — long enough for a bank reply. */
const DEFAULT_EXPIRY_DAYS = Number(process.env.SUPPLIER_REGISTRATION_EXPIRY_DAYS) || 14;

// The link is public and unauthenticated, so it is the one surface a stranger can
// hammer. A generous per-IP ceiling stops enumeration without tripping a real
// supplier who mistypes his data a few times.
const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "محاولات كثيرة — يرجى المحاولة بعد قليل" },
});

/** The link URL a supplier is sent. Kept in one place: mail, WhatsApp and the
 * API response must all name the SAME address or one of them will 404. */
export function registrationUrlFor(
  token: string,
  req?: Parameters<typeof resolvePublicBaseUrl>[0],
) {
  return `${resolvePublicBaseUrl(req)}/s/${token}`;
}

function expiryDate(days = DEFAULT_EXPIRY_DAYS): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseValues(raw: unknown): RegistrationValues {
  if (!raw || typeof raw !== "object") return {};
  const out: RegistrationValues = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k as RegistrationField] = v == null ? null : String(v);
  }
  return out;
}

interface RequestRow {
  id: number;
  supplierId: number;
  token: string;
  status: string;
  heldData: RegistrationValues | null;
  requestedFields: RegistrationField[] | null;
  submittedData: RegistrationValues | null;
  attempts: number;
  expiresAt: Date;
  poId: number | null;
}

/**
 * Load a request and decide its live state.
 *
 * Expiry is evaluated on READ, not by a sweep: a cron that failed to run would
 * leave an expired link usable, and an expired link writes bank details. The
 * stored `status` is only ever consulted for the terminal states (`completed`,
 * `cancelled`); "expired" is derived from the clock so it cannot go stale.
 */
async function loadRequest(
  token: string,
): Promise<
  | { kind: "missing" }
  | { kind: "completed"; row: RequestRow }
  | { kind: "cancelled"; row: RequestRow }
  | { kind: "expired"; row: RequestRow }
  | { kind: "open"; row: RequestRow }
> {
  const [row] = await db
    .select()
    .from(supplierRegistrationRequestsTable)
    .where(eq(supplierRegistrationRequestsTable.token, token));
  if (!row) return { kind: "missing" };
  const r = row as unknown as RequestRow;
  if (r.status === SUPPLIER_REGISTRATION_STATUS.COMPLETED) return { kind: "completed", row: r };
  if (r.status === SUPPLIER_REGISTRATION_STATUS.CANCELLED) return { kind: "cancelled", row: r };
  if (new Date(r.expiresAt).getTime() <= Date.now()) return { kind: "expired", row: r };
  return { kind: "open", row: r };
}

/**
 * Create a registration link for a supplier and send it (WhatsApp + email).
 *
 * Reuses an OPEN request for the same supplier instead of minting a second one:
 * two live links to the same record is how a supplier ends up confirming into a
 * request the operator is not looking at. A completed request is never reused —
 * the supplier's confirmation is final.
 */
export async function createRegistrationRequest(opts: {
  supplierId: number;
  poId?: number | null;
  employeeId?: number | null;
  req?: Parameters<typeof resolvePublicBaseUrl>[0];
}): Promise<{
  requestId: number;
  token: string;
  url: string;
  reused: boolean;
  missingFields: RegistrationField[];
  whatsappSent: boolean;
  whatsappError: string | null;
  emailSent: boolean;
  emailError: string | null;
}> {
  const [supplier] = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.id, opts.supplierId));
  if (!supplier) throw new Error("المورد غير موجود");

  const missing = missingRegistrationFields(supplier);

  // Reuse a live link when there is one (re-dispatching a PO must not mint a
  // second token for the same supplier).
  const [existing] = await db
    .select()
    .from(supplierRegistrationRequestsTable)
    .where(
      and(
        eq(supplierRegistrationRequestsTable.supplierId, opts.supplierId),
        eq(supplierRegistrationRequestsTable.status, SUPPLIER_REGISTRATION_STATUS.PENDING),
      ),
    )
    .orderBy(desc(supplierRegistrationRequestsTable.id))
    .limit(1);

  let row = existing as unknown as RequestRow | undefined;
  let reused = false;
  if (row && new Date(row.expiresAt).getTime() > Date.now()) {
    reused = true;
  } else {
    const token = generateToken();
    const expires = expiryDate();
    const [created] = await db
      .insert(supplierRegistrationRequestsTable)
      .values({
        supplierId: opts.supplierId,
        token,
        status: SUPPLIER_REGISTRATION_STATUS.PENDING,
        heldData: heldDataSnapshot(supplier),
        requestedFields: missing,
        poId: opts.poId ?? null,
        createdByEmployeeId: opts.employeeId ?? null,
        expiresAt: expires,
      })
      .returning();
    row = created as unknown as RequestRow;
  }

  const url = registrationUrlFor(row.token, opts.req);
  const expiresLabel = formatDate(new Date(row.expiresAt));
  const fieldLabels = missing.map((f) => REGISTRATION_FIELD_LABELS[f]);

  let whatsappSent = false;
  let whatsappError: string | null = null;
  let emailSent = false;
  let emailError: string | null = null;

  const { phone } = pickSendablePhone(supplier.phone);
  if (phone && isWhatsAppConfigured) {
    try {
      const wamid = await sendSupplierRegistrationWhatsApp({
        phone,
        supplierName: supplier.name,
        contactPerson: supplier.contactPerson,
        token: row.token,
        requiredFields: fieldLabels,
        expiresAt: expiresLabel,
      });
      whatsappSent = Boolean(wamid);
      if (!whatsappSent) whatsappError = "WhatsApp send returned no message id";
      try {
        await db.insert(whatsappChatsTable).values({
          waMessageId: wamid ?? null,
          direction: "outbound",
          phone,
          supplierId: supplier.id,
          body: `[استكمال بيانات المورد: ${supplier.name}] ${url}`,
          isRead: true,
        });
      } catch (saveErr) {
        logger.error({ err: saveErr, supplierId: supplier.id }, "registration chat record failed");
      }
    } catch (err) {
      whatsappError = err instanceof Error ? err.message : String(err);
      logger.error({ err, supplierId: supplier.id }, "registration WhatsApp failed");
    }
  } else {
    whatsappError = !isWhatsAppConfigured ? "WhatsApp not configured" : "No phone number";
  }

  if (supplier.email?.trim()) {
    try {
      await sendSupplierRegistrationEmail({
        to: supplier.email.trim(),
        toName: supplier.contactPerson ?? supplier.name,
        supplierName: supplier.name,
        registrationUrl: url,
        missingFields: fieldLabels,
        expiresAt: expiresLabel,
        employeeName: "Cortoba Supplies",
        employeePhone: null,
      });
      emailSent = true;
    } catch (err) {
      emailError = err instanceof Error ? err.message : String(err);
      logger.error({ err, supplierId: supplier.id }, "registration email failed");
    }
  } else {
    emailError = "No email";
  }

  await db.insert(auditLogTable).values({
    action: "supplier.registration_requested",
    entityType: "supplier",
    entityId: supplier.id,
    employeeId: opts.employeeId ?? null,
    description: `طلب استكمال بيانات المورد «${supplier.name}»${reused ? " (إعادة إرسال الرابط)" : ""} — الحقول الناقصة: ${fieldLabels.join("، ") || "لا يوجد"}`,
  });

  return {
    requestId: row.id,
    token: row.token,
    url,
    reused,
    missingFields: missing,
    whatsappSent,
    whatsappError,
    emailSent,
    emailError,
  };
}

// ─── Public: the supplier-facing link ──────────────────────────────────────

/**
 * GET /api/supplier-registration/:token
 *
 * The only unauthenticated read of a supplier record. It deliberately returns
 * ONLY the fields this module already considers public to the supplier (his own
 * registration data) — never prices, orders, or another supplier's anything.
 */
router.get(
  "/supplier-registration/:token",
  registrationLimiter,
  async (req, res): Promise<void> => {
    const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
    const loaded = await loadRequest(token);

    if (loaded.kind === "missing") {
      res.status(404).json({ error: "الرابط غير صحيح" });
      return;
    }

    const [supplier] = await db
      .select({
        id: suppliersTable.id,
        name: suppliersTable.name,
        contactPerson: suppliersTable.contactPerson,
      })
      .from(suppliersTable)
      .where(eq(suppliersTable.id, loaded.row.supplierId));

    const status = loaded.kind;
    res.json({
      status,
      supplierName: supplier?.name ?? "",
      contactPerson: supplier?.contactPerson ?? null,
      // The data WE hold, shown read-only on the page.
      heldData: loaded.row.heldData ?? {},
      requestedFields: loaded.row.requestedFields ?? [],
      expiresAt: new Date(loaded.row.expiresAt).toISOString(),
      // A mismatch already happened: the page can say so before the supplier types.
      attempts: loaded.row.attempts,
      // Only the OPEN state carries the fields to fill; a completed link has no form.
      canSubmit: status === "open",
      labels: REGISTRATION_FIELD_LABELS,
    });
  },
);

/**
 * POST /api/supplier-registration/:token/submit — the FIRST entry.
 *
 * Stores the entry and returns. Nothing is written to the supplier record yet:
 * the confirmation step is what commits it, and a first entry that was never
 * confirmed must leave no trace on the supplier.
 */
router.post(
  "/supplier-registration/:token/submit",
  registrationLimiter,
  async (req, res): Promise<void> => {
    const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
    const loaded = await loadRequest(token);
    if (loaded.kind !== "open") {
      res.status(409).json({ error: registrationStatusMessage(loaded.kind), status: loaded.kind });
      return;
    }

    const required = loaded.row.requestedFields ?? [];
    const result = validateRegistrationSubmission(parseValues(req.body?.data), required);
    if (!result.ok) {
      res.status(400).json({ error: "بيانات غير صحيحة", fieldErrors: result.errors });
      return;
    }

    await db
      .update(supplierRegistrationRequestsTable)
      .set({ submittedData: result.data })
      .where(eq(supplierRegistrationRequestsTable.id, loaded.row.id));

    res.json({ ok: true, step: "confirm" });
  },
);

/**
 * POST /api/supplier-registration/:token/confirm — the SECOND entry.
 *
 * The two entries must agree. On a mismatch nothing is recorded, the supplier is
 * told (WhatsApp + email) and the request RESETS to step one so both entries are
 * typed afresh — comparing a new second entry against a first entry that was
 * itself a typo would lock the supplier out of his own data.
 */
router.post(
  "/supplier-registration/:token/confirm",
  registrationLimiter,
  async (req, res): Promise<void> => {
    const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
    const loaded = await loadRequest(token);
    if (loaded.kind !== "open") {
      res.status(409).json({ error: registrationStatusMessage(loaded.kind), status: loaded.kind });
      return;
    }

    const required = loaded.row.requestedFields ?? [];
    const first = loaded.row.submittedData;
    if (!first || Object.keys(first).length === 0) {
      res.status(400).json({ error: "لم يتم إدخال البيانات في الخطوة الأولى بعد", step: "submit" });
      return;
    }

    const result = validateRegistrationSubmission(parseValues(req.body?.data), required);
    if (!result.ok) {
      res.status(400).json({ error: "بيانات غير صحيحة", fieldErrors: result.errors });
      return;
    }

    const mismatched = compareRegistrationEntries(first, result.data, required);
    if (mismatched.length > 0) {
      await db
        .update(supplierRegistrationRequestsTable)
        .set({
          // Reset to step one: the supplier re-enters BOTH entries so a typo in
          // either is corrected rather than carried forward.
          submittedData: null,
          attempts: loaded.row.attempts + 1,
          lastMismatchAt: new Date(),
          lastMismatchFields: mismatched,
        })
        .where(eq(supplierRegistrationRequestsTable.id, loaded.row.id));

      const labels = mismatched.map((f) => REGISTRATION_FIELD_LABELS[f]);
      const [supplier] = await db
        .select()
        .from(suppliersTable)
        .where(eq(suppliersTable.id, loaded.row.supplierId));

      // Best-effort: the refusal stands whether or not the notice goes out, and
      // the page says the same thing, so the supplier is never left guessing.
      if (supplier) {
        const { phone } = pickSendablePhone(supplier.phone);
        if (phone && isWhatsAppConfigured) {
          try {
            await sendSupplierRegistrationMismatchWhatsApp({
              phone,
              supplierName: supplier.name,
              contactPerson: supplier.contactPerson,
              mismatchedFields: labels,
            });
          } catch (err) {
            logger.warn({ err, supplierId: supplier.id }, "mismatch WhatsApp notice failed");
          }
        }
        if (supplier.email?.trim()) {
          try {
            await sendRegistrationMismatchEmail({
              to: supplier.email.trim(),
              toName: supplier.contactPerson ?? supplier.name,
              supplierName: supplier.name,
              mismatchedFields: labels,
              registrationUrl: registrationUrlFor(loaded.row.token, req),
            });
          } catch (err) {
            logger.warn({ err, supplierId: supplier.id }, "mismatch email notice failed");
          }
        }
        await db.insert(auditLogTable).values({
          action: "supplier.registration_mismatch",
          entityType: "supplier",
          entityId: supplier.id,
          description: `عدم تطابق في تأكيد بيانات المورد «${supplier.name}» — الحقول: ${labels.join("، ")} (لم يتم تسجيل أي بيانات)`,
        });
      }

      res.status(409).json({
        error: "البيانات المدخلة في المرة الثانية غير مطابقة للمرة الأولى — لم يتم تسجيل البيانات",
        mismatchFields: mismatched,
        labels,
      });
      return;
    }

    // Match: commit the data to the supplier and close the link for good.
    await db
      .update(suppliersTable)
      .set({
        ...result.data,
        registrationVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(suppliersTable.id, loaded.row.supplierId));

    await db
      .update(supplierRegistrationRequestsTable)
      .set({
        status: SUPPLIER_REGISTRATION_STATUS.COMPLETED,
        confirmedData: result.data,
        completedAt: new Date(),
      })
      .where(eq(supplierRegistrationRequestsTable.id, loaded.row.id));

    await db.insert(auditLogTable).values({
      action: "supplier.registration_completed",
      entityType: "supplier",
      entityId: loaded.row.supplierId,
      description: `أكمل المورد «${loaded.row.supplierId}» بياناته بنفسه وتم تأكيدها بإدخال مزدوج مطابق`,
    });

    res.json({
      ok: true,
      status: "completed",
      message: "تم تسجيل البيانات وتأكيدها. لأي تعديل لاحق يرجى التواصل مع الشركة مباشرة.",
    });
  },
);

function registrationStatusMessage(kind: string): string {
  switch (kind) {
    case "completed":
      return "تم تسجيل بياناتك بالفعل بهذا الرابط ولا يمكن استخدامه مرة أخرى. لأي تعديل يرجى التواصل مع الشركة مباشرة.";
    case "cancelled":
      return "تم إلغاء هذا الرابط. يرجى التواصل مع الشركة.";
    case "expired":
      return "انتهت صلاحية هذا الرابط. يرجى التواصل مع الشركة لإرسال رابط جديد.";
    default:
      return "الرابط غير صحيح";
  }
}

// ─── Authenticated: the operator side ──────────────────────────────────────

/**
 * POST /api/suppliers/:id/registration-request
 * (Re)send the one-time registration link to a supplier.
 */
router.post("/suppliers/:id/registration-request", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const supplierId = parseInt(raw, 10);
  if (!Number.isFinite(supplierId)) {
    res.status(400).json({ error: "معرّف المورد غير صحيح" });
    return;
  }
  try {
    const result = await createRegistrationRequest({
      supplierId,
      employeeId: req.session.employeeId ?? null,
      req,
    });
    res.json({
      ok: true,
      reused: result.reused,
      url: result.url,
      missingFields: result.missingFields,
      labels: result.missingFields.map((f) => REGISTRATION_FIELD_LABELS[f]),
      whatsappSent: result.whatsappSent,
      whatsappError: result.whatsappError,
      emailSent: result.emailSent,
      emailError: result.emailError,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("المورد غير موجود")) {
      res.status(404).json({ error: msg });
      return;
    }
    req.log.error({ err, supplierId }, "registration request failed");
    res.status(500).json({ error: "تعذّر إرسال رابط استكمال البيانات" });
  }
});

/** GET /api/suppliers/:id/registration-requests — the link history. */
router.get("/suppliers/:id/registration-requests", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const supplierId = parseInt(raw, 10);
  const rows = await db
    .select()
    .from(supplierRegistrationRequestsTable)
    .where(eq(supplierRegistrationRequestsTable.supplierId, supplierId))
    .orderBy(desc(supplierRegistrationRequestsTable.id))
    .limit(20);
  res.json(
    rows.map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
      attempts: r.attempts,
      poId: r.poId,
    })),
  );
});

/** POST /api/supplier-registration-requests/:id/cancel — kill a live link. */
router.post(
  "/supplier-registration-requests/:id/cancel",
  requireAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw, 10);
    const [row] = await db
      .select()
      .from(supplierRegistrationRequestsTable)
      .where(eq(supplierRegistrationRequestsTable.id, id));
    if (!row) {
      res.status(404).json({ error: "الطلب غير موجود" });
      return;
    }
    if (row.status === SUPPLIER_REGISTRATION_STATUS.COMPLETED) {
      res.status(400).json({ error: "تم إكمال هذا الطلب بالفعل ولا يمكن إلغاؤه" });
      return;
    }
    await db
      .update(supplierRegistrationRequestsTable)
      .set({ status: SUPPLIER_REGISTRATION_STATUS.CANCELLED })
      .where(eq(supplierRegistrationRequestsTable.id, id));
    res.json({ ok: true });
  },
);

export default router;
