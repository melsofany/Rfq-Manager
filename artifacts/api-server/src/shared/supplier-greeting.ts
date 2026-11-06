/**
 * الترحيب بالمورد — the welcome sent when we first address a supplier.
 *
 * The operator's rule: a supplier hears from us for the first time either when
 * he is registered on our system or when he changes his phone/email, and that
 * first message must welcome him, say WHAT he is to us, attach the pricing
 * guide, congratulate him, and state that the company looks forward to growing
 * the business with him.
 *
 * The distinction that matters is REGISTERED vs PRELIMINARY, and it rests on one
 * fact: can we pay him? That is exactly `isSupplierRegistrationComplete` —
 * commercial register, tax registration and bank account. A supplier we can pay
 * is «مسجَّل», one we cannot is «مبدئي». Reusing the PO-dispatch rule here is
 * deliberate: two definitions of "registered" would let the greeting call a
 * supplier registered while the purchase-order gate refuses to send him an
 * order, which is the class of defect this repository keeps recording — a
 * surface that describes something untrue.
 *
 * Everything in this module is pure (no database, no network) so the wording and
 * the decision are unit tested directly.
 */
import { isSupplierRegistrationComplete } from "./supplier-registration";

/** How the supplier is addressed in this message. */
export type GreetingTier = "registered" | "preliminary";

/** Arabic name of each tier, as it appears in the message. */
export const GREETING_TIER_LABEL: Record<GreetingTier, string> = {
  registered: "مورد مسجَّل",
  preliminary: "مورد مبدئي",
};

/** The supplier fields this module reasons about. */
export interface GreetingHolder {
  name?: string | null;
  contactPerson?: string | null;
  commercialRegister?: string | null;
  taxRegistration?: string | null;
  bankName?: string | null;
  bankAccountHolder?: string | null;
  bankAccountNumber?: string | null;
  iban?: string | null;
  swiftCode?: string | null;
  bankBranch?: string | null;
}

/**
 * Which welcome the supplier gets.
 *
 * The rule is the payable-supplier rule, not a separate one — see the module
 * docblock. Keeping it a function (rather than inlining the call at the trigger)
 * is what lets the trigger read as a single decision.
 */
export function greetingTier(supplier: GreetingHolder): GreetingTier {
  return isSupplierRegistrationComplete(supplier) ? "registered" : "preliminary";
}

/**
 * Why we are greeting him this time — the operator named three occasions.
 *
 * `new_supplier`      never addressed before.
 * `phone_changed`     his phone changed, so the WhatsApp thread starts over.
 * `email_changed`     his email changed, so the mail thread starts over.
 * `phone_and_email`   both changed.
 *
 * It is carried in the result and the log so an operator asking «ليه جاله
 * الترحيب تاني؟» gets an answer instead of a guess.
 */
export type GreetingReason = "new_supplier" | "phone_changed" | "email_changed" | "phone_and_email";

/** Arabic wording of each reason, for the log line and the audit trail. */
export const GREETING_REASON_LABEL: Record<GreetingReason, string> = {
  new_supplier: "أول تعامل مع المورد",
  phone_changed: "تغيير رقم الهاتف",
  email_changed: "تغيير البريد الإلكتروني",
  phone_and_email: "تغيير الهاتف والبريد الإلكتروني",
};

/** The document we hold for this send, so the wording can name it. */
export type GreetingDocumentKind = "rfq" | "po" | "registration";

/**
 * First line of the message. The operator's required openers are «مرحبًا» for a
 * registered supplier and «مرحبًا بكم في قرطبة للتوريدات» for a preliminary one
 * — the company introduces itself only when it is still introducing itself.
 */
export function greetingOpener(tier: GreetingTier): string {
  return tier === "registered" ? "مرحبًا {{1}}،" : "مرحبًا بكم في قرطبة للتوريدات {{1}}،";
}

/**
 * The tier sentence: what the supplier IS to us, and the congratulation.
 *
 * Both branches congratulate, because both are good news — the operator asked
 * for it explicitly — but only the registered branch congratulates on
 * COMPLETING the registration, since a preliminary supplier has not.
 */
export function greetingTierSentence(tier: GreetingTier): string {
  return tier === "registered"
    ? "يسرّنا أن نحيطكم علمًا بأنه قد تم تسجيلكم لدينا كـ{{2}}، ونبارك لكم إتمام استكمال بياناتكم."
    : "يسرّنا أن نحيطكم علمًا بأنه قد تم ترحيبكم وتسجيلكم مبدئيًا كـ{{2}}، ونرجو استكمال بيانات التسجيل لدينا.";
}

/**
 * The closing: congratulations, the growth ambition, and the guide.
 *
 * The guide is named as ATTACHED, which is only true when the caller actually
 * attached it — `renderGreetingBody(tier, { guideAttached })` decides, and the
 * caller passes what it really did. A body that promises a file it does not
 * carry is the false-claim class this repository keeps recording.
 */
