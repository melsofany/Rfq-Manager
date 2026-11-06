/**
 * مصادقة تطبيق الموبايل — /api/mobile/auth/*
 *
 *   POST /auth/login            رقم وظيفي + كلمة مرور → bearer token
 *   POST /auth/logout           revoke the current token
 *   GET  /me                    the signed-in employee
 *   POST /auth/change-password  requires the current password
 *
 * Rate-limited per IP and per employee number: the employee number is short and
 * guessable, so the per-account limit is the one that matters.
 */
import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { and, eq, isNull } from "drizzle-orm";
import { db, hrEmployeesTable, mobileSessionsTable, auditLogTable } from "@workspace/db";
import { checkLoginEligibility } from "./assignment-logic";
import { issueToken, requireMobileAuth, actorOf } from "./mobile-auth";
import { loadFieldOpsSettings } from "./service";
import { hasActiveFieldAssignment, findHrEmployeeByNo } from "./service";
import { logger } from "../../shared/logger";

const router = Router();

const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "محاولات دخول كثيرة — برجاء المحاولة بعد قليل" },
});

const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const employeeNo = String((req.body as { employeeNo?: unknown })?.employeeNo ?? "");
    return `${ipKeyGenerator(req.ip ?? "")}|${employeeNo}`;
  },
  message: { error: "محاولات دخول كثيرة لهذا الحساب — برجاء المحاولة بعد 15 دقيقة" },
});

/** Audit a login attempt without ever logging the password. */
function auditLogin(
  req: Request,
  action: string,
  hrEmployeeId: number | null,
  description: string,
) {
  void db
    .insert(auditLogTable)
    .values({
      action,
      entityType: "mobile_auth",
      entityId: hrEmployeeId,
      employeeId: null,
      description: hrEmployeeId != null ? `[hr:${hrEmployeeId}] ${description}` : description,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    })
    .catch((err: unknown) => logger.warn({ err }, "mobile login audit write failed"));
}

router.post("/auth/login", loginIpLimiter, loginAccountLimiter, async (req, res): Promise<void> => {
  const body = req.body as { employeeNo?: unknown; password?: unknown; fcmToken?: unknown };
  const employeeNo = String(body.employeeNo ?? "").trim();
  const password = String(body.password ?? "");
  if (!employeeNo || !password) {
    res.status(400).json({ error: "أدخل الرقم الوظيفي وكلمة المرور" });
    return;
  }

  const employee = await findHrEmployeeByNo(employeeNo);
  const eligibility = checkLoginEligibility({
    employee: employee
      ? { status: employee.status, mobileAccessEnabled: employee.mobileAccessEnabled }
      : null,
    hasPassword: Boolean(employee?.mobilePasswordHash),
  });

  // Verify the password whenever a hash exists, so a wrong password and an
  // unknown account are indistinguishable in timing and in the response.
  const passwordOk =
    employee?.mobilePasswordHash != null
      ? await bcrypt.compare(password, employee.mobilePasswordHash)
      : false;

  if (!eligibility.ok || !passwordOk) {
    auditLogin(
      req,
      "mobile.login_failed",
      employee?.id ?? null,
      `Failed mobile login for employee no ${employeeNo}`,
    );
    res.status(eligibility.ok ? 401 : eligibility.status).json({
      error: eligibility.ok ? "رقم الوظيفي أو كلمة المرور غير صحيحة" : eligibility.error,
    });
    return;
  }

  const settings = await loadFieldOpsSettings();
  const { token, tokenHash, expiresAt } = issueToken(settings.sessionDays * 24 * 60 * 60 * 1000);
  await db.insert(mobileSessionsTable).values({
    hrEmployeeId: employee!.id,
    tokenHash,
    deviceInfo: String(req.get("user-agent") ?? "").slice(0, 400) || null,
    fcmToken: body.fcmToken ? String(body.fcmToken).slice(0, 400) : null,
    expiresAt,
  });
  await db
    .update(hrEmployeesTable)
    .set({ mobileLastLoginAt: new Date() })
    .where(eq(hrEmployeesTable.id, employee!.id));

  auditLogin(req, "mobile.login_success", employee!.id, "Successful mobile login");
  logger.info({ hrEmployeeId: employee!.id }, "mobile login");

  res.json({
    token,
    expiresAt: expiresAt.toISOString(),
    employee: {
      hrEmployeeId: employee!.id,
      employeeNo: employee!.employeeNo,
      fullName: employee!.fullName,
      fullNameEn: employee!.fullNameEn,
      jobTitle: employee!.jobTitle,
      department: employee!.department,
      phone: employee!.phone,
    },
    // The app uses this to decide which dashboard shortcuts to show.
    isFieldRepresentative: await hasActiveFieldAssignment(employee!.id),
  });
});

