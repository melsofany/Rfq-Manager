/**
 * API Router — يجمع كل الـ modules في مكان واحد
 *
 * Module structure:
 *   /api/healthz          → health (liveness probe)
 *   /api/auth/*           → users  module (auth, suppliers, categories)
 *   /api/rfq/*            → rfq    module (rfq, offers, pricing, items)
 *   /api/purchase-orders  → po     module
 *   /api/analytics        → reports module (analytics, audit, sync)
 *   /api/whatsapp         → communications module
 */
import { Router, type IRouter } from "express";
import healthRouter from "./health";
import rfqModule from "../modules/rfq/index";
import poModule from "../modules/po/index";
import usersModule from "../modules/users/index";
import reportsModule from "../modules/reports/index";
import communicationsModule from "../modules/communications/index";
import integrationsModule from "../modules/integrations/index";

const router: IRouter = Router();

// Infrastructure
router.use(healthRouter);

// Business modules
router.use(usersModule); // auth · suppliers · categories
router.use(rfqModule); // rfq · offers · pricing · items
router.use(poModule); // purchase-orders
router.use(reportsModule); // analytics · audit · sync
router.use(communicationsModule); // whatsapp
router.use(integrationsModule); // ERP integrations (Odoo · SAP · Oracle · Google Sheets)

export default router;
