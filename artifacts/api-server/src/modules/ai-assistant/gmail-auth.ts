/**
 * Gmail access via service account + domain-wide delegation (XOAUTH2).
 *
 * This is how the assistant reads several Workspace mailboxes without storing a
 * password for any of them. The service account (the same one backing Sheets and
 * Drive backup) is authorized once by a Workspace admin, then impersonates each
 * mailbox to READ its mail.
 *
 * Scope: `https://mail.google.com/` — full IMAP/SMTP access, which is what
 * XOAUTH2 for IMAP requires. It also grants send permission, but that is not
 * used here: outbound mail always goes through `shared/mail-identity.ts` with
 * the SMTP app password, so read access can never widen the sender.
 *
 * IMPORTANT (verified): Google Workspace is required. A service account cannot
 * impersonate a personal @gmail.com address — those calls fail with
 * `admin_policy_enforced`/invalid delegation. A domain without delegation
 * configured fails the same way, which is why the error text below tells the
 * admin exactly which two steps are missing.
 */
import { logger } from "../../shared/logger";

/** Full mailbox access; the minimum that XOAUTH2 for IMAP accepts. */
const GMAIL_SCOPE = "https://mail.google.com/";

/**
 * The service account used for MAIL, if one is configured separately.
 *
 * `GOOGLE_MAIL_SERVICE_ACCOUNT_BASE_64` is preferred over the shared
 * `GOOGLE_ACCOUNT_BASE_64` so mail access can live in its own project with its
 * own delegation grant. The shared credential is used by Sheets, the Drive
 * backup and the ERP connectors, so rotating it to add mail scopes would widen
 * those integrations' blast radius. The fallback keeps single-mailbox
 * deployments working with the credential they already have.
 */
function mailServiceAccountBase64(): string | undefined {
  return process.env.GOOGLE_MAIL_SERVICE_ACCOUNT_BASE_64 || process.env.GOOGLE_ACCOUNT_BASE_64;
}

interface ServiceAccountJson {
  client_email?: string;
  private_key?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Keyed by mailbox address — each user gets their own access token. */
const tokenCache = new Map<string, CachedToken>();

/** Renew this long before expiry so an in-flight fetch never uses a dead token. */
const RENEW_MARGIN_MS = 5 * 60 * 1000;

export class GmailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailAuthError";
  }
}

function readServiceAccount(): ServiceAccountJson | null {
  const b64 = mailServiceAccountBase64();
  if (!b64) return null;
  try {
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as ServiceAccountJson;
    if (!json.client_email || !json.private_key) {
      logger.error("GOOGLE_MAIL_SERVICE_ACCOUNT_BASE_64 is missing client_email/private_key");
      return null;
    }
    return json;
  } catch (err) {
    logger.error({ err }, "GOOGLE_MAIL_SERVICE_ACCOUNT_BASE_64 is not valid base64 JSON");
    return null;
  }
}

/** True when the service-account credentials needed for delegation are present. */
export function isDelegationConfigured(): boolean {
  return Boolean(mailServiceAccountBase64());
}

/** Clear cached tokens (tests, or after rotating the service account key). */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/**
 * An access token for `mailbox`, impersonating that user via domain-wide
 * delegation. Cached until shortly before expiry.
 */
export async function gmailAccessToken(mailbox: string): Promise<string> {
  const now = Date.now();
  const hit = tokenCache.get(mailbox);
  if (hit && hit.expiresAt - RENEW_MARGIN_MS > now) return hit.token;

  const sa = readServiceAccount();
  if (!sa) {
    throw new GmailAuthError(
      `قراءة البريد عبر Google غير مهيّأة: ` +
        `GOOGLE_MAIL_SERVICE_ACCOUNT_BASE_64 (أو GOOGLE_ACCOUNT_BASE_64) غير موجود.`,
    );
  }

  // `google.auth.JWT` from the already-present `googleapis` dependency (no new
  // package needed) — the `subject` option is what turns a service-account
  // token into an impersonation of a specific Workspace user.
  const { google } = await import("googleapis");
  const client = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    subject: mailbox,
    scopes: [GMAIL_SCOPE],
  });

  try {
    const res = await client.authorize();
    const token = res.access_token;
    if (!token) throw new GmailAuthError("لم يُرجع Google رمز وصول (access token) صالح.");
    tokenCache.set(mailbox, {
      token,
      expiresAt: res.expiry_date ?? now + 50 * 60 * 1000,
    });
    return token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The two admin misconfigurations produce distinctive messages; translate
    // them into instructions rather than surfacing Google's wording.
    if (/unauthorized_client|invalid_grant|admin_policy_enforced|invalid delegation/i.test(msg)) {
      throw new GmailAuthError(
        `تعذّر قراءة ${mailbox}: حساب الخدمة غير مُفوَّض للوصول إلى هذا البريد. ` +
          `مطلوب من أدمن Google Workspace خطوتان: (١) إضافة معرّف العميل ` +
          `${sa.client_email} إلى Domain-wide Delegation، ` +
          `(٢) تفويض الصلاحية ${GMAIL_SCOPE}.`,
      );
    }
    throw new GmailAuthError(`تعذّر الحصول على رمز دخول لـ ${mailbox}: ${msg}`);
  }
}
