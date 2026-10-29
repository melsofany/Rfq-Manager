/**
 * جسر الحسابات — تقارير Odoo (reporting read-through)
 *
 * Every figure the accounts screens show is read from Odoo, not from the old
 * RFQ ledger. These functions are thin, typed wrappers over Odoo's own
 * reporting models, so the numbers a user sees are the numbers Odoo stands
 * behind:
 *
 *   account.move / account.move.line  → journals, invoices, GL, statements
 *   account.account                   → chart of accounts
 *   account.payment                   → customer / supplier payments
 *   account.tax                       → VAT / withholding tax definitions
 *
 * No writes happen here. `requireOdoo` throws a typed `BridgeNotConfigured`
 * when the environment is missing so routes can answer 503 instead of 500.
 */

import {
  odooConfigFromEnv,
  searchRead,
  readGroup,
  executeKw,
  type OdooConfig,
} from "./odoo-client";

export class BridgeNotConfigured extends Error {
  readonly name = "BridgeNotConfigured";
  constructor() {
    super("Odoo bridge is not configured — set ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY");
  }
}

export function requireOdoo(env: NodeJS.ProcessEnv = process.env): OdooConfig {
  const cfg = odooConfigFromEnv(env);
  if (!cfg) throw new BridgeNotConfigured();
  return cfg;
}

export interface DateRange {
  from?: string;
  to?: string;
}

/** Build an Odoo domain fragment for a date range on `field`. */
export function dateDomain(field: string, range: DateRange): unknown[] {
  const d: unknown[] = [];
  if (range.from) d.push([field, ">=", range.from]);
  if (range.to) d.push([field, "<=", range.to]);
  return d;
}

// account.move carries `state`; account.move.line does not — it exposes the
// related, stored `parent_state`. Using the wrong one makes Odoo reject the
// whole domain with "Invalid field ... in leaf".
const POSTED: unknown = ["state", "=", "posted"];
const POSTED_LINE: unknown = ["parent_state", "=", "posted"];

// ─── Chart of accounts ──────────────────────────────────────────────────────

export interface OdooAccount {
  id: number;
  code: string;
  name: string;
  account_type: string;
  reconcile: boolean;
}

export async function listAccounts(cfg: OdooConfig): Promise<OdooAccount[]> {
  return searchRead<OdooAccount>(
    cfg,
    "account.account",
    [],
    ["id", "code", "name", "account_type", "reconcile"],
    { order: "code" },
  );
}

// ─── Journal entries + general ledger ───────────────────────────────────────

export interface OdooMoveLine {
  id: number;
  date: string;
  move_name: string;
  account_id: [number, string] | false;
  partner_id: [number, string] | false;
  name: string;
  debit: number;
  credit: number;
  balance: number;
  move_id: [number, string] | false;
}

export async function listJournalLines(
  cfg: OdooConfig,
  range: DateRange,
  accountId?: number,
): Promise<OdooMoveLine[]> {
  const domain: unknown[] = [
    POSTED_LINE,
    ["display_type", "not in", ["line_section", "line_note"]],
    ...dateDomain("date", range),
  ];
  if (accountId) domain.push(["account_id", "=", accountId]);
  return searchRead<OdooMoveLine>(
    cfg,
    "account.move.line",
    domain,
    [
      "id",
      "date",
      "move_name",
      "account_id",
      "partner_id",
      "name",
      "debit",
      "credit",
      "balance",
      "move_id",
    ],
    { order: "date, move_name, id", limit: 2000 },
  );
}

// ─── Trial balance ──────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  code: string;
  name: string;
  accountType: string;
  debit: number;
  credit: number;
  balance: number;
}

