import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import suppliersRouter from "./suppliers";
import rfqRouter from "./rfq";
import pricingRouter from "./pricing";
import analyticsRouter from "./analytics";
import offersRouter from "./offers";
import auditRouter from "./audit";
import syncRouter from "./sync";
import categoriesRouter from "./categories";
import whatsappRouter from "./whatsapp";
import itemsRouter from "./items";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(suppliersRouter);
router.use(rfqRouter);
router.use(pricingRouter);
router.use(analyticsRouter);
router.use(offersRouter);
router.use(auditRouter);
router.use(syncRouter);
router.use(categoriesRouter);
router.use(whatsappRouter);
router.use(itemsRouter);

export default router;
