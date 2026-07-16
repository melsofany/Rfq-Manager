import { Router, type IRouter } from "express";
  import { HealthCheckResponse } from "@workspace/api-zod";
  import { verifyEmailConnection } from "../lib/email";
  import { requireAuth } from "../middlewares/auth";

  const router: IRouter = Router();

  router.get("/healthz", (_req, res) => {
    const data = HealthCheckResponse.parse({ status: "ok" });
    res.json(data);
  });

  router.get("/healthz/email", requireAuth, async (_req, res): Promise<void> => {
    const result = await verifyEmailConnection();
    res.status(result.ok ? 200 : 500).json({
      smtp_host: process.env.SMTP_HOST || "smtp.gmail.com",
      smtp_port: process.env.SMTP_PORT || "587",
      smtp_user: process.env.SMTP_USER || "(not set)",
      smtp_pass_set: !!process.env.SMTP_PASS,
      connected: result.ok,
      error: result.error ?? null,
    });
  });

  // No auth — diagnostic only, reveals no secrets
  router.get("/healthz/whatsapp", async (_req, res): Promise<void> => {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const waToken = process.env.WHATSAPP_TOKEN;
    const waBaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    const apiVersion = "v22.0";

    if (!phoneNumberId || !waToken) {
      res.status(500).json({
        ok: false,
        error: "WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_TOKEN not set",
      });
      return;
    }

    try {
      const phoneRes = await fetch(
        `https://graph.facebook.com/${apiVersion}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,status`,
        { headers: { Authorization: `Bearer ${waToken}` } },
      );
      const phoneJson = await phoneRes.json() as Record<string, unknown>;

      let templates: unknown = null;
      if (waBaId) {
        const tplRes = await fetch(
          `https://graph.facebook.com/${apiVersion}/${waBaId}/message_templates?fields=name,status,language,category`,
          { headers: { Authorization: `Bearer ${waToken}` } },
        );
        templates = await tplRes.json();
      }

      res.json({
        ok: phoneRes.ok,
        phone_details: phoneJson,
        template_pdf: process.env.WHATSAPP_TEMPLATE_PDF || "rfq_pdf_ar",
        template_text: process.env.WHATSAPP_TEMPLATE_TEXT || "rfq_supplier_alert",
        templates,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  export default router;
  