/**
 * Purchase Orders Module — أوامر الشراء
 *
 * Covers: PO creation, detail, status updates, PDF export,
 *         Google Sheets lookup, and WhatsApp/email dispatch.
 *
 * Routes mounted:
 *   GET/POST /purchase-orders
 *   GET/PUT/DELETE /purchase-orders/:id
 */
import { Router, type IRouter } from "express";
import poRouter from "./routes";
import receiptsRouter from "./receipts";
import chargesRouter from "./charges";

const router: IRouter = Router();

router.use(poRouter);
router.use(receiptsRouter);
router.use(chargesRouter);

export default router;
