/**
 * Field Operations module — العمليات الميدانية
 *
 * Two mounting surfaces, on purpose:
 *   • `/api/mobile/*`      — the Android app (bearer token). Public paths are
 *                            only /auth/login and /auth/health.
 *   • `/api/hr/field-*`    — HR administration, guarded by the HR permission so
 *                            the same staff who manage employees manage reps.
 */
import { Router, type IRouter } from "express";
import mobileAuthRouter from "./mobile-auth-routes";
import mobileRoutes from "./mobile-routes";
import mobileDashboardRouter from "./mobile-dashboard-routes";
import hrFieldAssignmentRouter from "./hr-field-assignment-routes";

const router: IRouter = Router();

// Mobile auth is unauthenticated by design (it is what issues the token); the
// other mobile routers enforce the bearer token themselves.
router.use("/mobile", mobileAuthRouter);
router.use("/mobile", mobileRoutes);
router.use("/mobile", mobileDashboardRouter);

// HR-side administration. Mounted at the root of the HR permission surface:
// the HR module's own `requireAuth + requireHr` guard is applied by the HR
// router, and this router is mounted AFTER it in modules/hr/index.ts.
router.use(hrFieldAssignmentRouter);

export default router;
