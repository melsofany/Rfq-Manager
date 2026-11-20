/**
 * Telling the supplier what we decided.
 *
 * A review the supplier never hears about is a review that did not happen: they
 * wait for a decision that has already been taken. Every terminal or
 * action-required transition therefore produces a message, on the channel they
 * gave us.
 *
 * Two rules govern this module:
 *
 * 1. **The decision table is pure.** `notificationFor()` answers "what should be
 *    said for this transition" with no I/O, so the wording and the choice of
 *    events are unit-testable. Sending happens in `deliverNotification()`.
 * 2. **A send result is reported, never assumed.** WhatsApp returns a wamid or
 *    throws; email is configured or it is not. The caller stores exactly what
 *    happened, because «تم الإرسال» over a message that never left is the
 *    failure this repo keeps recording (the false «✓ أُرسل»).
 */
import { logger } from "../../shared/logger";
import { COMPANY, rtl } from "../../shared/brand";
import { REVIEW_STATUS, REVIEW_STATUS_LABELS, normalizeStatus } from "./workflow";

/** Which channel a delivery went out on. */
export type NotifyChannel = "whatsapp" | "email";

/** The outcome of one channel attempt. */
export interface NotifyAttempt {
  channel: NotifyChannel;
  ok: boolean;
  /** Provider message id (WhatsApp) — absent for email. */
  messageId?: string | null;
  /** Why it failed, in a form an operator can act on. */
  error?: string | null;
  /** True when the channel has no credentials at all — distinct from a failure. */
  notConfigured?: boolean;
}

export interface NotifyResult {
  /** True when at least one channel actually delivered. */
  delivered: boolean;
  attempts: NotifyAttempt[];
  /** A sentence the reviewer can read on screen, honest about what happened. */
  summary: string;
}

/** What the supplier should be told, independent of how we tell them. */
export interface SupplierMessage {
  /** Body text, Arabic, ready to send. */
  body: string;
  /** One-line subject for email. */
  subject: string;
}

/**
 * Statuses that change something for the supplier.
 *
 * `ASSIGNED` and `UNDER_REVIEW` are internal moves — the supplier has no action
 * and nothing to learn, so messaging them would be noise. `VERIFIED` is also
 * internal: it is our own check, not a decision. A message on every status
 * change would train the supplier to ignore all of them.
 */
const NOTIFYING_STATUSES = new Set<string>([
  REVIEW_STATUS.APPROVED,
  REVIEW_STATUS.REJECTED,
  REVIEW_STATUS.NEEDS_INFORMATION,
  REVIEW_STATUS.NEEDS_DOCUMENTS,
  REVIEW_STATUS.SUSPENDED,
]);

export interface NotificationInput {
  /** The supplier's phone (WhatsApp). Distinct from `email`: one field cannot
   * carry both, and passing an address to a WhatsApp sender silently fails. */
  phone?: string | null;
  /** The supplier's email address. */
  email?: string | null;
  /** Normalised target status. */
  status: string;
  supplierName: string;
  reference: string;
  /** The reviewer's note — the reason, or what we need. */
  note?: string | null;
  /** What we asked for, when the target is an information/document request. */
  requestedItems?: string[];
  /** Deadline for a request, ISO date or free text. */
  deadline?: string | null;
  employeeName?: string | null;
}

/**
 * The message for a transition, or `null` when the supplier should not be
 * contacted. Pure — no I/O, no env reads.
 */
