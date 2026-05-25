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

export default router;
