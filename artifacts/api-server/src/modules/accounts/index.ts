/**
 * Accounts Module — الحسابات
 *
 * Realized-margin accounting: joins customer PO selling prices with the actual
 * supplier cost (from goods receipts) to surface profit/loss per line.
 *
 * Routes mounted:
 *   GET /accounts/margins           — realized margins (أرباح/خسائر)
 *   GET /accounts/vat               — VAT statement (ض.ق.م 14%)
 *   GET /accounts/withholding       — خصم تحت حساب المورد (3%)
 *   GET /accounts/tax-settings      — إعدادات الضرائب المصرية
 *   PUT /accounts/tax-settings      — تحديث الإعدادات (admin/manager)
 */
import { Router, type IRouter } from "express";
import accountsRouter from "./routes";

const router: IRouter = Router();
router.use(accountsRouter);

export default router;
