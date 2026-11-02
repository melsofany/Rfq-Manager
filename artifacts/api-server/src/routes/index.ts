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
import { guardByMethod } from "../shared/permissions";
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
import emailAccountsModule from "../modules/email-accounts/index";

const router: IRouter = Router();

// Infrastructure
router.use(healthRouter);

// Page permissions per API area. Reads need any of the first list, writes any
// of the second. Public routes (/pricing token pages, /webhook, auth) are not
// listed here. Role checks inside the modules still apply on top of this.
const RFQ_READ = ["rfq", "purchase-orders", "customer-rfq", "customer-po", "accounts", "dashboard"];
router.use("/suppliers", guardByMethod(["suppliers", "rfq", "purchase-orders"], ["suppliers"]));
router.use("/categories", guardByMethod(["suppliers", "rfq", "purchase-orders"], ["suppliers"]));
router.use("/customers", guardByMethod(["customers", "customer-rfq", "customer-po", "dashboard"], ["customers"]));
router.use("/representatives", guardByMethod(["employees", "customers", "customer-rfq", "customer-po"], ["employees"]));
router.use("/employees", guardByMethod(["employees", "rfq", "customer-rfq", "customer-po", "purchase-orders", "dashboard"], ["employees"]));
router.use("/items", guardByMethod(["items", "rfq", "customer-rfq", "customer-po", "purchase-orders", "analytics", "dashboard"], ["items"]));
router.use("/item-categories", guardByMethod(["items", "rfq", "customer-rfq"], ["items"]));
router.use("/offers", guardByMethod(RFQ_READ, ["rfq"]));
router.use("/offer", guardByMethod(RFQ_READ, ["rfq"]));
router.use("/rfq", guardByMethod(RFQ_READ, ["rfq"]));
router.use("/customer-rfq", guardByMethod(["customer-rfq", "rfq", "customer-po", "dashboard"], ["customer-rfq"]));
router.use("/customer-po", guardByMethod(["customer-po", "customer-rfq", "dashboard"], ["customer-po"]));
router.use("/po", guardByMethod(["purchase-orders", "rfq", "accounts", "dashboard"], ["purchase-orders"]));
router.use("/accounts", guardByMethod(["accounts", "dashboard"], ["accounts"]));
router.use("/expenses", guardByMethod(["accounts", "accounts:expenses"], ["accounts", "accounts:expenses"]));
router.use("/collections", guardByMethod(["accounts", "dashboard"], ["accounts"]));
router.use("/analytics", guardByMethod(["analytics", "dashboard"], ["analytics"]));
router.use("/sync", guardByMethod(["analytics"], ["analytics"]));
router.use("/audit", guardByMethod(["audit"], ["audit"]));
router.use("/whatsapp", guardByMethod(["whatsapp", "whatsapp:chats"], ["whatsapp", "whatsapp:chats"]));
router.use("/chatwoot", guardByMethod(["whatsapp", "whatsapp:chats"], ["whatsapp", "whatsapp:chats"]));
router.use("/ai-assistant", guardByMethod(["ai-assistant"], ["ai-assistant"]));
router.use("/integrations", guardByMethod(["integrations"], ["integrations"]));
router.use("/backup", guardByMethod(["backup"], ["backup"]));


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
router.use(emailAccountsModule); // Google Workspace mailboxes per employee (read-only)

export default router;
