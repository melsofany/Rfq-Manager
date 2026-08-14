/**
 * Operating Expenses Module — مصروفات الشركة التشغيلية
 *
 * Routes mounted (via routes/index.ts):
 *   GET/POST /expenses, GET /expenses/summary, GET/PATCH/DELETE /expenses/:id,
 *   attachment upload/download/delete.
 */
import { Router, type IRouter } from "express";
import expensesRouter from "./routes";

const router: IRouter = Router();
router.use(expensesRouter);

export default router;
