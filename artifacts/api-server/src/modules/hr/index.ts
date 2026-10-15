/**
 * HR module — الموظفون والحضور بالبصمة.
 * ADMS device endpoints (/api/iclock/*) are public but SN-gated; the HR API
 * (/api/hr/*) requires a logged-in employee with the `hr` permission.
 */
import { Router, type IRouter } from "express";
import hrRoutes from "./routes";
import admsRouter from "./adms";

const router: IRouter = Router();
router.use(admsRouter);
router.use(hrRoutes);

export default router;
