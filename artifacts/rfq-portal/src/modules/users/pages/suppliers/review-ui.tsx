/**
 * Shared presentation pieces for the supplier review centre.
 *
 * Small and dumb on purpose: the badge, the KPI tile, the empty state and the
 * document preview are used from several tabs, and copies of a status colour map
 * are how one tab ends up showing «معتمد» in red.
 */
import { FileText, Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { COMPARE_LABEL_AR, COMPARE_TONE, STATUS_TONE } from "./review-api";

/** The status badge. Falls back to a neutral tone so an unknown status is VISIBLE. */
export function StatusBadge({ statusKey, label }: { statusKey: string; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold",
        STATUS_TONE[statusKey] ?? "bg-slate-100 text-slate-700 border-slate-200",
      )}
    >
      {label}
    </span>
  );
}

/** One KPI tile. `value === null` renders «—», never `0` — they mean different things. */
export function KpiTile({
  label,
  value,
  tone = "neutral",
  hint,
  onClick,
}: {
  label: string;
  value: number | string | null;
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
  hint?: string;
  onClick?: () => void;
}) {
  const tones: Record<string, string> = {
    neutral: "from-slate-50 to-white border-slate-200 text-slate-900",
    good: "from-emerald-50 to-white border-emerald-200 text-emerald-900",
    warn: "from-amber-50 to-white border-amber-200 text-amber-900",
    bad: "from-rose-50 to-white border-rose-200 text-rose-900",
    info: "from-sky-50 to-white border-sky-200 text-sky-900",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "rounded-xl border bg-gradient-to-b p-3 text-right transition",
        tones[tone] ?? tones.neutral,
        onClick ? "cursor-pointer hover:shadow-sm" : "cursor-default",
      )}
    >
      <div className="text-[11px] font-medium opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value === null ? "—" : value}</div>
      {hint && <div className="mt-0.5 text-[10px] opacity-60">{hint}</div>}
    </button>
  );
}

/** An empty state that says WHICH kind of empty it is. */
export function EmptyState({
  title,
  hint,
  icon: Icon = FileText,
}: {
  title: string;
  hint?: string;
  icon?: typeof FileText;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <Icon className="h-8 w-8 text-slate-300" />
      <div className="text-sm font-medium text-slate-600">{title}</div>
      {hint && <div className="max-w-90 text-[12px] text-slate-400">{hint}</div>}
    </div>
  );
}

/** A labelled field of the detail pane. */
export function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-[13px] font-medium text-slate-900">
        {value === null || value === "" || value === undefined ? "—" : value}
      </div>
    </div>
  );
}

export interface CompareRowLike {
  key: string;
  label: string;
  declared: string | null;
  extracted: string | null;
  result: string;
  sourceDocumentId: number | null;
  sourceDocumentLabel: string | null;
}

/** One comparison row: declared vs extracted, with the verdict and its source. */
export function ComparisonLine({ row }: { row: CompareRowLike }) {
  const tone = COMPARE_TONE[row.result] ?? "bg-slate-50 text-slate-700 border-slate-200";
  const label = COMPARE_LABEL_AR[row.result] ?? row.result;
  return (
    <div className="rounded-md border border-slate-200 bg-white p-2">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="text-[12px] font-semibold text-slate-800">{row.label}</span>
        <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", tone)}>
          {label}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-2 text-[12px]">
        <div>
          <div className="text-[10px] text-slate-400">المُعلن من المورد</div>
          <div className="font-medium text-slate-800">{row.declared ?? "—"}</div>
        </div>
        <div>
          <div className="text-[10px] text-slate-400">المقروء من المستند</div>
          <div className="font-medium text-slate-800">{row.extracted ?? "—"}</div>
        </div>
      </div>
      {row.sourceDocumentLabel && (
        <div className="mt-1 text-[10px] text-slate-400">المصدر: {row.sourceDocumentLabel}</div>
      )}
    </div>
  );
}

/** The document preview dialog — the bytes are fetched on open, never upfront. */
export function DocumentPreview({
  url,
  title,
  mimeType,
  onClose,
}: {
  url: string;
  title: string;
  mimeType: string | null;
  onClose: () => void;
}) {
  const isImage = (mimeType ?? "").startsWith("image/");
  const isPdf = (mimeType ?? "").includes("pdf");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex h-full max-h-[92vh] w-full max-w-5xl flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-slate-500" />
            <span className="text-sm font-semibold text-slate-900">{title}</span>
          </div>
          <div className="flex items-center gap-1">
            <a href={url} target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm">
                <Download className="ml-1 h-3.5 w-3.5" /> تحميل
              </Button>
            </a>
            <button type="button" onClick={onClose} className="rounded-full p-1 hover:bg-slate-100">
              <X className="h-4 w-4 text-slate-600" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-slate-50 p-3">
          {isImage ? (
            <img src={url} alt={title} className="mx-auto max-h-full rounded-md shadow-sm" />
          ) : isPdf ? (
            <iframe src={url} title={title} className="h-[80vh] w-full rounded-md border-0" />
          ) : (
            <div className="p-6 text-center text-sm text-slate-500">
              لا يمكن معاينة هذا النوع داخل الشاشة — استخدم زر التحميل.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
