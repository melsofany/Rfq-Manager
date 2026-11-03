/**
 * Public website content endpoint — واجهة عامة لمحتوى الموقع.
 *
 * The static site fetches this at load time to render the copy an admin edits in
 * the portal. It is intentionally unauthenticated (the site is public) and
 * CORS-open (the site is a different origin from the portal API), and it only
 * ever exposes the published content — never the settings row, its author or the
 * deploy log.
 */
import { Router, type IRouter } from "express";
import { loadWebsiteSettings } from "./store";

const router: IRouter = Router();

// The site is served from a different origin than this API, so allow any origin
// for this read-only endpoint (no credentials, no cookies).
function allowPublicCors(_req: unknown, res: { setHeader: (k: string, v: string) => void }) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=60");
}

router.get("/public/website", async (req, res) => {
  try {
    allowPublicCors(req, res);
    const s = await loadWebsiteSettings();
    res.json({
      enabled: s.enabled,
      maintenanceMode: s.maintenanceMode,
      maintenanceMessage: s.maintenanceMessage,
      content: s.content,
      updatedAt: s.updatedAt,
    });
  } catch (err) {
    req.log?.error({ err }, "Public website content read failed");
    res.status(500).json({ error: "تعذّر جلب محتوى الموقع" });
  }
});

export default router;
