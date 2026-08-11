/**
 * Customer RFQ Module — طلبات تسعير العملاء
 *
 * Customer-side RFQ intake: record a customer's quotation request with its
 * line items (part no, line item, UOM, qty). The customer RFQ number is
 * auto-generated when left blank (with a warning surfaced to the user).
 *
 * Routes mounted:
 *   GET/POST   /customer-rfq
 *   GET/PATCH/DELETE /customer-rfq/:id
 */
import { Router, type IRouter } from "express";
import customerRfqRouter from "./routes";

const router: IRouter = Router();
router.use(customerRfqRouter);

export default router;
