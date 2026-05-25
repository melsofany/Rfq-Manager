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

  router.get("/healthz/whatsapp", requireAuth, async (_req, res): Promise<void> => {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const waToken = process.env.WHATSAPP_TOKEN;
    const apiVersion = "v22.0";

    if (!phoneNumberId || !waToken) {
      res.status(500).json({
        ok: false,
        error: "WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_TOKEN not set",
        phone_number_id_set: !!phoneNumberId,
        token_set: !!waToken,
      });
      return;
    }

    try {
      // Fetch phone number details — validates token without sending a message
      const r = await fetch(
        `https://graph.facebook.com/${apiVersion}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,status`,
        { headers: { Authorization: `Bearer ${waToken}` } },
      );
      const json = await r.json() as Record<string, unknown>;
      if (!r.ok) {
        res.status(r.status).json({ ok: false, http_status: r.status, wa_response: json });
        return;
      }
      res.json({ ok: true, phone_number_id: phoneNumberId, details: json });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  export default router;
  