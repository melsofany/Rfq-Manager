/**
 * ERP Integrations Module
 *
 * يوفر تكاملاً مع أنظمة ERP الشائعة:
 *   - Odoo          (XML-RPC API)
 *   - SAP Business One (Service Layer)
 *   - SAP S/4HANA  (OData v4)
 *   - Oracle ERP Cloud (REST API)
 *   - Google Sheets (googleapis)
 *
 * Routes mounted:
 *   GET    /integrations
 *   POST   /integrations
 *   GET    /integrations/:id
 *   PATCH  /integrations/:id
 *   DELETE /integrations/:id
 *   POST   /integrations/:id/test
 *   POST   /integrations/:id/sync
 *   POST   /integrations/:id/sync-suppliers
 *   POST   /integrations/:id/export
 */

import { Router, type IRouter } from "express";
import integrationsRouter from "./routes";

const router: IRouter = Router();
router.use(integrationsRouter);

export default router;
