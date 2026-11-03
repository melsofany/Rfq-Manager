/**
 * Website module routes — إدارة الموقع الإلكتروني.
 *
 * Admin routes (page permission `website`, writes need `website:edit`):
 *   GET  /website/settings        → content + flags + last edit info
 *   PUT  /website/settings        → update content / kill-switch / maintenance
 *   GET  /website/deploy-status   → latest Render deploy of the site
 *   POST /website/deploy          → trigger a rebuild + redeploy
 *   GET  /website/deploy-history  → recent deploys requested from the portal
 *
 * Public route (no auth — the static site reads it):
 *   GET  /public/website          → the content the site should render
 */
import { guardFor } from "../../shared/permissions";
import { Router, type IRouter } from "express";
import { db, auditLogTable, websiteDeploysTable, type WebsiteContent } from "@workspace/db";
import { desc } from "drizzle-orm";
import { requireAuth } from "../../middlewares/auth";
import { loadWebsiteSettings, updateWebsiteSettings } from "./store";
import {
  getWebsiteDeployStatus,
  triggerWebsiteDeploy,
  isWebsiteDeployConfigured,
  websiteDeployConfigProblems,
} from "./render-client";

const router: IRouter = Router();

const MAX_CONTENT_BYTES = 256 * 1024;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v.slice(0, 5000) : undefined;
}
function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x) => typeof x === "string").map((x) => (x as string).slice(0, 5000));
}

/**
 * Keep only the known sections/keys and coerce each to its expected type, so a
 * malformed or hostile payload can never store a value the site would render
 * as a non-string. Unknown keys are dropped (the schema is the contract).
 */
export function sanitizeContent(input: unknown): Partial<WebsiteContent> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const src = input as Record<string, any>;
  const out: Partial<WebsiteContent> = {};

  const obj = (k: string) =>
    src[k] && typeof src[k] === "object" && !Array.isArray(src[k])
      ? (src[k] as Record<string, unknown>)
      : undefined;

  const hero = obj("hero");
  if (hero) {
    out.hero = {
      headline: str(hero.headline) ?? "",
      subheadline: str(hero.subheadline) ?? "",
      ctaLabel: str(hero.ctaLabel) ?? "",
      ctaUrl: str(hero.ctaUrl) ?? "",
    };
  }

  const about = obj("about");
  if (about) {
    out.about = {
      heading: str(about.heading) ?? "",
      headingEn: str(about.headingEn) ?? "",
      paragraphs: strList(about.paragraphs) ?? [],
    };
  }

  const services = obj("services");
  if (services) {
    const items = Array.isArray(services.items)
      ? services.items
          .filter((i) => i && typeof i === "object")
          .map((i: Record<string, unknown>) => ({ ar: str(i.ar) ?? "", en: str(i.en) ?? "" }))
          .filter((i) => i.ar || i.en)
      : [];
    out.services = {
      heading: str(services.heading) ?? "",
      headingEn: str(services.headingEn) ?? "",
      items,
    };
  }

  const contact = obj("contact");
  if (contact) {
    out.contact = {
      phone1: str(contact.phone1) ?? "",
      phone2: str(contact.phone2) ?? "",
      email: str(contact.email) ?? "",
      addressAr: str(contact.addressAr) ?? "",
      addressEn: str(contact.addressEn) ?? "",
      mapEmbedUrl: str(contact.mapEmbedUrl) ?? "",
    };
  }

  const social = obj("social");
  if (social) {
    out.social = {
      facebook: str(social.facebook) ?? "",
      linkedin: str(social.linkedin) ?? "",
      whatsapp: str(social.whatsapp) ?? "",
      instagram: str(social.instagram) ?? "",
    };
  }

  const seo = obj("seo");
  if (seo) {
    out.seo = { title: str(seo.title) ?? "", description: str(seo.description) ?? "" };
  }

  const announcement = obj("announcement");
  if (announcement) {
    out.announcement = {
      enabled: announcement.enabled === true,
      text: str(announcement.text) ?? "",
      linkLabel: str(announcement.linkLabel) ?? "",
      linkUrl: str(announcement.linkUrl) ?? "",
    };
  }

  return out;
}

function contentSize(content: Partial<WebsiteContent>): number {
  return Buffer.byteLength(JSON.stringify(content), "utf8");
}

// ── Admin routes ───────────────────────────────────────────────────────────
router.use("/website", guardFor("/website"));

