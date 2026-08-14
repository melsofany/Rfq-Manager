/**
 * Accounts Module — خرائط التكامل (integration maps)
 *
 * Connects the pre-existing operational modules (operating expenses, customer
 * collections) to the double-entry ledger by mapping their free-text categories
 * / payment methods to chart-of-accounts codes, so posting a journal entry for
 * those events uses the right ledger accounts.
 */
import { ACCOUNT_CODES } from "@workspace/db";

/** Map an operating-expense (Arabic) category → expense account code. */
export const EXPENSE_CATEGORY_ACCOUNT: Record<string, string> = {
  "إيجارات": ACCOUNT_CODES.RENT_EXPENSE,
  "دومينات واستضافة وخدمات تقنية": ACCOUNT_CODES.IT_EXPENSE,
  "كهرباء ومياه": ACCOUNT_CODES.UTILITIES_EXPENSE,
  "اتصالات": ACCOUNT_CODES.TELECOM_EXPENSE,
  "نثريات": ACCOUNT_CODES.MISC_EXPENSE,
  "صيانة": ACCOUNT_CODES.MAINTENANCE_EXPENSE,
  "مصروفات إدارية": ACCOUNT_CODES.ADMIN_EXPENSE,
  "رواتب": ACCOUNT_CODES.SALARIES_EXPENSE,
};

/** Resolve an expense category to its ledger account code (default misc). */
export function expenseAccountFor(category: string): string {
  return EXPENSE_CATEGORY_ACCOUNT[category] ?? ACCOUNT_CODES.MISC_EXPENSE;
}

/** Resolve a payment method string to the cash/bank account code. */
export function cashAccountFor(method: string | null | undefined): string {
  const m = (method ?? "").toLowerCase();
  if (m.includes("نقد") || m.includes("cash") || m === "كاش") return ACCOUNT_CODES.CASH;
  return ACCOUNT_CODES.BANK;
}
