/**
 * Accounts Module — أدوات مشتركة (shared helpers)
 *
 * Small numeric + settings utilities that every accounts route file needs.
 * Kept in one place so the NUMERIC-string handling and the tax-settings lookup
 * do not drift between the ledger, invoice, orders and reporting sub-modules.
 */
import { db, taxSettingsTable } from "@workspace/db";
import { rateOf } from "./tax";

/** Parse a NUMERIC column / body value into a number, null when absent or invalid. */
export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return isFinite(n) ? n : null;
}

/** Like `num`, but defaults to 0 (for arithmetic on optional values). */
export function numOr(v: unknown, fallback = 0): number {
  return num(v) ?? fallback;
}

/** Preserve the legacy routes.ts convention: null stays null, empty text becomes 0. */
export function numOrZero(v: unknown): number | null {
  if (v == null) return null;
  if (v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return isFinite(n) ? n : null;
}

/** Trim trailing zeros from a NUMERIC value ("3.0000" → "3"). */
export function trimNum(n: number): string {
  const s = String(Math.round(n * 10000) / 10000);
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/** Null-safe `trimNum`, for optional values. */
export function formatNum(n: number | null): string | null {
  return n == null ? null : trimNum(n);
}

export interface TaxSettings {
  id: number | null;
  companyName: string | null;
  companyTaxId: string | null;
  companyAddress: string | null;
  companyPhone: string | null;
  vatRate: number;
  withholdingRate: number;
  withholdingRateServices: number;
  withholdingRatePurchases: number;
}

/** Load the single tax_settings row, falling back to the statutory Egyptian rates. */
export async function loadTaxSettings(): Promise<TaxSettings> {
  const rows = await db.select().from(taxSettingsTable).limit(1);
  const row = rows[0];
  return {
    id: row?.id ?? null,
    companyName: row?.companyName ?? null,
    companyTaxId: row?.companyTaxId ?? null,
    companyAddress: row?.companyAddress ?? null,
    companyPhone: row?.companyPhone ?? null,
    vatRate: rateOf(row?.vatRate, 14),
    withholdingRate: rateOf(row?.withholdingRate, 3),
    withholdingRateServices: rateOf(row?.withholdingRateServices, 5),
    withholdingRatePurchases: rateOf(row?.withholdingRatePurchases, 1),
  };
}
