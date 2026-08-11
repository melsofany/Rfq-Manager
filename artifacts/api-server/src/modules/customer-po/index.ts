/**
 * Customer PO Module — أوامر شراء العملاء
 *
 * Customer-side purchase orders: a customer PO can mix items sourced from
 * several customer RFQs (each item links back to its customer_rfq_item_id),
 * and the same customer RFQ item can appear on more than one customer PO
 * (partial shipments). A customer PO may also arrive with no customer RFQ
 * number — the RFQ + item links are nullable, so free/manual lines are allowed.
 *
 * Routes mounted:
 *   GET/POST   /customer-po
 *   GET/PATCH/DELETE /customer-po/:id
 *   GET        /customer-po/customer-rfqs   (light list for the picker)
 */
import { Router, type IRouter } from "express";
import customerPoRouter from "./routes";

const router: IRouter = Router();
router.use(customerPoRouter);

export default router;
