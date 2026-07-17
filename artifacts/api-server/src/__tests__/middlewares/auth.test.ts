import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireAuth, requireRole } from "../../middlewares/auth";

/**
 * Helpers — build minimal fakes without needing express
 */
function makeReq(session?: Record<string, unknown>): Request {
  return { session } as unknown as Request;
}

function makeRes() {
  const json = vi.fn().mockReturnThis();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json } as unknown as Response;
}

// ── requireAuth ─────────────────────────────────────────────────────────────
describe("requireAuth", () => {
  it("calls next() when session.employeeId is set", () => {
    const next = vi.fn() as NextFunction;
    requireAuth(makeReq({ employeeId: 1 }), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 401 when session is absent", () => {
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireAuth(makeReq(undefined), res, next);
    expect(res.status as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when employeeId is 0 (falsy)", () => {
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireAuth(makeReq({ employeeId: 0 }), res, next);
    expect(res.status as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(401);
  });

  it("returns 401 when employeeId is null", () => {
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireAuth(makeReq({ employeeId: null }), res, next);
    expect(res.status as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(401);
  });

  it("does not call next() when returning 401", () => {
    const next = vi.fn() as NextFunction;
    requireAuth(makeReq({}), makeRes(), next);
    expect(next).not.toHaveBeenCalled();
  });
});

// ── requireRole ─────────────────────────────────────────────────────────────
describe("requireRole", () => {
  it("calls next() when role matches exactly", () => {
    const next = vi.fn() as NextFunction;
    requireRole("admin")(makeReq({ employeeId: 1, role: "admin" }), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("calls next() when role is one of multiple allowed roles", () => {
    const next = vi.fn() as NextFunction;
    requireRole("admin", "manager", "finance")(
      makeReq({ employeeId: 1, role: "manager" }),
      makeRes(),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 403 when authenticated but role does not match", () => {
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireRole("admin")(makeReq({ employeeId: 1, role: "viewer" }), res, next);
    expect(res.status as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when role is undefined and not in allowed list", () => {
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireRole("admin")(makeReq({ employeeId: 1 }), res, next);
    expect(res.status as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(403);
  });

  it("returns 401 when not authenticated at all", () => {
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireRole("admin")(makeReq(undefined), res, next);
    expect(res.status as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("is case-sensitive — viewer != Viewer", () => {
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireRole("Viewer")(makeReq({ employeeId: 1, role: "viewer" }), res, next);
    expect(res.status as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(403);
  });
});
