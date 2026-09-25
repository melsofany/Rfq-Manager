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
import {
  loadSettings,
  isAiConfigured,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_FALLBACK_MODELS,
  DEEPSEEK_MODEL,
  FALLBACK_MODELS,
  isDeepSeekConfigured,
  isDeepSeekEndpoint,
  isGeminiEndpoint,
  canonicalPhone,
  configuredProviderCount,
  providerStatus,
} from "./config";
import { isEmailReadConfigured } from "./email";
import { listAllModels } from "./llm";
import { rememberFact, normalizeCategory } from "./memory";
import { recentMetrics, metricsSummary } from "./metrics";
import { breakerSnapshot } from "./guardrails";
import { countJobsByStatus } from "./jobs";
import {
  loadOrgProfiles,
  saveOrgProfile,
  classifyByProfiles,
  deriveDocumentFormats,
  resetOrgProfilesCache,
} from "./org-profiles";

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
    imapConfigured: isEmailReadConfigured(),
    defaultModel: DEFAULT_MODEL,
    defaultBaseUrl: DEFAULT_BASE_URL,
    fallbackModels: FALLBACK_MODELS,
    isGemini: isGeminiEndpoint(settings.baseUrl),
    // The second provider. Reported separately from `fallbackModels` because it
    // is reached with a different key and endpoint, not merely a different id.
    deepseek: {
      configured: isDeepSeekConfigured,
      model: DEEPSEEK_MODEL,
      baseUrl: DEEPSEEK_BASE_URL,
      fallbackModels: DEEPSEEK_FALLBACK_MODELS,
      isPrimary: isDeepSeekEndpoint(settings.baseUrl),
    },
  });
});

// ─── GET /ai-assistant/mail-diagnostics ───────────────────────────────────
/**
 * Try to reach each configured mailbox and report what happened.
 *
 * A delegation failure is otherwise indistinguishable from an empty inbox, so
 * this runs the real IMAP connect (not a reachability ping) per mailbox and
 * returns the outcome. Admin-facing: it answers "did the delegation grant
 * actually take effect for THIS address?" without waiting for the assistant to
 * answer a question and quietly read nothing.
 */
router.get("/ai-assistant/mail-diagnostics", guard, async (_req, res): Promise<void> => {
  const { mailboxes, defaultMailbox, mailReaderIdentity } = await import("./mailboxes");
  const { withMailbox } = await import("./email");

  const list = mailboxes();
  const results = [];
  for (const m of list) {
    const started = Date.now();
    try {
      // Opening the INBOX is the real test: it authenticates (delegation) and
      // proves the mailbox is readable.
      const info = await withMailbox(async (client) => {
        const box = await client.mailboxOpen("INBOX");
        return { messages: box.exists, uidNext: box.uidNext };
      }, m.email);
      results.push({
        email: m.email,
        label: m.label,
        ok: true,
        messages: info.messages,
        ms: Date.now() - started,
      });
    } catch (err) {
      results.push({
        email: m.email,
        label: m.label,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      });
    }
  }

  res.json({
    reader: mailReaderIdentity(),
    default: defaultMailbox()?.email ?? null,
    mailboxes: results,
    okCount: results.filter((r) => r.ok).length,
    total: results.length,
  });
});

// ─── GET /ai-assistant/models ─────────────────────────────────────────────
router.get("/ai-assistant/models", guard, async (_req, res): Promise<void> => {
  const settings = await loadSettings();
  // Both providers' models, so an operator can select a DeepSeek model directly
  // (it is routed to DeepSeek's endpoint even when AI_BASE_URL points at Gemini).
  const models = await listAllModels(settings.baseUrl);
  res.json({
    models,
    defaultModel: DEFAULT_MODEL,
    fallbackModels: FALLBACK_MODELS,
    deepseekModel: DEEPSEEK_MODEL,
    deepseekFallbackModels: DEEPSEEK_FALLBACK_MODELS,
    // Failover capacity, so the dashboard can show that a one-provider
    // deployment has NO failover — a single shared daily budget. Without this an
    // outage looks like a mystery rather than a missing second key.
    providers: providerStatus(),
    configuredProviders: configuredProviderCount(),
  });
});

// ─── GET /ai-assistant/metrics — recent request telemetry ─────────────────
/**
 * What the assistant has actually cost lately: average + P95 latency, average
 * model rounds, timeout and verification rates, and the last requests with their
 * intent/path. This is in-memory and intentionally small — an operational signal
 * for the dashboard, not an audit trail.
 */
