/**
 * Accounts Module — الحسابات
 *
 * Realized-margin accounting: joins customer PO selling prices with the actual
 * supplier cost (from goods receipts) to surface profit/loss per line.
 *
 * Routes mounted:
 *   GET /accounts/margins
 *   GET /accounts/margins/summary
 */
import { Router, type IRouter } from "express";
import accountsRouter from "./routes";

const router: IRouter = Router();
router.use(accountsRouter);

export default router;
