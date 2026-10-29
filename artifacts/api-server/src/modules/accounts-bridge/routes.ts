/**
 * جسر الحسابات — مسارات API
 *
 * All routes are behind `requireAuth` (session), matching the rest of the API.
 * They are mounted by `routes/index.ts` BEFORE the legacy accounts module so the
 * bridge's `/accounts/*` paths win; the legacy module keeps its own distinct
 * paths (`/accounts/margins`, `/accounts/journal`, …) and is deprecated, not
 * removed, until Odoo is verified in production.
 *
 *   GET /accounts/sync-status          — bridge health + per-event sync log
 *   GET /accounts/bridge/status        — alias, explicit name
 *   GET /accounts/odoo/status          — connectivity probe (no writes)
 *   POST /accounts/sync/replay/:id     — retry one failed event
 *   GET /accounts/odoo/dashboard       — key totals from Odoo
 *   GET /accounts/odoo/statements/*    — trial balance / income / balance sheet
 *   GET /accounts/odoo/journals        — journal entries + general ledger
 *   GET /accounts/odoo/aging/:side     — receivables / payables aging
 *   GET /accounts/odoo/taxes           — VAT 14% + withholding 3%
 *   GET /accounts/odoo/invoices/:kind  — sales / supplier invoices
 *   GET /accounts/odoo/payments/:kind  — supplier / customer payments
 *   GET /accounts/odoo/coa             — chart of accounts
 */

import { Router } from "express";
import { requireAuth } from "../../middlewares/auth";
import { BridgeNotConfigured, requireOdoo } from "./reporting";
import {
  agingReport,
  buildBalanceSheet,
  buildIncomeStatement,
  companyInfo,
  installedModules,
  listAccounts,
  listInvoices,
  listJournalLines,
  listPayments,
  listTaxes,
  trialBalance,
} from "./reporting";
import { probeOdoo } from "./service";
import { listSyncRows, syncCounts, findByEventKey } from "./store";
import { DEFAULT_VAT_RATE, DEFAULT_WITHHOLDING_RATE } from "./tax";
import { logger } from "../../shared/logger";

const router = Router();

