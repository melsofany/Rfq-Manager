import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FileText,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  reviewApi,
  type ComparisonRow,
  type DocumentView,
  type ReadDocumentsResponse,
} from "./review-api";

/**
 * الشاشة المقسومة — the reviewer's working view.
 *
 * Reading a declared value on one screen and hunting for the document that
 * proves it on another is how a mismatch gets approved: the reviewer compares
 * from memory. This pane keeps the value and its evidence side by side, and lets
 * the reviewer move through the fields without losing the document.
 *
 * The pairing is not guessed. `ComparisonRow.sourceDocumentId` comes from the
 * OCR pass — it is the document that actually contained the value — so the pane
 * opens the right attachment for the field under review.
 */

type ResultKind = "match" | "mismatch" | "not_found" | "unreadable";

const RESULT_META: Record<ResultKind, { label: string; tone: string; icon: typeof CheckCircle2 }> =
  {
    match: {
      label: "مطابق",
      tone: "bg-emerald-50 text-emerald-800 border-emerald-200",
      icon: CheckCircle2,
    },
    mismatch: { label: "مخالف", tone: "bg-red-50 text-red-800 border-red-200", icon: XCircle },
    not_found: {
      label: "غير موجود بالمستندات",
      tone: "bg-amber-50 text-amber-800 border-amber-200",
      icon: AlertTriangle,
    },
    unreadable: {
      label: "مستند غير مقروء",
      tone: "bg-slate-100 text-slate-700 border-slate-300",
      icon: AlertTriangle,
    },
  };

function resultOf(row: ComparisonRow): ResultKind {
  const r = (row.result ?? "").toLowerCase();
  if (r === "match" || r === "matched") return "match";
  if (r === "mismatch" || r === "mismatched") return "mismatch";
  if (r === "unreadable") return "unreadable";
  return "not_found";
}