router.get("/ai-assistant/metrics", guard, async (_req, res): Promise<void> => {
  // `breakers` exposes which remote dependencies are currently marked down, so an
  // operator can tell "the assistant is slow" from "IMAP is failing" without
  // reading logs. An empty map means every dependency is healthy.
  res.json({ summary: metricsSummary(), recent: recentMetrics(20), breakers: breakerSnapshot() });
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

// ─── Long-term memory (admin CRUD) ────────────────────────────────────────
// The operator can see exactly what the assistant has learned, correct it, pin
// the important facts, and remove stale ones. Memory is otherwise written by the
// agent itself, so this is the human oversight path.

// GET /ai-assistant/memories — list, optionally filtered
router.get("/ai-assistant/memories", guard, async (req, res): Promise<void> => {
  const { aiAssistantMemoriesTable } = await import("@workspace/db");
  const { isNull, or, sql, desc, and, eq } = await import("drizzle-orm");
  const phone = req.query.phone ? String(req.query.phone) : undefined;
  const category = req.query.category ? String(req.query.category) : undefined;
  const includeExpired = req.query.includeExpired === "true";
  const rows = await db
    .select()
    .from(aiAssistantMemoriesTable)
    .where(
      and(
        phone !== undefined ? eq(aiAssistantMemoriesTable.phone, phone) : undefined,
        category ? eq(aiAssistantMemoriesTable.category, category) : undefined,
        includeExpired
          ? undefined
          : or(
              isNull(aiAssistantMemoriesTable.validUntil),
              sql`${aiAssistantMemoriesTable.validUntil} > NOW()`,
            ),
      ),
    )
    .orderBy(desc(aiAssistantMemoriesTable.pinned), desc(aiAssistantMemoriesTable.updatedAt))
    .limit(500);
  res.json(rows);
});

// POST /ai-assistant/memories — teach a fact (company-wide by default)
router.post("/ai-assistant/memories", guard, async (req, res): Promise<void> => {
  const { phone, category, key, value, importance, pinned } = req.body ?? {};
  if (!key || !value) {
    res.status(400).json({ error: "المفتاح والقيمة مطلوبان" });
    return;
  }
  try {
    const row = await rememberFact({
      phone: phone ? canonicalPhone(String(phone)) : "",
      category: category ? String(category) : "fact",
      key: String(key),
      value: String(value),
      importance: typeof importance === "number" ? importance : 80,
      pinned: Boolean(pinned),
      source: "admin",
    });
    await audit(req, "ai_assistant.memory_saved", `حفظ ذاكرة: ${row.key}`, row.id);
    res.status(201).json(row);
  } catch (err) {
    logger.error({ err }, "AI assistant: saving memory failed");
    res.status(400).json({ error: "تعذّر حفظ الذاكرة" });
  }
});

// PATCH /ai-assistant/memories/:id — edit / pin
router.patch("/ai-assistant/memories/:id", guard, async (req, res): Promise<void> => {
  const { aiAssistantMemoriesTable } = await import("@workspace/db");
  const id = Number(req.params.id);
  const { value, importance, pinned, category } = req.body ?? {};
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (value !== undefined) patch.value = String(value);
  if (importance !== undefined) patch.importance = Number(importance);
  if (pinned !== undefined) patch.pinned = Boolean(pinned);
  if (category !== undefined) patch.category = normalizeCategory(category);
  const [row] = await db
    .update(aiAssistantMemoriesTable)
    .set(patch)
    .where(eq(aiAssistantMemoriesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "غير موجود" });
    return;
  }
  await audit(req, "ai_assistant.memory_updated", `تحديث ذاكرة ${id}`, id);
  res.json(row);
});

// DELETE /ai-assistant/memories/:id — remove
router.delete("/ai-assistant/memories/:id", guard, async (req, res): Promise<void> => {
  const { aiAssistantMemoriesTable } = await import("@workspace/db");
  const id = Number(req.params.id);
  await db.delete(aiAssistantMemoriesTable).where(eq(aiAssistantMemoriesTable.id, id));
  await audit(req, "ai_assistant.memory_deleted", `حذف ذاكرة ${id}`, id);
  res.json({ ok: true });
});

// ─── Organization profiles — what the assistant learned about each party ──
// The operator asked it to learn «كل شيء عن الشركة»: names, aliases, mail
// domains and the FORMATS of their document numbers. These routes make that
// knowledge visible and editable from the admin page instead of leaving it
// buried in the prompt.

// GET /ai-assistant/org-profiles — every learned profile
router.get("/ai-assistant/org-profiles", guard, async (_req, res): Promise<void> => {
  try {
    const profiles = await loadOrgProfiles(true);
    res.json({ profiles });
  } catch (err) {
    logger.error({ err }, "AI assistant: listing org profiles failed");
    res.status(500).json({ error: "تعذّر جلب البروفايلات" });
  }
});

// POST /ai-assistant/org-profiles — teach / merge a profile by hand
router.post("/ai-assistant/org-profiles", guard, async (req, res): Promise<void> => {
  const { name, aliases, domains, mailboxes, examples, notes, meaning } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: "اسم الجهة مطلوب" });
    return;
  }
  try {
    const asList = (v: unknown) =>
      Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
    const parsedExamples = Array.isArray(examples)
      ? (examples as Array<Record<string, unknown>>)
          .map((e) => ({
            number: String(e?.number ?? "").trim(),
            kind: (typeof e?.kind === "string" ? e.kind : undefined) as
              "po" | "rfq" | "invoice" | "quotation" | "other" | undefined,
          }))
          .filter((e) => e.number)
      : [];
    const formats = parsedExamples.length
      ? deriveDocumentFormats(parsedExamples, 1).map((f) => ({
          ...f,
          // A human-entered profile is authoritative, so the explanation the
          // admin typed is attached to every rule it produced.
          meaning: meaning ? String(meaning) : f.meaning,
        }))
      : [];
    const saved = await saveOrgProfile({
      slug: String(name),
      aliases: asList(aliases),
      domains: asList(domains).map((d) => d.toLowerCase()),
      mailboxes: asList(mailboxes),
      documentFormats: formats,
      notes: notes ? String(notes) : undefined,
      evidenceCount: parsedExamples.length || 1,
      sources: ["user"],
    });
    await audit(req, "ai_assistant.org_profile_saved", `تعلّم جهة: ${saved.slug}`);
    res.status(201).json(saved);
  } catch (err) {
    logger.error({ err }, "AI assistant: saving org profile failed");
    res.status(400).json({ error: "تعذّر حفظ البروفايل" });
  }
});