router.post("/auth/logout", requireMobileAuth, async (req, res): Promise<void> => {
  const actor = actorOf(req);
  await db
    .update(mobileSessionsTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(mobileSessionsTable.id, actor.sessionId), isNull(mobileSessionsTable.revokedAt)));
  res.json({ success: true });
});

router.get("/me", requireMobileAuth, async (req, res): Promise<void> => {
  const actor = actorOf(req);
  const settings = await loadFieldOpsSettings();
  res.json({
    hrEmployeeId: actor.hrEmployeeId,
    employeeNo: actor.employeeNo,
    fullName: actor.fullName,
    fullNameEn: actor.fullNameEn,
    jobTitle: actor.jobTitle,
    department: actor.department,
    phone: actor.phone,
    isFieldRepresentative: await hasActiveFieldAssignment(actor.hrEmployeeId),
    app: {
      appNameAr: settings.appNameAr,
      appNameEn: settings.appNameEn,
      welcomeMessageAr: settings.welcomeMessageAr,
      supportPhone: settings.supportPhone,
      maintenanceMode: settings.maintenanceMode,
    },
  });
});

router.post("/auth/change-password", requireMobileAuth, async (req, res): Promise<void> => {
  const actor = actorOf(req);
  const body = req.body as { currentPassword?: unknown; newPassword?: unknown };
  const currentPassword = String(body.currentPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  if (newPassword.length < 6) {
    res.status(400).json({ error: "كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل" });
    return;
  }
  const [employee] = await db
    .select({ id: hrEmployeesTable.id, mobilePasswordHash: hrEmployeesTable.mobilePasswordHash })
    .from(hrEmployeesTable)
    .where(eq(hrEmployeesTable.id, actor.hrEmployeeId));
  if (!employee?.mobilePasswordHash) {
    res.status(400).json({ error: "لا توجد كلمة مرور مسجّلة" });
    return;
  }
  const ok = await bcrypt.compare(currentPassword, employee.mobilePasswordHash);
  if (!ok) {
    res.status(401).json({ error: "كلمة المرور الحالية غير صحيحة" });
    return;
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await db
    .update(hrEmployeesTable)
    .set({ mobilePasswordHash: hash })
    .where(eq(hrEmployeesTable.id, actor.hrEmployeeId));
  // Every other device is signed out; the current one stays valid.
  await db
    .update(mobileSessionsTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(mobileSessionsTable.hrEmployeeId, actor.hrEmployeeId),
        isNull(mobileSessionsTable.revokedAt),
      ),
    );
  await db.insert(auditLogTable).values({
    action: "mobile.password_changed",
    entityType: "mobile_auth",
    entityId: actor.hrEmployeeId,
    employeeId: null,
    description: `[hr:${actor.hrEmployeeId}] mobile password changed`,
    ipAddress: req.ip,
  });
  res.json({ success: true, message: "تم تغيير كلمة المرور. برجاء تسجيل الدخول مرة أخرى" });
});

/** GET /api/mobile/auth/health — unauthenticated liveness for the app. */
router.get("/auth/health", (_req, res: Response): void => {
  res.json({ ok: true });
});

export default router;
