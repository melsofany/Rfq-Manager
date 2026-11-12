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
import { db, employeesTable, whatsappChatsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { logger } from "../../shared/logger";
import { guardFor } from "../../shared/permissions";
import { sendWhatsAppText } from "../communications/service";
import { isChatwootConfigured as isBridgeConfigured, phoneForConversation } from "./bridge";

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
      api_access_token: CHATWOOT_PLATFORM_TOKEN,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

/** Find a Chatwoot platform user by email. Returns undefined if not found. */
async function findChatwootUserByEmail(email: string): Promise<ChatwootUser | undefined> {
  // List account users (each row carries the platform user id + email).
  const res = await chatwootFetch(`/platform/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/account_users`);
  if (!res.ok) {
    logger.warn({ status: res.status }, "Chatwoot: list account users failed");
    return undefined;
  }
  const data = (await res.json()) as Array<{
    user_id: number;
    email?: string;
    user?: { id: number; email: string; name?: string };
  }>;
  const match = data.find((u) => (u.email ?? u.user?.email)?.toLowerCase() === email.toLowerCase());
  if (match) {
    return { id: match.user_id ?? match.user?.id, email, name: match.user?.name };
  }
  return undefined;
}

/** Create a Chatwoot user + add them to the account, then return the user. */
async function createChatwootUser(
  name: string,
  email: string,
  role: string,
): Promise<ChatwootUser | undefined> {
  // Generate a strong random password (the user logs in via SSO, never the password).
  const password = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const res = await chatwootFetch(`/platform/api/v1/users`, {
    method: "POST",
    body: JSON.stringify({ name, email, password }),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.warn({ status: res.status, body }, "Chatwoot: create user failed");
    return undefined;
  }
  const created = (await res.json()) as { id: number; email: string };
  if (!created.id) return undefined;

  // Attach the new user to our account as agent (admins promoted manually in Chatwoot).
  const cwRole = role === "admin" ? "administrator" : "agent";
  await chatwootFetch(`/platform/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/account_users`, {
    method: "POST",
    body: JSON.stringify({ user_id: created.id, role: cwRole }),
  });

  return { id: created.id, email: created.email };
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
    let cwUser = await findChatwootUserByEmail(employee.email);
    if (!cwUser) {
      cwUser = await createChatwootUser(
        employee.name || employee.email,
        employee.email,
        employee.role,
      );
    }
    if (!cwUser) {
      res.status(502).json({ error: "تعذّر إنشاء/إيجاد مستخدم Chatwoot" });
      return;
    }

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