export function greetingClosing(tier: GreetingTier, guideAttached: boolean): string {
  const guide = guideAttached
    ? "تجدون بالمستند المرفق «دليل التسعير خطوة بخطوة»، وهو يشرح كيفية تسعير بنود طلبات التسعير عبر واتساب أو البريد الإلكتروني."
    : "ولمعرفة كيفية تسعير بنود طلبات التسعير عبر واتساب أو البريد الإلكتروني، يُرجى التواصل مع فريق المشتريات.";
  const ambition =
    tier === "registered"
      ? "نبارك لكم انضمامكم إلى قاعدة موردي قرطبة للتوريدات، ونطمح إلى تعزيز العمل معكم."
      : "ونطمح إلى تعزيز العمل معكم، ونتطلع إلى استكمال بياناتكم لنكون سعداء بالتعامل معكم كمورد مسجَّل.";
  return `${guide}\n\n${ambition}`;
}

/**
 * The whole message body, as a WhatsApp template with named placeholders.
 *
 * `{{1}}` contact/supplier name · `{{2}}` tier label («مورد مسجَّل» / «مورد
 * مبدئي»). Meta does not allow an approved template's body to be edited, so this
 * text is a REQUIREMENT pinned by a test: a wording change means publishing a
 * NEW template name, which is why the guard exists.
 */
export function renderGreetingBody(tier: GreetingTier, guideAttached: boolean): string {
  return [
    greetingOpener(tier),
    greetingTierSentence(tier),
    greetingClosing(tier, guideAttached),
  ].join("\n\n");
}

/**
 * The operator's two fixed bodies, exported so the test measures the exact text
 * that is submitted to Meta rather than a re-rendered approximation.
 */
export const SUPPLIER_GREETING_BODY_REGISTERED = renderGreetingBody("registered", true);
export const SUPPLIER_GREETING_BODY_PRELIMINARY = renderGreetingBody("preliminary", true);

/** A supplier row reduced to the contact identity this module compares. */
export interface ContactHolder {
  phone?: string | null;
  email?: string | null;
}

/** Normalise a phone for comparison: digits only, so `+20 100` == `20100`. */
export function normalizeContactPhone(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

/** Normalise an email for comparison: trimmed, lower-cased. */
export function normalizeContactEmail(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

/**
 * Which reason applies, given what we last contacted the supplier on.
 *
 * `null` previous values mean "never contacted" — not "empty", which is why the
 * comparison is explicit rather than a plain `!==`. A supplier who has always
 * had no email must not be treated as "email changed" every single send, or he
 * would be re-welcomed forever.
 */
export function greetingReasonFor(
  previous: ContactHolder | null,
  current: ContactHolder,
): GreetingReason | null {
  if (!previous) return "new_supplier";

  const phoneChanged =
    normalizeContactPhone(previous.phone) !== normalizeContactPhone(current.phone);
  const emailChanged =
    normalizeContactEmail(previous.email) !== normalizeContactEmail(current.email);

  if (phoneChanged && emailChanged) return "phone_and_email";
  if (phoneChanged) return "phone_changed";
  if (emailChanged) return "email_changed";
  return null;
}

/** True when the supplier should be welcomed on this send. */
export function shouldGreet(previous: ContactHolder | null, current: ContactHolder): boolean {
  const reason = greetingReasonFor(previous, current);
  if (!reason) return false;
  const channels = greetingChannels(reason, current);
  return channels.whatsapp || channels.email;
}

/** Which channels carry the welcome. */
export interface GreetingChannels {
  whatsapp: boolean;
  email: boolean;
}

/**
 * The channel a welcome travels on.
 *
 * The CHANGED channel is the one that carries the re-welcome, and a first
 * contact uses every channel we hold. Sending on an unchanged channel would
 * re-welcome a supplier who never lost contact there — the email thread he
 * already knows would suddenly repeat its own introduction — and the operator's
 * rule names the change, not the supplier, as the trigger.
 *
 * A channel we have no value for is never eligible, so a supplier with no phone
 * is not retried on WhatsApp forever.
 */
export function greetingChannels(reason: GreetingReason, current: ContactHolder): GreetingChannels {
  const hasPhone = normalizeContactPhone(current.phone) !== "";
  const hasEmail = normalizeContactEmail(current.email) !== "";
  switch (reason) {
    case "new_supplier":
      return { whatsapp: hasPhone, email: hasEmail };
    case "phone_changed":
      return { whatsapp: hasPhone, email: false };
    case "email_changed":
      return { whatsapp: false, email: hasEmail };
    case "phone_and_email":
      return { whatsapp: hasPhone, email: hasEmail };
  }
}