// DELETE /ai-assistant/org-profiles/:id — forget a profile
router.delete("/ai-assistant/org-profiles/:id", guard, async (req, res): Promise<void> => {
  const { db, aiAssistantOrgProfilesTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const id = Number(req.params.id);
  await db.delete(aiAssistantOrgProfilesTable).where(eq(aiAssistantOrgProfilesTable.id, id));
  // The prompt is built from the cached list, so dropping the row is not enough:
  // the cache must be invalidated or the deleted profile keeps being injected.
  resetOrgProfilesCache();
  await audit(req, "ai_assistant.org_profile_deleted", `حذف بروفايل جهة ${id}`, id);
  res.json({ ok: true });
});

// POST /ai-assistant/classify-number — "what is this number?"
router.post("/ai-assistant/classify-number", guard, async (req, res): Promise<void> => {
  const number = String(req.body?.number ?? "").trim();
  if (!number) {
    res.status(400).json({ error: "رقم المستند مطلوب" });
    return;
  }
  const profiles = await loadOrgProfiles();
  const hit = classifyByProfiles(number, profiles);
  res.json(
    hit
      ? {
          matched: true,
          organization: hit.profile.slug,
          kind: hit.rule.kind,
          pattern: hit.rule.pattern,
          example: hit.rule.example,
          meaning: hit.rule.meaning ?? null,
        }
      : { matched: false, number },
  );
});

// ─── GET /ai-assistant/jobs — recent async jobs (all phones) ──────────────
router.get("/ai-assistant/jobs", guard, async (req, res): Promise<void> => {
  try {
    const { db, aiAssistantJobsTable } = await import("@workspace/db");
    const { desc } = await import("drizzle-orm");
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const rows = await db
      .select()
      .from(aiAssistantJobsTable)
      .orderBy(desc(aiAssistantJobsTable.createdAt))
      .limit(limit);
    res.json({ jobs: rows, counts: await countJobsByStatus() });
  } catch (err) {
    logger.error({ err }, "AI assistant: listing jobs failed");
    res.status(500).json({ error: "تعذّر جلب المهام" });
  }
});

export default router;
