/**
 * Shared presentational pieces for the accounts tabs.
 *
 * The accounting screens repeat the same small building blocks — a loading /
 * empty placeholder and a KPI tile. Keeping them here avoids each tab
 * re-declaring its own and drifting on spacing and colour tone.
 */
import type { ReactNode } from "react";

/**
 * Colour tones actually used by the accounts screens. They are intentionally
 * semantic (profit/loss/payable/…) rather than raw colours so each tab keeps
 * the meaning it had before the helpers were centralised.
 */
type Tone =
  | "default"
  | "profit"
  | "loss"
  | "vat"
  | "asset"
  | "equity"
  | "payable"
  | "credit"
  | "deficit"
  | "highlight"
  | "ok"
  | "normal";

const TONE_CLASS: Record<Tone, string> = {
  default: "text-foreground",
  normal: "text-foreground",
  profit: "text-emerald-600",
  ok: "text-emerald-600",
  vat: "text-blue-600",
  asset: "text-blue-600",
  equity: "text-purple-600",
  loss: "text-red-600",
  payable: "text-emerald-600",
  credit: "text-amber-600",
  highlight: "text-amber-600",
  deficit: "text-rose-600",
};

/** Centered placeholder used while loading and when a list has no rows. */
export function Empty({ text }: { text: string }) {
  return (
    <div className="py-12 text-center text-muted-foreground text-sm border border-dashed border-border rounded-lg">
      {text}
    </div>
  );
}

/** Compact KPI tile: label, big value, optional sub-line and colour tone. */
export function TotalCard({
  label,
  value,
  sub,
  tone = "default",
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3.5">
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        {icon}
      </div>
      <div className={`text-lg font-bold tabular-nums ${TONE_CLASS[tone]}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}