export function SideBySideReview({
  applicationId,
  reading,
  documents,
  onVerdict,
  busy,
}: {
  applicationId: number;
  reading: ReadDocumentsResponse;
  documents: DocumentView[];
  onVerdict: (row: ComparisonRow, verdict: string) => Promise<void>;
  busy: boolean;
}) {
  const rows = reading.comparison;
  const [activeKey, setActiveKey] = useState<string>(rows[0]?.key ?? "");
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [marking, setMarking] = useState<string | null>(null);

  const activeIndex = Math.max(
    0,
    rows.findIndex((r) => r.key === activeKey),
  );
  const active = rows[activeIndex] ?? null;

  // The document that proves the active field, falling back to the first
  // readable one so the right pane is never empty while a field is under review.
  const sourceDoc = useMemo(() => {
    if (!active) return documents[0] ?? null;
    const byId = documents.find((d) => d.id === active.sourceDocumentId);
    if (byId) return byId;
    const byLabel = documents.find((d) => d.label === active.sourceDocumentLabel);
    return byLabel ?? documents[0] ?? null;
  }, [active, documents]);

  const step = useCallback(
    (delta: number) => {
      const next = Math.min(rows.length - 1, Math.max(0, activeIndex + delta));
      const row = rows[next];
      if (row) setActiveKey(row.key);
    },
    [activeIndex, rows],
  );

  // Arrow keys move between fields — a reviewer comparing ten values should not
  // have to reach for the mouse between each one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        step(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  const mark = async (row: ComparisonRow, verdict: string) => {
    setMarking(row.key);
    try {
      await onVerdict(row, verdict);
    } finally {
      setMarking(null);
    }
  };

  if (!rows.length) {
    return (
      <div className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
        لا توجد حقول للمقارنة — اقرأ المستندات أولًا.
      </div>
    );
  }

  const meta = active ? RESULT_META[resultOf(active)] : RESULT_META.not_found;
  const Icon = meta.icon;
  const docUrl = sourceDoc ? reviewApi.documentUrl(applicationId, sourceDoc.id) : null;
  const isImage = (sourceDoc?.mimeType ?? "").startsWith("image/");
  const isPdf = (sourceDoc?.mimeType ?? "").includes("pdf");

  return (
    <div className={cn("flex flex-col gap-2", expanded && "fixed inset-0 z-50 bg-white p-3")}>
      {/* Header: which field, and how many are left */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-slate-500" />
          <span className="text-[13px] font-semibold text-slate-800">
            مقارنة البيانات بالمستندات
          </span>
          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600 ring-1 ring-slate-200">
            {activeIndex + 1} / {rows.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => step(-1)}
            disabled={activeIndex === 0}
            title="الحقل السابق (↑)"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => step(1)}
            disabled={activeIndex >= rows.length - 1}
            title="الحقل التالي (↓)"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "تصغير" : "تكبير ملء الشاشة"}
          >
            {expanded ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      <div
        className={cn("grid gap-2", expanded ? "min-h-0 flex-1 lg:grid-cols-2" : "lg:grid-cols-2")}
      >
        {/* ── LEFT: declared data, one row per field ── */}
        <div
          className={cn(
            "min-h-0 overflow-auto rounded-md border border-slate-200 bg-white",
            expanded ? "max-h-none" : "max-h-[560px]",
          )}
        >
          <div className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-700">
            ما أعلنه المورد
          </div>
          <div className="divide-y divide-slate-100">
            {rows.map((row) => {
              const rk = resultOf(row);
              const rm = RESULT_META[rk];
              const RIcon = rm.icon;
              const isActive = row.key === activeKey;
              return (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => setActiveKey(row.key)}
                  className={cn(
                    "flex w-full flex-col gap-1 px-3 py-2 text-right transition",
                    isActive
                      ? "bg-brand-red/5 ring-2 ring-inset ring-brand-red/30"
                      : "hover:bg-slate-50",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-slate-600">{row.label}</span>
                    <span
                      className={cn(
                        "flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold",
                        rm.tone,
                      )}
                    >
                      <RIcon className="h-2.5 w-2.5" />
                      {rm.label}
                    </span>
                  </div>
                  <div className="text-[13px] font-semibold text-slate-900" dir="auto">
                    {row.declared || <span className="text-slate-400">— لم يُعلن —</span>}
                  </div>
                  {row.extracted && (
                    <div className="text-[10px] text-slate-500" dir="auto">
                      من المستند: {row.extracted}
                    </div>
                  )}
                  {row.sourceDocumentLabel && (
                    <div className="text-[9px] text-slate-400">
                      المصدر: {row.sourceDocumentLabel}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── RIGHT: the document that proves it ── */}
        <div
          className={cn(
            "flex min-h-0 flex-col rounded-md border border-slate-200 bg-slate-50",
            expanded ? "max-h-none" : "max-h-[560px]",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-[11px] font-semibold text-slate-700">
                {sourceDoc ? sourceDoc.label : "لا يوجد مستند"}
              </div>
              {sourceDoc && (
                <div className="truncate text-[9px] text-slate-500">{sourceDoc.originalName}</div>
              )}
            </div>
            {isImage && (
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
                  title="تصغير"
                >
                  −
                </Button>
                <span className="min-w-[38px] text-center text-[10px] font-semibold text-slate-600">
                  {Math.round(zoom * 100)}%
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))}
                  title="تكبير"
                >
                  +
                </Button>
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {!docUrl ? (
              <div className="p-8 text-center text-xs text-slate-500">لم يرفع المورد مستندات.</div>
            ) : isImage ? (
              <img
                src={docUrl}
                alt={sourceDoc?.label ?? "مستند"}
                className="mx-auto origin-top rounded shadow-sm transition-transform"
                style={{ transform: `scale(${zoom})`, maxWidth: "100%" }}
              />
            ) : isPdf ? (
              <iframe
                src={docUrl}
                title={sourceDoc?.label ?? "مستند"}
                className="h-full min-h-[420px] w-full rounded border-0 bg-white"
              />
            ) : (
              <div className="p-8 text-center text-xs text-slate-500">
                لا يمكن معاينة هذا النوع — نزّله من زر «تحميل» في نافذة المستندات.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Decision for the field under review ── */}
      {active && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                meta.tone,
              )}
            >
              <Icon className="h-3 w-3" />
              {meta.label}
            </span>
            <span className="text-[11px] text-slate-600">
              حكمك على «{active.label}»: يؤكد المورد أنه صحيح؟
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || marking === active.key}
              onClick={() => void mark(active, "proven")}
              className="border-emerald-300 text-emerald-800 hover:bg-emerald-50"
            >
              {marking === active.key ? (
                <Loader2 className="ml-1 h-3 w-3 animate-spin" />
              ) : (
                <CheckCircle2 className="ml-1 h-3 w-3" />
              )}
              مطابق
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || marking === active.key}
              onClick={() => void mark(active, "not_proven")}
              className="border-red-300 text-red-800 hover:bg-red-50"
            >
              <XCircle className="ml-1 h-3 w-3" /> مخالف
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || marking === active.key}
              onClick={() => void mark(active, "needs_document")}
              className="border-amber-300 text-amber-800 hover:bg-amber-50"
            >
              <AlertTriangle className="ml-1 h-3 w-3" /> يحتاج مستندًا
            </Button>
            {activeIndex < rows.length - 1 && (
              <Button size="sm" onClick={() => step(1)} disabled={busy}>
                التالي <ChevronLeft className="mr-1 h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
