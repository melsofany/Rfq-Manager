/**
 * AI Assistant — admin routes.
 *
 * All endpoints are restricted to admin/manager (requireRole). They manage the
 * allowlisted WhatsApp numbers and the assistant settings, plus a diagnostics
 * endpoint so the operator can confirm configuration without guessing.
 */
import { Router } from "express";
import { db, aiAssistantUsersTable, aiAssistantSettingsTable, employeesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireRole } from "../../middlewares/auth";
import { logger } from "../../shared/logger";
import { loadSettings, isAiConfigured, DEFAULT_BASE_URL, canonicalPhone } from "./config";
import { isEmailReadConfigured } from "./email";

const router = Router();
const guard = requireRole("admin", "manager");

/* eslint-disable @typescript-eslint/no-explicit-any */
const sessionOf = (req: any) =>
  (req.session ?? {}) as { employeeId?: number; role?: string; employeeName?: string };

async function audit(req: any, action: string, description: string, entityId?: number) {
  try {
    const { auditLogTable } = await import("@workspace/db");
    const s = sessionOf(req);
    await db.insert(auditLogTable).values({
      action,
      entityType: "ai_assistant",
      entityId: entityId ?? null,
      employeeId: s.employeeId ?? null,
      description,
      ipAddress: req.ip ?? null,
    });
  } catch (err) {
    logger.warn({ err }, "AI assistant: audit write failed");
  }
}

// ─── GET /ai-assistant/users — allowlist ─────────────────────────────────
router.get("/ai-assistant/users", guard, async (_req, res): Promise<void> => {
  const users = await db
    .select()
    .from(aiAssistantUsersTable)
    .orderBy(desc(aiAssistantUsersTable.id));
  res.json(users);
});

// ─── POST /ai-assistant/users — add to allowlist ─────────────────────────
router.post("/ai-assistant/users", guard, async (req, res): Promise<void> => {
  const { phone, name, employeeId, role } = req.body ?? {};
  if (!phone || typeof phone !== "string") {
    res.status(400).json({ error: "رقم الهاتف مطلوب" });
    return;
  }
  const canonical = canonicalPhone(phone);
  if (canonical.length < 8) {
    res.status(400).json({ error: "رقم هاتف غير صالح" });
    return;
  }
  const effectiveRole = role === "admin" || role === "manager" ? role : "manager";
  try {
    const [row] = await db
      .insert(aiAssistantUsersTable)
      .values({
        phone: canonical,
        name: name ? String(name) : null,
        employeeId: employeeId ? Number(employeeId) : null,
        role: effectiveRole,
      })
      .returning();
    await audit(req, "ai_assistant.user_added", `إضافة رقم ${canonical} إلى المساعد الذكي`, row.id);
    res.status(201).json(row);
  } catch (err) {
    logger.error({ err }, "AI assistant: add user failed");
    res.status(409).json({ error: "تعذّر إضافة الرقم (قد يكون مسجلًا بالفعل)" });
  }
});

// ─── PATCH /ai-assistant/users/:id ────────────────────────────────────────
router.patch("/ai-assistant/users/:id", guard, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { name, role, isActive, employeeId } = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (name !== undefined) patch.name = name ? String(name) : null;
  if (role !== undefined && (role === "admin" || role === "manager")) patch.role = role;
  if (isActive !== undefined) patch.isActive = Boolean(isActive);
  if (employeeId !== undefined) patch.employeeId = employeeId ? Number(employeeId) : null;
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "لا يوجد تغيير" });
    return;
  }
  const [row] = await db
    .update(aiAssistantUsersTable)
    .set(patch)
    .where(eq(aiAssistantUsersTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  await audit(req, "ai_assistant.user_updated", `تحديث بيانات المساعد رقم ${id}`, id);
  res.json(row);
});

// ─── DELETE /ai-assistant/users/:id ───────────────────────────────────────
router.delete("/ai-assistant/users/:id", guard, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  await db.delete(aiAssistantUsersTable).where(eq(aiAssistantUsersTable.id, id));
  await audit(req, "ai_assistant.user_removed", `حذف رقم من المساعد الذكي ${id}`, id);
  res.json({ ok: true });
});

// ─── GET /ai-assistant/employees — candidate employees (admin/manager) ────
router.get("/ai-assistant/employees", guard, async (_req, res): Promise<void> => {
  const rows = await db
    .select({ id: employeesTable.id, name: employeesTable.name, role: employeesTable.role })
    .from(employeesTable)
    .where(eq(employeesTable.isActive, true));
  res.json(rows);
});

// ─── GET /ai-assistant/settings ───────────────────────────────────────────
router.get("/ai-assistant/settings", guard, async (_req, res): Promise<void> => {
  const settings = await loadSettings();
  res.json({
    ...settings,
    apiKeySet: isAiConfigured,
    imapConfigured: isEmailReadConfigured,
    defaultBaseUrl: DEFAULT_BASE_URL,
  });
});

// ─── PUT /ai-assistant/settings ───────────────────────────────────────────
router.put("/ai-assistant/settings", guard, async (req, res): Promise<void> => {
  const { enabled, model, baseUrl, systemPrompt, language, allowEmail, allowDatabase, allowPdf } =
    req.body ?? {};
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (enabled !== undefined) patch.enabled = Boolean(enabled);
  if (model !== undefined) patch.model = String(model);
  if (baseUrl !== undefined) patch.baseUrl = baseUrl ? String(baseUrl) : null;
  if (systemPrompt !== undefined) patch.systemPrompt = systemPrompt ? String(systemPrompt) : null;
  if (language !== undefined) patch.language = language === "en" ? "en" : "ar";
  if (allowEmail !== undefined) patch.allowEmail = Boolean(allowEmail);
  if (allowDatabase !== undefined) patch.allowDatabase = Boolean(allowDatabase);
  if (allowPdf !== undefined) patch.allowPdf = Boolean(allowPdf);

  const [row] = await db
    .update(aiAssistantSettingsTable)
    .set(patch)
    .where(eq(aiAssistantSettingsTable.key, "default"))
    .returning();
  await audit(req, "ai_assistant.settings_updated", "تحديث إعدادات المساعد الذكي");
  res.json(row);
});

export default router;