router.get("/website/settings", requireAuth, async (req, res) => {
  try {
    const s = await loadWebsiteSettings();
    res.json({
      enabled: s.enabled,
      maintenanceMode: s.maintenanceMode,
      maintenanceMessage: s.maintenanceMessage,
      content: s.content,
      updatedBy: s.updatedBy,
      updatedAt: s.updatedAt,
      deployConfigured: isWebsiteDeployConfigured(),
      deployConfigProblems: websiteDeployConfigProblems(),
    });
  } catch (err) {
    req.log?.error({ err }, "Website settings read failed");
    res.status(500).json({ error: "تعذّر جلب إعدادات الموقع" });
  }
});

router.put("/website/settings", requireAuth, async (req, res) => {
  try {
    const body = req.body ?? {};
    const patch: {
      enabled?: boolean;
      maintenanceMode?: boolean;
      maintenanceMessage?: string | null;
      content?: Partial<WebsiteContent>;
      updatedBy?: number;
    } = {};

    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.maintenanceMode === "boolean") patch.maintenanceMode = body.maintenanceMode;
    if (body.maintenanceMessage !== undefined) {
      patch.maintenanceMessage = body.maintenanceMessage ? String(body.maintenanceMessage) : null;
    }
    if (body.content !== undefined) {
      const content = sanitizeContent(body.content);
      if (contentSize(content) > MAX_CONTENT_BYTES) {
        res.status(413).json({ error: "حجم المحتوى كبير جدًا" });
        return;
      }
      patch.content = content;
    }
    patch.updatedBy = req.session.employeeId;

    await updateWebsiteSettings(patch);
    try {
      await db.insert(auditLogTable).values({
        action: "website.settings_updated",
        entityType: "website",
        employeeId: req.session.employeeId,
        description: "تحديث محتوى الموقع الإلكتروني",
      });
    } catch {
      // audit is best-effort
    }

    const s = await loadWebsiteSettings();
    res.json({
      enabled: s.enabled,
      maintenanceMode: s.maintenanceMode,
      maintenanceMessage: s.maintenanceMessage,
      content: s.content,
      updatedBy: s.updatedBy,
      updatedAt: s.updatedAt,
      deployConfigured: isWebsiteDeployConfigured(),
      deployConfigProblems: websiteDeployConfigProblems(),
    });
  } catch (err) {
    req.log?.error({ err }, "Website settings update failed");
    res.status(500).json({ error: "تعذّر تحديث إعدادات الموقع" });
  }
});

router.get("/website/deploy-status", requireAuth, async (req, res) => {
  try {
    res.json(await getWebsiteDeployStatus());
  } catch (err) {
    req.log?.error({ err }, "Website deploy status failed");
    res.status(500).json({ error: "تعذّر جلب حالة نشر الموقع" });
  }
});

router.get("/website/deploy-history", requireAuth, async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(websiteDeploysTable)
      .orderBy(desc(websiteDeploysTable.createdAt))
      .limit(20);
    res.json(rows);
  } catch (err) {
    req.log?.error({ err }, "Website deploy history failed");
    res.status(500).json({ error: "تعذّر جلب سجل النشر" });
  }
});

router.post("/website/deploy", requireAuth, async (req, res) => {
  if (!isWebsiteDeployConfigured()) {
    res.status(400).json({
      error: `نشر الموقع غير مُهيّأ: ${websiteDeployConfigProblems().join("، ")}`,
    });
    return;
  }
  const clearCache = req.body?.clearCache === true;
  const result = await triggerWebsiteDeploy(clearCache);

  try {
    await db.insert(websiteDeploysTable).values({
      serviceId: process.env.WEBSITE_RENDER_SERVICE_ID ?? "",
      renderDeployId: result.deployId,
      status: result.ok ? "building" : "failed",
      trigger: "manual",
      error: result.ok ? null : (result.error ?? "unknown"),
      requestedBy: req.session.employeeId,
    });
    await db.insert(auditLogTable).values({
      action: "website.deploy_triggered",
      entityType: "website",
      employeeId: req.session.employeeId,
      description: result.ok ? "تشغيل نشر الموقع" : `فشل تشغيل نشر الموقع: ${result.error}`,
    });
  } catch {
    // log rows are best-effort; the deploy request already happened
  }

  if (!result.ok) {
    res.status(502).json({ error: `فشل تشغيل النشر: ${result.error ?? "غير معروف"}` });
    return;
  }
  res.json({ ok: true, deployId: result.deployId });
});

export default router;
