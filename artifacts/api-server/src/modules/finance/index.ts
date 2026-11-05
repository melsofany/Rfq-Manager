/**
 * Finance Module — الماليات
 *
 * Supplier payment requests: which purchase orders are to be paid, what each
 * supplier is owed, and whether the payment was made.
 */
import { Router, type IRouter } from "express";
import financeRouter from "./routes";

const router: IRouter = Router();
router.use(financeRouter);

export default router;
