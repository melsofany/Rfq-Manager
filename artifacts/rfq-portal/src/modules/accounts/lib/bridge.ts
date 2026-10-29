/**
 * عميل جسر الحسابات — the accounts screens' only data source.
 *
 * Every figure the accounts UI shows comes from Odoo, through the api-server's
 * `/api/accounts/odoo/*` bridge routes. These endpoints are NOT in the OpenAPI
 * spec, so they are called with a direct `fetch` (the same pattern as
 * receipts/deliveries/collections) rather than the generated orval client.
 *
 * A `useBridgeQuery` hook wraps the fetch with loading/error state and a manual
 * `reload`, so every page renders the same three states: loading, error (with
 * the server's message), and data.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export class BridgeError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** GET a bridge endpoint. Throws `BridgeError` carrying the server's message. */
export async function bridgeGet<T>(
  path: string,
  params?: Record<string, string | undefined>,
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== "") qs.set(k, v);
  }
  const url = `/api${path}${qs.toString() ? `?${qs}` : ""}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new BridgeError(message, res.status);
  }
  return (await res.json()) as T;
}

/** POST to a bridge endpoint. */
export async function bridgePost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      /* keep the status message */
    }
    throw new BridgeError(message, res.status);
  }
  return (await res.json()) as T;
}

export interface BridgeQuery<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  /** 503 — Odoo is not configured yet; pages show a setup notice, not a crash. */
  notConfigured: boolean;
  reload: () => void;
}

/**
 * Fetch a bridge endpoint with loading/error/not-configured state.
 * `params` is read through a ref so a caller can pass an inline object without
 * triggering an infinite refetch loop.
 */
export function useBridgeQuery<T>(
  path: string,
  params?: Record<string, string | undefined>,
  enabled = true,
): BridgeQuery<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [nonce, setNonce] = useState(0);

  const paramsRef = useRef(params);
  paramsRef.current = params;
  const paramsKey = JSON.stringify(params ?? {});

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setNotConfigured(false);
    bridgeGet<T>(path, paramsRef.current)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const e = err as BridgeError;
        if (e?.status === 503) setNotConfigured(true);
        setError(e instanceof Error ? e.message : "تعذر تحميل البيانات");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, paramsKey, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, isLoading, error, notConfigured, reload };
}

// ─── Shared types (the bridge route payloads) ───────────────────────────────

export interface OdooAccount {
  id: number;
  code: string;
  name: string;
  account_type: string;
  reconcile: boolean;
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  accountType: string;
  debit: number;
  credit: number;
  balance: number;
}

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
}

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
  payment_state: string;
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
  ref: string;
  memo: string;
}

export interface SyncStatus {
  odoo: { configured: boolean; ok: boolean; version?: string; error?: string };
  counts: { total: number; synced: number; failed: number; pending: number };
  failedCount: number;
  failures: {
    id: number;
    eventKey: string;
    eventType: string;
    sourceTable: string | null;
    sourceId: number | null;
    attempts: number;
    lastError: string | null;
    updatedAt: string;
  }[];
  recent: {
    id: number;
    eventKey: string;
    eventType: string;
    status: string;
    odooModel: string | null;
    odooId: number | null;
    odooRef: string | null;
    attempts: number;
    syncedAt: string | null;
  }[];
  rates: { vatRate: number; withholdingRate: number };
}

/** Format a money figure with the Egyptian pound, thousands-separated. */
export function egp(n: number | null | undefined): string {
  const v = typeof n === "number" && isFinite(n) ? n : 0;
  return `${v.toLocaleString("en-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;
}

/** A short date label, tolerating null. */
export function dateLabel(d: string | null | undefined): string {
  if (!d) return "—";
  return d;
}
