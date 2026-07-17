/**
 * ERP Integrations Routes
 * /api/integrations/*
 */

import { Router } from "express";
import { requireAuth, requireRole } from "../../middlewares/auth";
import * as svc from "./service";

const router = Router();

/** GET /integrations — قائمة كل التكاملات */
router.get("/integrations", requireAuth, async (_req, res): Promise<void> => {
  const integrations = await svc.listIntegrations();
  // إخفاء كلمات المرور والـ API keys من الاستجابة
  res.json(integrations.map(maskSecrets));
});

/** GET /integrations/:id — تفاصيل تكامل واحد */
router.get("/integrations/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const integration = await svc.getIntegration(id);
  if (!integration) { res.status(404).json({ error: "التكامل غير موجود" }); return; }
  res.json(maskSecrets(integration));
});

/** POST /integrations — إنشاء تكامل جديد (admin/manager) */
router.post("/integrations", requireRole("admin", "manager"), async (req, res): Promise<void> => {
  const { name, type, config } = req.body as { name: string; type: svc.ErpType; config: Record<string, unknown> };
  if (!name || !type || !config) {
    res.status(400).json({ error: "name, type, config مطلوبة" });
    return;
  }
  const validTypes: svc.ErpType[] = ["odoo", "sap-b1", "sap-s4hana", "oracle", "google-sheets"];
  if (!validTypes.includes(type)) {
    res.status(400).json({ error: `نوع غير مدعوم. الأنواع المتاحة: ${validTypes.join(", ")}` });
    return;
  }
  const integration = await svc.createIntegration({ name, type, config });
  res.status(201).json(maskSecrets(integration));
});

/** PATCH /integrations/:id — تعديل تكامل */
router.patch("/integrations/:id", requireRole("admin", "manager"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const updated = await svc.updateIntegration(id, req.body);
  if (!updated) { res.status(404).json({ error: "التكامل غير موجود" }); return; }
  res.json(maskSecrets(updated));
});

/** DELETE /integrations/:id — حذف تكامل */
router.delete("/integrations/:id", requireRole("admin", "manager"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const deleted = await svc.deleteIntegration(id);
  if (!deleted) { res.status(404).json({ error: "التكامل غير موجود" }); return; }
  res.status(204).end();
});

/** POST /integrations/:id/test — اختبار الاتصال */
router.post("/integrations/:id/test", requireRole("admin", "manager"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const integration = await svc.getIntegration(id);
  if (!integration) { res.status(404).json({ error: "التكامل غير موجود" }); return; }
  const result = await svc.testConnection(integration);
  res.json(result);
});

/** POST /integrations/:id/sync — تشغيل المزامنة */
router.post("/integrations/:id/sync", requireRole("admin", "manager"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const integration = await svc.getIntegration(id);
  if (!integration) { res.status(404).json({ error: "التكامل غير موجود" }); return; }
  if (!integration.isActive) { res.status(400).json({ error: "التكامل غير مفعّل" }); return; }

  // ابدأ المزامنة في الخلفية واستجب فوراً
  res.json({ message: "بدأت المزامنة", integrationId: id });
  svc.runSync(id).catch((e) => {
    // logged inside runSync
    void e;
  });
});

/** POST /integrations/:id/sync-suppliers — استيراد الموردين فقط */
router.post("/integrations/:id/sync-suppliers", requireRole("admin", "manager"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const integration = await svc.getIntegration(id);
  if (!integration) { res.status(404).json({ error: "التكامل غير موجود" }); return; }
  try {
    const stats = await svc.syncSuppliers(integration);
    res.json({ success: true, ...stats });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /integrations/:id/export — تصدير البيانات للـ ERP */
router.post("/integrations/:id/export", requireRole("admin", "manager"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  const integration = await svc.getIntegration(id);
  if (!integration) { res.status(404).json({ error: "التكامل غير موجود" }); return; }
  try {
    const stats = await svc.syncToErp(integration);
    res.json({ success: true, ...stats });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ─── إخفاء البيانات الحساسة ─────────────────────────────────────────────────
function maskSecrets(integration: svc.ErpIntegration): svc.ErpIntegration {
  const sensitiveKeys = ["password", "apiKey", "serviceAccountBase64", "apiSecret", "token"];
  const maskedConfig: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(integration.config)) {
    maskedConfig[k] = sensitiveKeys.some((s) => k.toLowerCase().includes(s.toLowerCase()))
      ? (v ? "••••••••" : "")
      : v;
  }
  return { ...integration, config: maskedConfig };
}

export default router;
