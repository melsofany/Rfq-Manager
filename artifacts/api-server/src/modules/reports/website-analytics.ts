/**
 * Website analytics — زيارات الموقع الإلكتروني
 *
 * Reads the public company website's traffic from PostHog (the static site at
 * cortoba-supplies.com sends `$pageview` events). The PostHog personal API key
 * stays on the server; the browser only receives aggregated numbers.
 *
 * Env (Render, this service):
 *   POSTHOG_PERSONAL_API_KEY  — personal key with query read access
 *   POSTHOG_PROJECT_ID        — numeric project id
 *   POSTHOG_HOST              — optional, defaults to https://us.posthog.com
 *
 * Routes (behind requireAuth + the "analytics" permission):
 *   GET /website-analytics/summary      — visits and unique visitors, last 7 and 30 days
 *   GET /website-analytics/trend        — ?granularity=week (12 weeks) | month (12 months)
 *   GET /website-analytics/countries    — last 30 days by country
 *   GET /website-analytics/egypt        — last 30 days, Egyptian governorates
 */
import { Router } from "express";
import { requireAuth } from "../../middlewares/auth";
import { guardFor } from "../../shared/permissions";

const router = Router();
router.use("/website-analytics", guardFor("/website-analytics"));

const HOST = (process.env.POSTHOG_HOST ?? "https://us.posthog.com").replace(/\/$/, "");

type Row = Record<string, unknown>;

/** Runs a HogQL query. Only fixed query text is sent — no request input is interpolated. */
async function hogql(query: string): Promise<Row[]> {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  const project = process.env.POSTHOG_PROJECT_ID;
  if (!key || !project) throw new NotConfigured();
  const res = await fetch(`${HOST}/api/projects/${project}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`PostHog responded ${res.status}`);
  const body = (await res.json()) as { results: unknown[][]; columns: string[] };
  return body.results.map((r) => Object.fromEntries(body.columns.map((c, i) => [c, r[i]])));
}

class NotConfigured extends Error {}

function send(res: import("express").Response, fn: () => Promise<unknown>): Promise<void> {
  return fn().then(
    (data) => {
      res.json(data);
    },
    (err: unknown) => {
      if (err instanceof NotConfigured) {
        res.status(503).json({ error: "not_configured" });
        return;
      }
      console.error("website analytics:", err);
      res.status(502).json({ error: "posthog_unavailable" });
    },
  );
}

const PAGEVIEW = "event = '$pageview'";

router.get("/website-analytics/summary", requireAuth, (_req, res) =>
  send(res, async () => {
    const rows = await hogql(`
      SELECT
        countIf(timestamp >= now() - INTERVAL 7 DAY) AS views7,
        uniqIf(person_id, timestamp >= now() - INTERVAL 7 DAY) AS visitors7,
        countIf(timestamp >= now() - INTERVAL 30 DAY) AS views30,
        uniqIf(person_id, timestamp >= now() - INTERVAL 30 DAY) AS visitors30
      FROM events WHERE ${PAGEVIEW} AND timestamp >= now() - INTERVAL 30 DAY`);
    const r = rows[0] ?? {};
    return {
      last7: { views: Number(r.views7 ?? 0), visitors: Number(r.visitors7 ?? 0) },
      last30: { views: Number(r.views30 ?? 0), visitors: Number(r.visitors30 ?? 0) },
    };
  }),
);

router.get("/website-analytics/trend", requireAuth, (req, res) =>
  send(res, async () => {
    const monthly = req.query.granularity === "month";
    const bucket = monthly ? "toStartOfMonth(timestamp)" : "toStartOfWeek(timestamp)";
    const window = monthly ? "12 MONTH" : "12 WEEK";
    const rows = await hogql(`
      SELECT ${bucket} AS period, count() AS views, uniq(person_id) AS visitors
      FROM events WHERE ${PAGEVIEW} AND timestamp >= now() - INTERVAL ${window}
      GROUP BY period ORDER BY period`);
    return rows.map((r) => ({
      period: String(r.period),
      views: Number(r.views),
      visitors: Number(r.visitors),
    }));
  }),
);

router.get("/website-analytics/countries", requireAuth, (_req, res) =>
  send(res, async () => {
    const rows = await hogql(`
      SELECT coalesce(properties.$geoip_country_name, 'غير معروف') AS country,
             count() AS views, uniq(person_id) AS visitors
      FROM events WHERE ${PAGEVIEW} AND timestamp >= now() - INTERVAL 30 DAY
      GROUP BY country ORDER BY views DESC LIMIT 25`);
    return rows.map((r) => ({
      country: String(r.country),
      views: Number(r.views),
      visitors: Number(r.visitors),
    }));
  }),
);

router.get("/website-analytics/egypt", requireAuth, (_req, res) =>
  send(res, async () => {
    const rows = await hogql(`
      SELECT coalesce(properties.$geoip_subdivision_1_name, 'غير معروف') AS governorate,
             count() AS views, uniq(person_id) AS visitors
      FROM events
      WHERE ${PAGEVIEW} AND timestamp >= now() - INTERVAL 30 DAY
        AND properties.$geoip_country_code = 'EG'
      GROUP BY governorate ORDER BY views DESC LIMIT 40`);
    return rows.map((r) => ({
      governorate: String(r.governorate),
      views: Number(r.views),
      visitors: Number(r.visitors),
    }));
  }),
);

export default router;