/** Wrap an Odoo-backed handler so an unconfigured bridge answers 503. */
function odooRoute(
  handler: (
    cfg: ReturnType<typeof requireOdoo>,
    req: import("express").Request,
    res: import("express").Response,
  ) => Promise<void>,
) {
  return async (req: import("express").Request, res: import("express").Response): Promise<void> => {
    try {
      await handler(requireOdoo(), req, res);
    } catch (err) {
      if (err instanceof BridgeNotConfigured) {
        res.status(503).json({ error: err.message, configured: false });
        return;
      }
      logger.error({ err, path: req.path }, "accounts-bridge: odoo route failed");
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

function range(req: import("express").Request): { from?: string; to?: string } {
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const to = typeof req.query.to === "string" ? req.query.to : undefined;
  return { from, to };
}

// ─── Sync status (REQUIRED by the task) ─────────────────────────────────────

async function syncStatus(
  req: import("express").Request,
  res: import("express").Response,
): Promise<void> {
  const [counts, rows, probe] = await Promise.all([syncCounts(), listSyncRows(200), probeOdoo()]);
  const failed = rows.filter((r) => r.status === "failed");
  res.json({
    odoo: probe,
    counts,
    failedCount: failed.length,
    // Every failed sync, newest first, with the error that stopped it.
    failures: failed.map((r) => ({
      id: r.id,
      eventKey: r.eventKey,
      eventType: r.eventType,
      sourceTable: r.sourceTable,
      sourceId: r.sourceId,
      attempts: r.attempts,
      lastError: r.lastError,
      updatedAt: r.updatedAt,
    })),
    recent: rows
      .slice(-50)
      .reverse()
      .map((r) => ({
        id: r.id,
        eventKey: r.eventKey,
        eventType: r.eventType,
        status: r.status,
        odooModel: r.odooModel,
        odooId: r.odooId,
        odooRef: r.odooRef,
        attempts: r.attempts,
        syncedAt: r.syncedAt,
      })),
    rates: { vatRate: DEFAULT_VAT_RATE, withholdingRate: DEFAULT_WITHHOLDING_RATE },
  });
}

router.get("/accounts/sync-status", requireAuth, syncStatus);
router.get("/accounts/bridge/status", requireAuth, syncStatus);

router.get("/accounts/odoo/status", requireAuth, async (_req, res): Promise<void> => {
  const probe = await probeOdoo();
  res.status(probe.configured ? 200 : 503).json(probe);
});

// ─── Replay one failed event ────────────────────────────────────────────────

router.post("/accounts/sync/replay/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!isFinite(id)) {
    res.status(400).json({ error: "معرّف غير صالح" });
    return;
  }
  const row = (await listSyncRows(1000)).find((r) => r.id === id);
  if (!row) {
    res.status(404).json({ error: "سجل المزامنة غير موجود" });
    return;
  }
  // A synced event is already idempotent — re-sending it is a no-op, and the
  // service would skip it anyway. Report that rather than pretending to retry.
  if (row.odooId != null) {
    res.json({ ok: true, status: "skipped", odooId: row.odooId });
    return;
  }
  const { replayEvent } = await import("./replay");
  const result = await replayEvent(row.eventType, row.sourceTable ?? "", row.sourceId ?? 0);
  res.status(result.status === "failed" ? 502 : 200).json(result);
});

// ─── Dashboard ──────────────────────────────────────────────────────────────

router.get(
  "/accounts/odoo/dashboard",
  requireAuth,
  odooRoute(async (cfg, _req, res) => {
    const [company, arAging, apAging, sales, purchases, customerPayments, supplierPayments] =
      await Promise.all([
        companyInfo(cfg),
        agingReport(cfg, "out_invoice", new Date().toISOString().slice(0, 10)),
        agingReport(cfg, "in_invoice", new Date().toISOString().slice(0, 10)),
        listInvoices(cfg, "out_invoice"),
        listInvoices(cfg, "in_invoice"),
        listPayments(cfg, "inbound"),
        listPayments(cfg, "outbound"),
      ]);
    const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
    res.json({
      company,
      receivables: { total: arAging.total, overdue: arAging.overdue, count: arAging.rows.length },
      payables: { total: apAging.total, overdue: apAging.overdue, count: apAging.rows.length },
      sales: {
        count: sales.length,
        untaxed: sum(sales.map((i) => i.amount_untaxed)),
        tax: sum(sales.map((i) => i.amount_tax)),
        total: sum(sales.map((i) => i.amount_total)),
        residual: sum(sales.map((i) => i.amount_residual)),
      },
      purchases: {
        count: purchases.length,
        untaxed: sum(purchases.map((i) => i.amount_untaxed)),
        tax: sum(purchases.map((i) => i.amount_tax)),
        total: sum(purchases.map((i) => i.amount_total)),
        residual: sum(purchases.map((i) => i.amount_residual)),
      },
      payments: {
        collected: sum(customerPayments.map((p) => p.amount)),
        paid: sum(supplierPayments.map((p) => p.amount)),
      },
    });
  }),
);

// ─── Financial statements ───────────────────────────────────────────────────

router.get(
  "/accounts/odoo/statements/trial-balance",
  requireAuth,
  odooRoute(async (cfg, req, res) => {
    const rows = await trialBalance(cfg, range(req));
    res.json({
      rows,
      totalDebit: rows.reduce((s, r) => s + r.debit, 0),
      totalCredit: rows.reduce((s, r) => s + r.credit, 0),
    });
  }),
);

router.get(
  "/accounts/odoo/statements/income-statement",
  requireAuth,
  odooRoute(async (cfg, req, res) => {
    const rows = await trialBalance(cfg, range(req));
    res.json(buildIncomeStatement(rows));
  }),
);

router.get(
  "/accounts/odoo/statements/balance-sheet",
  requireAuth,
  odooRoute(async (cfg, req, res) => {
    const r = range(req);
    const rows = await trialBalance(cfg, r);
    const income = buildIncomeStatement(rows);
    res.json(buildBalanceSheet(rows, income.netProfit));
  }),
);

// ─── Journals + general ledger ──────────────────────────────────────────────

router.get(
  "/accounts/odoo/journals",
  requireAuth,
  odooRoute(async (cfg, req, res) => {
    const accountId = req.query.accountId ? Number(req.query.accountId) : undefined;
    const lines = await listJournalLines(cfg, range(req), accountId);
    res.json({
      lines,
      totalDebit: lines.reduce((s, l) => s + l.debit, 0),
      totalCredit: lines.reduce((s, l) => s + l.credit, 0),
    });
  }),
);

// ─── Aging ──────────────────────────────────────────────────────────────────

router.get(
  "/accounts/odoo/aging/:side",
  requireAuth,
  odooRoute(async (cfg, req, res) => {
    const side = req.params.side === "payables" ? "in_invoice" : "out_invoice";
    const asOf =
      typeof req.query.asOf === "string" ? req.query.asOf : new Date().toISOString().slice(0, 10);
    res.json(await agingReport(cfg, side, asOf));
  }),
);

// ─── Taxes ──────────────────────────────────────────────────────────────────

router.get(
  "/accounts/odoo/taxes",
  requireAuth,
  odooRoute(async (cfg, _req, res) => {
    const taxes = await listTaxes(cfg);
    const sales = await listInvoices(cfg, "out_invoice");
    const purchases = await listInvoices(cfg, "in_invoice");
    const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
    const outputVat = sum(sales.map((i) => i.amount_tax));
    const inputVat = sum(purchases.map((i) => i.amount_tax));
    res.json({
      taxes,
      vat: {
        rate: DEFAULT_VAT_RATE,
        outputVat,
        inputVat,
        netPayable: outputVat - inputVat,
        salesBase: sum(sales.map((i) => i.amount_untaxed)),
        purchasesBase: sum(purchases.map((i) => i.amount_untaxed)),
      },
      withholding: {
        rate: DEFAULT_WITHHOLDING_RATE,
        // Withholding is 3% of the supplier net base.
        amount: (sum(purchases.map((i) => i.amount_untaxed)) * DEFAULT_WITHHOLDING_RATE) / 100,
      },
    });
  }),
);

// ─── Invoices + payments ────────────────────────────────────────────────────

router.get(
  "/accounts/odoo/invoices/:kind",
  requireAuth,
  odooRoute(async (cfg, req, res) => {
    const kind = req.params.kind;
    const moveType =
      kind === "supplier" || kind === "in"
        ? "in_invoice"
        : kind === "credit-sales"
          ? "out_refund"
          : "out_invoice";
    res.json({ invoices: await listInvoices(cfg, moveType, range(req)) });
  }),
);

router.get(
  "/accounts/odoo/payments/:kind",
  requireAuth,
  odooRoute(async (cfg, req, res) => {
    const kind = req.params.kind;
    const paymentType = kind === "customer" || kind === "in" ? "inbound" : "outbound";
    res.json({ payments: await listPayments(cfg, paymentType, range(req)) });
  }),
);

// ─── Chart of accounts ──────────────────────────────────────────────────────

router.get(
  "/accounts/odoo/coa",
  requireAuth,
  odooRoute(async (cfg, _req, res) => {
    res.json({ accounts: await listAccounts(cfg) });
  }),
);

// ─── Localization evidence ──────────────────────────────────────────────────

router.get(
  "/accounts/odoo/localization",
  requireAuth,
  odooRoute(async (cfg, _req, res) => {
    const installed = await installedModules(cfg, [
      "account",
      "l10n_eg",
      "l10n_eg_edi_eta",
      "purchase",
      "sale",
    ]);
    res.json({
      installed,
      egyptianLocalization: installed.includes("l10n_eg"),
      etaEInvoicing: installed.includes("l10n_eg_edi_eta"),
      company: await companyInfo(cfg),
    });
  }),
);

export { findByEventKey };
export default router;
