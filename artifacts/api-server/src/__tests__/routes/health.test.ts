import { describe, it, expect, vi, beforeAll } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock side-effectful modules before any import of the router ───────────
vi.mock("../../shared/email", () => ({
  verifyEmailConnection: vi.fn().mockResolvedValue({ ok: true }),
  sendRfqEmail: vi.fn().mockResolvedValue({ ok: true }),
  sendOfferConfirmation: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../middlewares/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

// ── Build a minimal test app with only the health router ──────────────────
let testApp: express.Express;

beforeAll(async () => {
  const { default: healthRouter } = await import("../../routes/health");
  testApp = express();
  testApp.use(express.json());
  testApp.use("/api", healthRouter);
});

describe("GET /api/healthz", () => {
  it("responds 200 with { status: 'ok' }", async () => {
    const res = await request(testApp).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("returns JSON content-type", async () => {
    const res = await request(testApp).get("/api/healthz");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});

describe("GET /api/healthz/email", () => {
  it("responds 200 when SMTP connection succeeds", async () => {
    const res = await request(testApp).get("/api/healthz/email");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("connected", true);
  });

  it("includes smtp_host and smtp_pass_set fields", async () => {
    const res = await request(testApp).get("/api/healthz/email");
    expect(res.body).toHaveProperty("smtp_host");
    expect(res.body).toHaveProperty("smtp_pass_set");
  });

  it("responds 500 when SMTP connection fails", async () => {
    const { verifyEmailConnection } = await import("../../shared/email");
    vi.mocked(verifyEmailConnection).mockResolvedValueOnce({
      ok: false,
      error: "Connection refused",
    });
    const res = await request(testApp).get("/api/healthz/email");
    expect(res.status).toBe(500);
    expect(res.body.connected).toBe(false);
    expect(res.body.error).toBe("Connection refused");
  });
});