export async function trialBalance(cfg: OdooConfig, range: DateRange): Promise<TrialBalanceRow[]> {
  const rows = await readGroup<{
    account_id: [number, string] | false;
    debit: number;
    credit: number;
    balance: number;
  }>(
    cfg,
    "account.move.line",
    [POSTED_LINE, ...dateDomain("date", range)],
    ["debit:sum", "credit:sum", "balance:sum"],
    ["account_id"],
  );
  const accounts = await listAccounts(cfg);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return rows
    .filter((r) => r.account_id)
    .map((r) => {
      const id = (r.account_id as [number, string])[0];
      const acc = byId.get(id);
      return {
        code: acc?.code ?? String(id),
        name: acc?.name ?? String((r.account_id as [number, string])[1] ?? ""),
        accountType: acc?.account_type ?? "other",
        debit: r.debit ?? 0,
        credit: r.credit ?? 0,
        balance: r.balance ?? 0,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

// ─── Income statement / balance sheet ───────────────────────────────────────

const INCOME_TYPES = [
  "income",
  "income_other",
  "expense",
  "expense_direct_cost",
  "expense_depreciation",
];
const ASSET_TYPES = [
  "asset_receivable",
  "asset_cash",
  "asset_current",
  "asset_non_current",
  "asset_prepayments",
  "asset_fixed",
];
const LIABILITY_TYPES = [
  "liability_payable",
  "liability_credit_card",
  "liability_current",
  "liability_non_current",
];
const EQUITY_TYPES = ["equity", "equity_unaffected"];

export interface StatementSection {
  label: string;
  rows: TrialBalanceRow[];
  total: number;
}

export interface IncomeStatement {
  revenue: StatementSection;
  expenses: StatementSection;
  netProfit: number;
}

export interface BalanceSheet {
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  currentPeriodResult: number;
  totalAssets: number;
  totalLiabilitiesAndEquity: number;
  balanced: boolean;
  difference: number;
}

/**
 * Sign a raw Odoo `balance` (debit − credit) into the account's natural
 * direction. Income is credit-natured, so it is `−balance`; expense is
 * debit-natured and stays `balance`. This is the SAME convention the legacy
 * reporting used, and it is what makes contra accounts (sales returns, purchase
 * discounts) net correctly instead of inflating their section.
 */
function signed(balance: number, accountType: string): number {
  const creditNatured =
    accountType.startsWith("income") ||
    accountType.startsWith("liability") ||
    accountType.startsWith("equity");
  return creditNatured ? -balance : balance;
}

export function buildIncomeStatement(rows: TrialBalanceRow[]): IncomeStatement {
  const revenueRows: TrialBalanceRow[] = [];
  const expenseRows: TrialBalanceRow[] = [];
  let revenue = 0;
  let expenses = 0;
  for (const r of rows) {
    if (r.accountType.startsWith("income")) {
      const v = signed(r.balance, r.accountType);
      revenue += v;
      revenueRows.push({ ...r, balance: v });
    } else if (r.accountType.startsWith("expense")) {
      const v = signed(r.balance, r.accountType);
      expenses += v;
      expenseRows.push({ ...r, balance: v });
    }
  }
  return {
    revenue: { label: "الإيرادات", rows: revenueRows, total: revenue },
    expenses: { label: "المصروفات", rows: expenseRows, total: expenses },
    netProfit: revenue - expenses,
  };
}

export function buildBalanceSheet(rows: TrialBalanceRow[], periodResult: number): BalanceSheet {
  const assets: TrialBalanceRow[] = [];
  const liabilities: TrialBalanceRow[] = [];
  const equity: TrialBalanceRow[] = [];
  let totalAssets = 0;
  let totalLiabilities = 0;
  let totalEquity = 0;
  for (const r of rows) {
    if (ASSET_TYPES.includes(r.accountType)) {
      const v = signed(r.balance, r.accountType);
      totalAssets += v;
      assets.push({ ...r, balance: v });
    } else if (LIABILITY_TYPES.includes(r.accountType)) {
      const v = signed(r.balance, r.accountType);
      totalLiabilities += v;
      liabilities.push({ ...r, balance: v });
    } else if (EQUITY_TYPES.includes(r.accountType)) {
      const v = signed(r.balance, r.accountType);
      totalEquity += v;
      equity.push({ ...r, balance: v });
    }
  }
  // Revenue/expense are not closed to retained earnings until year-end, so the
  // period result is folded into equity as its own line — otherwise the sheet
  // never balances on a profitable company.
  const totalLiabilitiesAndEquity = totalLiabilities + totalEquity + periodResult;
  return {
    assets: { label: "الأصول", rows: assets, total: totalAssets },
    liabilities: { label: "الالتزامات", rows: liabilities, total: totalLiabilities },
    equity: { label: "حقوق الملكية", rows: equity, total: totalEquity },
    currentPeriodResult: periodResult,
    totalAssets,
    totalLiabilitiesAndEquity,
    balanced: Math.abs(totalAssets - totalLiabilitiesAndEquity) < 0.01,
    difference: totalAssets - totalLiabilitiesAndEquity,
  };
}

// ─── Invoices + payments ────────────────────────────────────────────────────

export interface OdooInvoice {
  id: number;
  name: string;
  ref: string;
  invoice_date: string;
  partner_id: [number, string] | false;
  amount_untaxed: number;
  amount_tax: number;
  amount_total: number;
  amount_residual: number;
  state: string;
  move_type: string;
  payment_state: string;
}

export async function listInvoices(
  cfg: OdooConfig,
  moveType: "out_invoice" | "in_invoice" | "out_refund" | "in_refund",
  range: DateRange = {},
): Promise<OdooInvoice[]> {
  return searchRead<OdooInvoice>(
    cfg,
    "account.move",
    [["move_type", "=", moveType], ...dateDomain("invoice_date", range)],
    [
      "id",
      "name",
      "ref",
      "invoice_date",
      "partner_id",
      "amount_untaxed",
      "amount_tax",
      "amount_total",
      "amount_residual",
      "state",
      "move_type",
      "payment_state",
    ],
    { order: "invoice_date desc, id desc", limit: 500 },
  );
}

export interface OdooPayment {
  id: number;
  name: string;
  date: string;
  partner_id: [number, string] | false;
  amount: number;
  payment_type: string;
  partner_type: string;
  state: string;
  payment_reference: string;
  memo: string;
}

export async function listPayments(
  cfg: OdooConfig,
  paymentType: "inbound" | "outbound",
  range: DateRange = {},
): Promise<OdooPayment[]> {
  return searchRead<OdooPayment>(
    cfg,
    "account.payment",
    [["payment_type", "=", paymentType], ...dateDomain("date", range)],
    [
      "id",
      "name",
      "date",
      "partner_id",
      "amount",
      "payment_type",
      "partner_type",
      "state",
      "payment_reference",
      "memo",
    ],
    { order: "date desc, id desc", limit: 500 },
  );
}

// ─── Aging ──────────────────────────────────────────────────────────────────

export interface AgingBucket {
  label: string;
  amount: number;
  count: number;
}

export interface AgingReport {
  buckets: AgingBucket[];
  total: number;
  overdue: number;
  rows: {
    partner: string;
    invoice: string;
    dueDate: string;
    daysPastDue: number;
    residual: number;
  }[];
}

const BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "غير مستحق", min: -Infinity, max: 0 },
  { label: "1–30 يوم", min: 1, max: 30 },
  { label: "31–60 يوم", min: 31, max: 60 },
  { label: "61–90 يوم", min: 61, max: 90 },
  { label: "أكثر من 90 يوم", min: 91, max: Infinity },
];

/**
 * Age outstanding invoice balances by days past `invoice_date_due`. Only POSTED
 * invoices with a non-zero residual are aged — a draft is not a receivable.
 */
export async function agingReport(
  cfg: OdooConfig,
  moveType: "out_invoice" | "in_invoice",
  asOf: string,
): Promise<AgingReport> {
  const invoices = await searchRead<OdooInvoice & { invoice_date_due: string }>(
    cfg,
    "account.move",
    [["move_type", "=", moveType], POSTED, ["payment_state", "in", ["not_paid", "partial"]]],
    ["id", "name", "ref", "invoice_date", "invoice_date_due", "partner_id", "amount_residual"],
    { order: "invoice_date_due" },
  );
  const asOfMs = new Date(asOf).getTime();
  const rows = invoices
    .filter((i) => Math.abs(i.amount_residual ?? 0) > 0.001)
    .map((i) => {
      const dueMs = i.invoice_date_due ? new Date(i.invoice_date_due).getTime() : asOfMs;
      const daysPastDue = Math.floor((asOfMs - dueMs) / 86_400_000);
      return {
        partner: Array.isArray(i.partner_id) ? String(i.partner_id[1]) : "",
        invoice: i.name,
        dueDate: i.invoice_date_due ?? "",
        daysPastDue,
        residual: i.amount_residual ?? 0,
      };
    })
    .sort((a, b) => b.daysPastDue - a.daysPastDue);

  const buckets = BUCKETS.map((b) => {
    const inBucket = rows.filter((r) => r.daysPastDue >= b.min && r.daysPastDue <= b.max);
    return {
      label: b.label,
      amount: inBucket.reduce((s, r) => s + r.residual, 0),
      count: inBucket.length,
    };
  });
  return {
    buckets,
    total: rows.reduce((s, r) => s + r.residual, 0),
    overdue: rows.filter((r) => r.daysPastDue > 0).reduce((s, r) => s + r.residual, 0),
    rows,
  };
}

// ─── Taxes ──────────────────────────────────────────────────────────────────

export interface OdooTax {
  id: number;
  name: string;
  amount: number;
  amount_type: string;
  type_tax_use: string;
}

export async function listTaxes(cfg: OdooConfig): Promise<OdooTax[]> {
  return searchRead<OdooTax>(
    cfg,
    "account.tax",
    [],
    ["id", "name", "amount", "amount_type", "type_tax_use"],
    { order: "type_tax_use, amount" },
  );
}

/** The company identity + currency, for the dashboard header. */
export async function companyInfo(cfg: OdooConfig): Promise<{
  name: string;
  currency: string;
  country: string;
} | null> {
  const rows = await executeKw<
    { name: string; currency_id: [number, string] | false; country_id: [number, string] | false }[]
  >(cfg, "res.company", "search_read", [[]], {
    fields: ["name", "currency_id", "country_id"],
    limit: 1,
  });
  if (!rows.length) return null;
  const c = rows[0];
  return {
    name: c.name,
    currency: Array.isArray(c.currency_id) ? String(c.currency_id[1]) : "",
    country: Array.isArray(c.country_id) ? String(c.country_id[1]) : "",
  };
}

/** Installed modules — used to prove l10n_eg / account are present. */
export async function installedModules(cfg: OdooConfig, names: string[]): Promise<string[]> {
  const rows = await searchRead<{ name: string }>(
    cfg,
    "ir.module.module",
    [
      ["state", "=", "installed"],
      ["name", "in", names],
    ],
    ["name"],
  );
  return rows.map((r) => r.name);
}
