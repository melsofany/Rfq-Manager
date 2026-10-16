/**
 * HR module — الموظفون والحضور بالبصمة.
 * ADMS device endpoints (/api/iclock/*) are public but SN-gated; the HR API
 * (/api/hr/*) requires a logged-in employee with the `hr` permission.
 */
import { Router, type IRouter } from "express";
import hrRoutes from "./routes";
import admsRouter from "./adms";
import leaveRouter from "./leave-routes";
import disciplineRouter from "./discipline-routes";
import onboardingRouter from "./onboarding-routes";
import settingsRouter from "./settings-routes";
import payrollRouter from "./payroll-routes";
import settlementRouter from "./settlement-routes";
import bankTransferRouter from "./bank-transfer-routes";
import reportsRouter from "./reports-routes";

const router: IRouter = Router();
router.use(admsRouter);
router.use(hrRoutes);
router.use(leaveRouter);
router.use(disciplineRouter);
router.use(onboardingRouter);
router.use(settingsRouter);
router.use(payrollRouter);
router.use(settlementRouter);
router.use(bankTransferRouter);
router.use(reportsRouter);

export default router;
