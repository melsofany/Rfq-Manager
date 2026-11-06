/**
 * مصادقة تطبيق الموبايل — bearer-token authentication for /api/mobile/*.
 *
 * Deliberately NOT the portal's cookie session: a phone is a different client
 * with a different threat model. The token is an opaque 32-byte random value
 * whose SHA-256 hash is the only thing stored, so a database dump yields no
 * usable credential, and the server — not the client — decides expiry.
 */
import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, hrEmployeesTable, mobileSessionsTable } from "@workspace/db";
import { loadFieldOpsSettings } from "./service";

/** Session lifetime. Long enough for a working day plus offline gaps. */
export const MOBILE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface MobileActor {
  /** hr_employees.id */
  hrEmployeeId: number;
  employeeNo: string;
  fullName: string;
  fullNameEn: string | null;
  jobTitle: string | null;
  department: string | null;
  phone: string | null;
  sessionId: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      mobileActor?: MobileActor;
    }
  }
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Issue a fresh opaque token. Returns the raw token (shown once) + its hash.
 * `ttlMs` lets the caller apply the administrator's configured session length;
 * it defaults to the module constant so existing callers are unaffected.
 */
export function issueToken(ttlMs: number = MOBILE_SESSION_TTL_MS): {
  token: string;
  tokenHash: string;
  expiresAt: Date;
} {
  const token = crypto.randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlMs),
  };
}

function bearerToken(req: Request): string | null {
  const header = req.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Resolve the caller from the bearer token. Re-checks HR status and mobile
 * access on EVERY request, so revoking access or marking an employee resigned
 * takes effect immediately instead of at token expiry.
 */
export async function loadMobileActor(req: Request): Promise<MobileActor | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const tokenHash = hashToken(token);

  const [row] = await db
    .select({
      sessionId: mobileSessionsTable.id,
      hrEmployeeId: hrEmployeesTable.id,
      employeeNo: hrEmployeesTable.employeeNo,
      fullName: hrEmployeesTable.fullName,
      fullNameEn: hrEmployeesTable.fullNameEn,
      jobTitle: hrEmployeesTable.jobTitle,
      department: hrEmployeesTable.department,
      phone: hrEmployeesTable.phone,
      status: hrEmployeesTable.status,
      mobileAccessEnabled: hrEmployeesTable.mobileAccessEnabled,
    })
    .from(mobileSessionsTable)
    .innerJoin(hrEmployeesTable, eq(mobileSessionsTable.hrEmployeeId, hrEmployeesTable.id))
    .where(
      and(
        eq(mobileSessionsTable.tokenHash, tokenHash),
        isNull(mobileSessionsTable.revokedAt),
        gt(mobileSessionsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!row) return null;
  // Access revoked or employee left: the token is refused from now on.
  if (row.status !== "active" || !row.mobileAccessEnabled) return null;

  // Best-effort touch; never blocks the request.
  void db
    .update(mobileSessionsTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(mobileSessionsTable.id, row.sessionId))
    .catch(() => {});

  return {
    hrEmployeeId: row.hrEmployeeId,
    employeeNo: row.employeeNo,
    fullName: row.fullName,
    fullNameEn: row.fullNameEn,
    jobTitle: row.jobTitle,
    department: row.department,
    phone: row.phone,
    sessionId: row.sessionId,
  };
}

/** Express middleware: 401 unless a valid mobile session is present. */
export async function requireMobileAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actor = await loadMobileActor(req);
    if (!actor) {
      res.status(401).json({ error: "انتهت الجلسة. برجاء تسجيل الدخول مرة أخرى" });
      return;
    }
    req.mobileActor = actor;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware for the mobile OPERATION surface (pickups, deliveries, dashboard):
 * refuse work while the administrator has maintenance mode on.
 *
 * Maintenance has to be enforced here, not only reported by `/me`, because a
 * representative with an offline queue will otherwise keep confirming receipts
 * against a system the operator believes is frozen. Account-level routes
 * (logout, change-password, me) deliberately do NOT use this gate — a locked
 * user must still be able to read the flag and sign out.
 */
export async function requireMobileOperationsEnabled(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const settings = await loadFieldOpsSettings();
    if (settings.maintenanceMode) {
      res.status(503).json({
        error: "النظام في وضع الصيانة حالياً. برجاء المحاولة لاحقاً",
        code: "MAINTENANCE_MODE",
      });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Read the actor inside a handler that ran through `requireMobileAuth`. */
export function actorOf(req: Request): MobileActor {
  const actor = req.mobileActor;
  if (!actor) throw new Error("actorOf called without requireMobileAuth");
  return actor;
}