export function notificationFor(input: NotificationInput): SupplierMessage | null {
  const status = normalizeStatus(input.status);
  if (!NOTIFYING_STATUSES.has(status)) return null;

  const supplier = input.supplierName?.trim() || "المورد الكريم";
  const ref = input.reference?.trim() || "";
  const refLine = ref ? `\nرقم الطلب: ${ref}` : "";
  const note = input.note?.trim();
  const items = (input.requestedItems ?? []).map((s) => s.trim()).filter(Boolean);
  const itemLines = items.length ? `\nالمطلوب:\n${items.map((s) => `• ${s}`).join("\n")}` : "";
  const deadline = input.deadline?.trim();
  const deadlineLine = deadline ? `\nمهلة الرد: ${deadline}` : "";
  const signer = input.employeeName?.trim();
  const signLine = signer ? `\n\n${signer}\n${COMPANY.nameAr}` : `\n\n${COMPANY.nameAr}`;

  switch (status) {
    case REVIEW_STATUS.APPROVED:
      return {
        subject: `اعتماد تسجيل المورد — ${ref || supplier}`,
        body:
          `السادة ${supplier}،\n\n` +
          `يسرنا إبلاغكم بأنه تم اعتماد تسجيلكم كمورد لدى ${COMPANY.display}.` +
          refLine +
          `\n\nيمكنكم الآن استلام طلبات التسعير وأوامر التوريد من خلال القنوات المعتادة.` +
          signLine,
      };

    case REVIEW_STATUS.REJECTED:
      return {
        subject: `بخصوص طلب تسجيل المورد — ${ref || supplier}`,
        body:
          `السادة ${supplier}،\n\n` +
          `نأسف لإبلاغكم بأنه تعذّر اعتماد طلب تسجيلكم لدى ${COMPANY.display}.` +
          refLine +
          (note ? `\n\nالسبب: ${note}` : "") +
          `\n\nيمكنكم التواصل معنا لمراجعة الموقف أو تقديم طلب جديد مستوفٍ للبيانات.` +
          signLine,
      };

    case REVIEW_STATUS.NEEDS_INFORMATION:
      return {
        subject: `مطلوب استكمال بيانات — ${ref || supplier}`,
        body:
          `السادة ${supplier}،\n\n` +
          `برجاء استكمال البيانات التالية لاستكمال مراجعة تسجيلكم لدى ${COMPANY.display}.` +
          refLine +
          itemLines +
          (note ? `\n\nملاحظات: ${note}` : "") +
          deadlineLine +
          `\n\nنشكر لكم حسن تعاونكم.` +
          signLine,
      };

    case REVIEW_STATUS.NEEDS_DOCUMENTS:
      return {
        subject: `مطلوب استكمال مستندات — ${ref || supplier}`,
        body:
          `السادة ${supplier}،\n\n` +
          `برجاء إرسال المستندات التالية لاستكمال مراجعة تسجيلكم لدى ${COMPANY.display}.` +
          refLine +
          itemLines +
          (note ? `\n\nملاحظات: ${note}` : "") +
          deadlineLine +
          `\n\nنشكر لكم حسن تعاونكم.` +
          signLine,
      };

    case REVIEW_STATUS.SUSPENDED:
      return {
        subject: `إيقاف مؤقت لحساب المورد — ${ref || supplier}`,
        body:
          `السادة ${supplier}،\n\n` +
          `نفيدكم بأنه تم إيقاف حسابكم مؤقتًا لدى ${COMPANY.display}.` +
          refLine +
          (note ? `\n\nالسبب: ${note}` : "") +
          `\n\nبرجاء التواصل معنا لمراجعة الموقف.` +
          signLine,
      };

    default:
      return null;
  }
}

/**
 * Should this status notify at all? Exposed so the route can skip the work
 * entirely instead of building a message and discarding it.
 */
export function shouldNotify(status: string): boolean {
  return NOTIFYING_STATUSES.has(normalizeStatus(status));
}

/** Human label for the status, for the reviewer's confirmation line. */
export function statusLabel(status: string): string {
  return REVIEW_STATUS_LABELS[normalizeStatus(status)] ?? status;
}

// ─── Delivery ───────────────────────────────────────────────────────────────

/**
 * WhatsApp templates, one per supplier-facing decision.
 *
 * Meta does not allow an approved body to be edited, so each decision has its
 * own template name rather than one template with a variable "decision" word —
 * a supplier reading «تم اعتماد» must not receive a template whose other
 * branches say «مرفوض».
 */
export const SUPPLIER_NOTIFY_TEMPLATES: Record<string, string> = {
  [REVIEW_STATUS.APPROVED]: "supplier_review_approved_ar",
  [REVIEW_STATUS.REJECTED]: "supplier_review_rejected_ar",
  [REVIEW_STATUS.NEEDS_INFORMATION]: "supplier_review_info_request_ar",
  [REVIEW_STATUS.NEEDS_DOCUMENTS]: "supplier_review_docs_request_ar",
  [REVIEW_STATUS.SUSPENDED]: "supplier_review_suspended_ar",
};

/**
 * The name `communications/service.ts` actually provisions and sends.
 *
 * Kept as a lazily-resolved map rather than a top-level import: `service.ts`
 * imports this module, so a static import here would be a cycle. The map is
 * built from `reviewTemplateKey()` so the two files cannot disagree about
 * WHICH template a status uses — the drift that turns a working feature into a
 * «template does not exist» at send time.
 */
export async function resolveReviewTemplate(status: string): Promise<string | null> {
  const svc = await import("../communications/service");
  const key = svc.reviewTemplateKey(status);
  return key ? (svc.SUPPLIER_REVIEW_TEMPLATES[key] ?? null) : null;
}

/** Is email configured? Host + user + pass are ALL required to authenticate. */
export function isEmailConfigured(): boolean {
  return Boolean(
    (process.env.SMTP_HOST || "smtp.gmail.com").trim() &&
    (process.env.SMTP_USER || "").trim() &&
    (process.env.SMTP_PASS || "").trim(),
  );
}

