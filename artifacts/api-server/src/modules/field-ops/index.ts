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
import controlRouter from "./control-routes";

const router: IRouter = Router();

// Mobile auth is unauthenticated by design (it is what issues the token); the
// other mobile routers enforce the bearer token themselves.
router.use("/mobile", mobileAuthRouter);
router.use("/mobile", mobileRoutes);
router.use("/mobile", mobileDashboardRouter);

// HR-side administration. These routers apply their own `requireAuth +
// requireHr` guard, so they can be mounted here without leaking into the
// public mobile surface.
router.use(hrFieldAssignmentRouter);
router.use(controlRouter);

export default router;
