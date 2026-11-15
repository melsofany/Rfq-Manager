/**
 * Presentation for the «الطلبات المفتوحة» tab.
 *
 * The server returns the urgency bucket and the countdown label, so the portal
 * never re-derives them: two copies of «how urgent is this» is how the badge and
 * the row would start disagreeing. What lives here is only the LOOK of a bucket
 * (colour + icon name), which the server has no business deciding.
 */

export type OpenUrgency = "overdue" | "today" | "soon" | "normal" | "none";

/** Tailwind classes for an urgency badge. */
export const URGENCY_STYLES: Record<OpenUrgency, string> = {
  overdue: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
  today: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300",
  soon: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
  normal: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
  none: "bg-slate-100 text-slate-600 dark:bg-slate-900/50 dark:text-slate-300",
};

/** Style for a row's left accent bar, so the most urgent rows read first. */
export const URGENCY_ROW_ACCENT: Record<OpenUrgency, string> = {
  overdue: "border-r-4 border-r-red-500",
  today: "border-r-4 border-r-orange-500",
  soon: "border-r-4 border-r-amber-400",
  normal: "border-r-4 border-r-transparent",
  none: "border-r-4 border-r-transparent",
};

/** Narrow an unknown value from the API to a known bucket, defaulting to «none». */
export function asUrgency(value: unknown): OpenUrgency {
  return value === "overdue" || value === "today" || value === "soon" || value === "normal"
    ? value
    : "none";
}

/** Style for a progress bar that must not be reported as complete when it is not. */
export function progressPct(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
