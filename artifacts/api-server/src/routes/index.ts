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
import customerRfqModule from "../modules/customer-rfq/index";
import customerPoModule from "../modules/customer-po/index";
import poModule from "../modules/po/index";
import accountsBridgeModule from "../modules/accounts-bridge/index";
// DEPRECATED: the home-grown ledger. Kept mounted until Odoo is verified
// working in production — see modules/accounts/DEPRECATED.md. New accounts
// reads must go through accountsBridgeModule (Odoo) instead.
import accountsModule from "../modules/accounts/index";
import expensesModule from "../modules/expenses/index";
import collectionsModule from "../modules/collections/index";
import usersModule from "../modules/users/index";
import reportsModule from "../modules/reports/index";
import communicationsModule from "../modules/communications/index";
import aiAssistantModule from "../modules/ai-assistant/index";
import integrationsModule from "../modules/integrations/index";
import chatwootModule from "../modules/chatwoot/index";
import backupModule from "../modules/backup/index";
import hrModule from "../modules/hr/index";

const router: IRouter = Router();

// Infrastructure
router.use(healthRouter);

// Business modules
router.use(usersModule); // auth · suppliers · categories · customers
router.use(rfqModule); // rfq · offers · pricing · items
router.use(customerRfqModule); // customer-rfq intake
router.use(customerPoModule); // customer purchase orders
router.use(poModule); // purchase-orders
// Odoo bridge FIRST: it owns /accounts/sync-status, /accounts/odoo/* and
// /accounts/bridge/*. The deprecated ledger module is mounted after it and
// keeps its own distinct /accounts/* paths.
router.use(accountsBridgeModule); // Odoo bridge — sync status + Odoo reads
router.use(accountsModule); // DEPRECATED ledger · realized margins · Egyptian tax
router.use(expensesModule); // operating expenses
router.use(collectionsModule); // customer collection tracking
router.use(reportsModule); // analytics · audit · sync
router.use(communicationsModule); // whatsapp (legacy — kept read-only as backup)
router.use(aiAssistantModule); // AI assistant (admin/manager WhatsApp agent)
router.use(chatwootModule); // chatwoot SSO bridge for the /whatsapp inbox
router.use(integrationsModule); // ERP integrations (Odoo · SAP · Oracle · Google Sheets)
router.use(backupModule); // daily DB backup → Google Drive
router.use(hrModule); // HR · employees · fingerprint attendance (ADMS)

export default router;
