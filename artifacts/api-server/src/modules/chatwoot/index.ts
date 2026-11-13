/**
 * Chatwoot Module — دمج Chatwoot كصندوق دردشة موحّد للموردين
 *
 * Chatwoot هو تطبيق Rails+Vue مستقل يعمل كخدمة منفصلة. هذا الموديول يوفّر
 * جسر الـ SSO بين التطبيق الحالي و Chatwoot بحيث عند فتح صفحة /whatsapp
 * يُسجّل دخول المستخدم الحالي تلقائياً داخل iframe يعرض واجهة Chatwoot.
 *
 * Routes mounted:
 *   GET  /chatwoot/sso          — يُرجع رابط SSO لمرة واحدة للمستخدم الحالي
 *   GET  /chatwoot/status       — هل Chatwoot مُعدّ؟ (للواجهة الأمامية)
 *   POST /chatwoot/webhook      — يستقبل رسائل الوكلاء من Chatwoot ويُرسلها واتساب
 */
import { Router, type IRouter } from "express";
import { randomInt, randomBytes } from "node:crypto";
import { db, employeesTable, whatsappChatsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../../middlewares/auth";
import { backfillHistory } from "./backfill";
import { logger } from "../../shared/logger";
import { guardFor } from "../../shared/permissions";
import { sendWhatsAppText } from "../communications/service";
import { isChatwootConfigured as isBridgeConfigured, phoneForConversation } from "./bridge";
import { gatewayHeaders } from "./client";

const router: IRouter = Router();
router.use("/chatwoot", guardFor("/chatwoot"));

const CHATWOOT_URL = process.env.CHATWOOT_URL?.replace(/\/$/, "") || "";
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || "";
// Platform App access token (super-admin level) — used to provision users + mint SSO links.
const CHATWOOT_PLATFORM_TOKEN = process.env.CHATWOOT_PLATFORM_TOKEN || "";
const CHATWOOT_INBOX_ID = process.env.CHATWOOT_INBOX_ID || "";

export const isChatwootConfigured = Boolean(
  CHATWOOT_URL && CHATWOOT_ACCOUNT_ID && CHATWOOT_PLATFORM_TOKEN,
);

interface ChatwootUser {
  id: number;
  email: string;
  name?: string;
}

async function chatwootFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${CHATWOOT_URL}${path}`, {
    ...init,
    headers: {
      ...gatewayHeaders(),
      api_access_token: CHATWOOT_PLATFORM_TOKEN,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

/**
 * Find-or-create the Chatwoot user for an email, in ONE idempotent call.
 *
 * `POST /platform/api/v1/users` is an upsert — the controller does
 * `User.from_email(params[:email]) || User.new(params)` — and it follows with
 * `platform_app_permissibles.find_or_create_by!`. So this single call:
 *
 *   - resolves the EXISTING user for a known email (verified live: the same
 *     address returned the same id twice, never a duplicate), and
 *   - creates the permission row that the SSO login endpoint requires.
 *
 * That second effect is why this replaced a separate "find by email" helper:
 * the previous lookup read `u.email` off
 * `GET /accounts/:id/account_users`, but that endpoint renders the raw
 * `account_users` rows, which carry `user_id` and NO email — measured live, the
 * payload is `{id, account_id, user_id, role, inviter_id, ...}` with no `email`
 * and no nested `user`. The lookup was therefore ALWAYS undefined, every
 * employee was treated as brand new, and users that already existed never got
 * the permission row — so their SSO link answered
 * `401 {"error":"Non permissible resource"}`.
 *
 * The password is only consumed when the user is genuinely new: for an existing
 * record `User.from_email` wins and `params` is ignored, so this can never reset
 * a live password.
 */
async function ensureChatwootUser(name: string, email: string): Promise<ChatwootUser | undefined> {
  const res = await chatwootFetch(`/platform/api/v1/users`, {
    method: "POST",
    body: JSON.stringify({ name: name || email, email, password: generateChatwootPassword() }),
  });
  if (!res.ok) {
    logger.warn(
      { status: res.status, body: await res.text() },
      "Chatwoot: ensure user failed",
    );
    return undefined;
  }
  const user = (await res.json()) as { id?: number; email?: string; name?: string };
  if (!user.id) return undefined;
  return { id: user.id, email: user.email ?? email, name: user.name };
}

/**
 * Attach a user to our account WITHOUT touching an existing role.
 *
 * `POST /accounts/:id/account_users` is `find_or_initialize_by(user_id:)` followed
 * by `update!(params)`, and `role` is a permitted param — so calling it for an
 * existing member REWRITES their role. Measured live: an `administrator` became
 * `agent` after one such call. Since the bridge called this on every create, any
 * employee whose Cortoba role was not admin would demote every administrator in
 * the console merely by opening the conversations page.
 *
 * A role is therefore sent ONLY when the user is not already a member. For an
 * existing member the call is skipped entirely — there is nothing to attach.
 */
async function attachToAccount(userId: number, role: string): Promise<void> {
  const listRes = await chatwootFetch(
    `/platform/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/account_users`,
  );
  if (listRes.ok) {
    const members = (await listRes.json()) as Array<{ user_id?: number }>;
    if (members.some((m) => m.user_id === userId)) return; // Already a member — never rewrite the role.
  } else {
    logger.warn(
      { status: listRes.status, userId },
      "Chatwoot: could not list account users; skipping attach to avoid a role rewrite",
    );
    return;
  }

  const cwRole = role === "admin" ? "administrator" : "agent";
  const res = await chatwootFetch(
    `/platform/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/account_users`,
    { method: "POST", body: JSON.stringify({ user_id: userId, role: cwRole }) },
  );
  if (!res.ok) {
    logger.warn({ status: res.status, userId }, "Chatwoot: attach to account failed");
  }
}

/**
 * Generate a password that satisfies Chatwoot's password policy.
 *
 * The SSO flow never shows this password — the user authenticates through the
 * one-time link — but it is still VALIDATED on creation, and Chatwoot requires
 * at least one special character
 * (`config.password_required_special_character_count = 1`).
 *
 * The previous generator was `Math.random().toString(36)`, which yields only
 * `[a-z0-9]`. Measured against the live console:
 *
 *   POST /platform/api/v1/users -> 422
 *   "Password must contain at least 1 special character ( !@#$%^&*()_+-=[]{}|...)"
 *
 * So EVERY new employee failed to be created, and `createChatwootUser` returns
 * undefined on a non-OK response — which surfaces to the agent as
 * "تعذّر إنشاء/إيجاد مستخدم Chatwoot" with no hint that a password rule caused
 * it. `crypto.randomBytes` also removes the (small) collision risk of two users
 * drawing the same password.
 *
 * The special character is drawn from the same set the policy lists, and is
 * inserted rather than appended so a truncated value can never lose it.
 */
function generateChatwootPassword(): string {
  // Avoid characters the policy text does not list, and avoid backslash/quote
  // so the value can never need escaping in a JSON body.
  const specials = "!@#$%^&*()_+-=[]{}|.,:;?~";
  const pick = (chars: string) => chars[randomInt(chars.length)];
  const body =
    randomBytes(18).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 20) ||
    "CortobaAgent";
  // Guarantee each required class explicitly rather than hoping for it.
  return `${pick(specials)}${body}${pick("ABCDEFGHJKLMNPQRSTUVWXYZ")}${pick("23456789")}`;
}

/** Create a Chatwoot user + add them to the account, then return the user. */
async function createChatwootUser(
  name: string,
  email: string,
  role: string,
): Promise<ChatwootUser | undefined> {
  const user = await ensureChatwootUser(name, email);
  if (!user) return undefined;
  await attachToAccount(user.id, role);
  return user;
}

/** Mint a one-time SSO login URL for a Chatwoot user. */
async function getChatwootSsoLink(userId: number): Promise<string | undefined> {
  const res = await chatwootFetch(`/platform/api/v1/users/${userId}/login`);
  if (!res.ok) {
    logger.warn({ status: res.status, userId }, "Chatwoot: get SSO link failed");
    return undefined;
  }
  const data = (await res.json()) as { url?: string };
  return data.url;
}

// GET /api/chatwoot/status — quick config check for the frontend.
router.get("/chatwoot/status", requireAuth, (_req, res): void => {
  res.json({
    configured: isChatwootConfigured,
    url: CHATWOOT_URL || null,
    inboxId: CHATWOOT_INBOX_ID || null,
  });
});

// POST /api/chatwoot/backfill — replay our existing WhatsApp history into the
// console. Admin/manager only: it writes to the console for every supplier at
// once, which is not something an operator should be able to trigger casually.
//
// Batched and resumable on purpose. Production holds thousands of messages, and
// a single request that replays all of them would time out and leave no record
// of where it got to. `nextCursor` is the resume point.
router.post(
  "/chatwoot/backfill",
  requireAuth,
  requireRole("admin", "manager"),
  async (req, res): Promise<void> => {
    const limit = Number(req.body?.limit ?? 0) || undefined;
    try {
      const result = await backfillHistory({ limit });
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Chatwoot history backfill failed");
      res.status(500).json({ error: "تعذّر تنفيذ استرجاع المحادثات" });
    }
  },
);

// GET /api/chatwoot/sso — returns a one-time SSO URL for the current user.
router.get("/chatwoot/sso", requireAuth, async (req, res): Promise<void> => {
  if (!isChatwootConfigured) {
    res.status(503).json({
      error:
        "Chatwoot غير مُعدّ. أضف CHATWOOT_URL و CHATWOOT_ACCOUNT_ID و CHATWOOT_PLATFORM_TOKEN كمتغيرات بيئية.",
    });
    return;
  }

  if (!req.session.employeeId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const employeeId = req.session.employeeId;
  const [employee] = await db
    .select()
    .from(employeesTable)
    .where(eq(employeesTable.id, employeeId));
  if (!employee || !employee.email) {
    res.status(400).json({ error: "لا يوجد بريد إلكتروني للمستخدم الحالي" });
    return;
  }

  try {
    // ONE idempotent call resolves an existing user (same id, never a duplicate)
    // AND grants the platform permission the SSO login endpoint requires.
    const cwUser = await ensureChatwootUser(
      employee.name || employee.email,
      employee.email,
    );
    if (!cwUser) {
      res.status(502).json({ error: "تعذّر إنشاء/إيجاد مستخدم Chatwoot" });
      return;
    }

    // Only a user who is NOT yet a member gets a role; an existing member's role
    // is never rewritten (that call is an `update!` and would demote an admin).
    await attachToAccount(cwUser.id, employee.role);

    const ssoUrl = await getChatwootSsoLink(cwUser.id);
    if (!ssoUrl) {
      res.status(502).json({ error: "تعذّر توليد رابط تسجيل دخول Chatwoot" });
      return;
    }

    logger.info({ employeeId, cwUserId: cwUser.id }, "Chatwoot SSO link issued");
    res.json({ url: ssoUrl });
  } catch (err) {
    logger.error({ err, employeeId }, "Chatwoot SSO failed");
    res.status(500).json({ error: "فشل الاتصال بـ Chatwoot" });
  }
});

// ─── POST /api/webhook/chatwoot ──────────────────────────────────────────
// Chatwoot posts here when a human agent replies in the console. We forward
// that text to the supplier through OUR OWN Meta plumbing and record it in
// whatsapp_chats, so the conversation stays in one place and no second WhatsApp
// channel is involved.
//
// Lives under /webhook (not /chatwoot) because it must be public — Chatwoot
// cannot present a session — and /webhook has no route guard. Gated by a shared
// secret in the URL that Chatwoot is configured with.
router.post("/webhook/chatwoot", async (req, res): Promise<void> => {
  // Acknowledge first: Chatwoot retries a slow webhook, which would double-send.
  res.sendStatus(200);

  if (!isBridgeConfigured) return;
  const secret = process.env.CHATWOOT_WEBHOOK_SECRET;
  if (!secret || req.query.token !== secret) {
    logger.warn("Chatwoot webhook: rejected (missing or wrong token)");
    return;
  }

  try {
    const payload = req.body as {
      event?: string;
      message_type?: string;
      content?: string;
      conversation?: { id?: number };
      id?: number;
      private?: boolean;
      sender?: { type?: string };
    };

    // Only real agent replies: outgoing (us → contact), not private notes, and
    // not the messages we ourselves mirrored into the thread.
    if (payload.event !== "message_created") return;
    if (payload.message_type !== "outgoing") return;
    // A private note is an INTERNAL note. Forwarding it would send the team's
    // internal discussion straight to the supplier.
    if (payload.private) return;
    if (!payload.content || !payload.conversation?.id) return;
    if (payload.sender?.type !== "user") return; // ignore bot/API echoes

    const { isOwnChatwootMessage } = await import("./bridge");
    if (isOwnChatwootMessage(payload.id)) return;

    const phone = await phoneForConversation(payload.conversation.id);
    if (!phone) {
      logger.warn(
        { conversationId: payload.conversation.id },
        "Chatwoot webhook: no linked phone for conversation",
      );
      return;
    }

    const waId = await sendWhatsAppText(phone, payload.content);
    await db.insert(whatsappChatsTable).values({
      waMessageId: waId,
      direction: "outbound",
      phone,
      body: payload.content,
      isRead: true,
    });
    logger.info({ phone, conversationId: payload.conversation.id }, "Chatwoot agent reply sent");
  } catch (err) {
    logger.error({ err }, "Chatwoot webhook: agent reply forwarding failed");
  }
});

export default router;
