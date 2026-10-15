/**
 * RFQ Module — طلبات عروض الأسعار
 *
 * Covers: RFQ lifecycle, supplier offers, token-based pricing,
 *         item catalogue, RFQ PDFs, and offers PDFs.
 *
 * Routes mounted:
 *   GET/POST /rfq
 *   GET/POST /rfq/:id
 *   GET/POST /offers
 *   GET/POST /pricing / /q/:token
 *   GET/POST /items
 */
import { Router, type IRouter } from "express";
import rfqRouter from "./routes";
import offersRouter from "./offers";
import pricingRouter from "./pricing";
import itemsRouter from "./items";
import itemAnalysisRouter from "./item-analysis";
import attachmentsRouter from "./attachments";
import itemCategoriesRouter from "./item-categories";
import assignmentsRouter from "./assignments";

const router: IRouter = Router();

router.use(rfqRouter);
router.use(offersRouter);
router.use(pricingRouter);
router.use(itemsRouter);
router.use(itemAnalysisRouter);
router.use(attachmentsRouter);
router.use(itemCategoriesRouter);
router.use(assignmentsRouter);

export default router;
