/**
 * HR settings API — إعدادات التأمينات والضرايب والغياب والجزاءات والبدلات والبنك.
 *
 *   GET /api/hr/settings           all keys (null = not configured yet)
 *   PUT /api/hr/settings/:key      { value }  replaces the key's value after validation
 */
import { Router, type IRouter } from "express";
import { db, hrSettingsTable } from "@workspace/db";
import { requireAuth } from "../../middlewares/auth";
import { requireHr } from "./routes";
import { SETTING_KEYS, isSettingKey, validateSetting } from "./settings-logic";

const router: IRouter = Router();
router.use("/hr", requireAuth, requireHr);

router.get("/hr/settings", async (_req, res): Promise<void> => {
  const rows = await db.select().from(hrSettingsTable);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const settings: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) settings[k] = byKey.get(k) ?? null;
  res.json({
    settings,
    updatedAt: rows.reduce<string | null>((max, r) => {
      const iso = new Date(r.updatedAt).toISOString();
      return !max || iso > max ? iso : max;
    }, null),
  });
});

router.put("/hr/settings/:key", async (req, res): Promise<void> => {
  const key = String(req.params.key);
  if (!isSettingKey(key)) {
    res.status(404).json({ error: "إعداد غير معروف" });
    return;
  }
  const result = validateSetting(key, req.body?.value ?? null);
  if ("error" in result) {
    res.status(400).json({ error: result.error });
    return;
  }
  await db
    .insert(hrSettingsTable)
    .values({ key, value: result.value as object, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: hrSettingsTable.key,
      set: { value: result.value as object, updatedAt: new Date() },
    });
  res.json({ key, value: result.value });
});

export default router;