export interface DeliverInput extends NotificationInput {
  message: SupplierMessage;
  /** Suppress actual sending (dry run / tests). */
  dryRun?: boolean;
}

/**
 * Send one notification over every channel the supplier gave us.
 *
 * Never throws: a notification failure must not roll back a decision the
 * reviewer already took and the database already recorded. The caller stores
 * `delivered` so the screen can say what really happened.
 */
export async function deliverNotification(input: DeliverInput): Promise<NotifyResult> {
  const attempts: NotifyAttempt[] = [];
  const status = normalizeStatus(input.status);

  // ── WhatsApp ──
  if (input.dryRun) {
    attempts.push({ channel: "whatsapp", ok: false, notConfigured: true, error: "dry run" });
  } else {
    try {
      const svc = await import("../communications/service");
      if (!svc.isWhatsAppConfigured) {
        attempts.push({
          channel: "whatsapp",
          ok: false,
          notConfigured: true,
          error: "واتساب غير مهيّأ",
        });
      } else if (!input.phone?.trim()) {
        attempts.push({
          channel: "whatsapp",
          ok: false,
          notConfigured: true,
          error: "لا يوجد رقم هاتف للمورد",
        });
      } else {
        const template = (await resolveReviewTemplate(status)) ?? SUPPLIER_NOTIFY_TEMPLATES[status];
        const wamid = template
          ? await svc.sendSupplierReviewWhatsApp({
              to: input.phone,
              template,
              supplierName: input.supplierName,
              reference: input.reference,
              note: input.note ?? null,
              requestedItems: input.requestedItems ?? [],
              deadline: input.deadline ?? null,
            })
          : "";
        attempts.push({ channel: "whatsapp", ok: Boolean(wamid), messageId: wamid || null });
        if (!wamid) {
          attempts.push({
            channel: "whatsapp",
            ok: false,
            error: "لم يُعد واتساب معرّف رسالة",
          });
        }
      }
    } catch (err) {
      logger.warn(
        { err, application: input.reference },
        "supplier notification via WhatsApp failed",
      );
      attempts.push({
        channel: "whatsapp",
        ok: false,
        error: err instanceof Error ? err.message : "فشل إرسال واتساب",
      });
    }
  }

  // ── Email ──
  const hasEmail = Boolean(input.email && input.email.includes("@"));
  if (!hasEmail) {
    attempts.push({
      channel: "email",
      ok: false,
      notConfigured: true,
      error: "لا يوجد بريد للمورد",
    });
  } else if (input.dryRun) {
    attempts.push({ channel: "email", ok: false, notConfigured: true, error: "dry run" });
  } else if (!isEmailConfigured()) {
    // Honest: the server has no SMTP credentials on this deployment.
    attempts.push({
      channel: "email",
      ok: false,
      notConfigured: true,
      error: "البريد غير مهيّأ على الخادم (SMTP)",
    });
  } else {
    try {
      const mail = await import("../../shared/email");
      await mail.sendSupplierReviewEmail({
        to: input.email!,
        supplierName: input.supplierName,
        subject: input.message.subject,
        body: input.message.body,
        reference: input.reference,
        statusLabel: statusLabel(status),
      });
      attempts.push({ channel: "email", ok: true });
    } catch (err) {
      logger.warn({ err, application: input.reference }, "supplier notification via email failed");
      attempts.push({
        channel: "email",
        ok: false,
        error: err instanceof Error ? err.message : "فشل إرسال البريد",
      });
    }
  }

  const delivered = attempts.some((a) => a.ok);
  const ok = attempts.filter((a) => a.ok).map((a) => channelLabel(a.channel));
  const failed = attempts.filter((a) => !a.ok && !a.notConfigured);

  let summary: string;
  if (delivered) {
    summary = `تم إبلاغ المورد عبر ${ok.join(" و")}.`;
    if (failed.length) {
      summary += ` تعذّر ${failed.map((f) => channelLabel(f.channel)).join(" و")}.`;
    }
  } else {
    const reasons = attempts
      .filter((a) => a.error)
      .map((a) => `${channelLabel(a.channel)}: ${a.error}`)
      .join(" — ");
    summary = `لم يُبلَّغ المورد. ${reasons}`;
  }

  return { delivered, attempts, summary };
}

function channelLabel(c: NotifyChannel): string {
  return c === "whatsapp" ? "واتساب" : "البريد";
}

/** RTL-wrapped body for display in a log or an email preview. */
export function previewBody(message: SupplierMessage): string {
  return rtl(message.body);
}
