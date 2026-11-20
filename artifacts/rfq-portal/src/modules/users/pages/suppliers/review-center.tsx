/**
 * The Supplier Review & Verification Centre.
 *
 * One screen, four tabs: the dashboard, the queue, the application workspace and
 * the reports. The reviewer lives here all day, so nothing navigates away — the
 * queue stays on the right and the workspace fills the left.
 *
 * Design decisions worth knowing:
 *  * The AI reading is EVIDENCE, never a verdict. Every comparison row shows the
 *    declared value beside the extracted one and names the file it came from, so
 *    the reviewer checks the reading instead of trusting a badge.
 *  * A status change goes through ONE endpoint that validates the move against
 *    the state machine and writes the audit row. There is no second path.
 *  * Approval requires VERIFIED first — the server enforces it, and the buttons
 *    here reflect what the server will accept rather than guessing.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  BarChart3,
  CheckCircle2,
  ClipboardList,
  Clock,
  FileSearch,
  FileText,
  History,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  UserCheck,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  EVENT_LABEL_AR,
  formatDate,
  formatDateTime,
  reviewApi,
  timeAgo,
  type AuditEventRow,
  type AvailableAction,
  type CategoryVerdictRow,
  type DashboardResponse,
  type DocumentView,
  type ReadDocumentsResponse,
  type ReportsResponse,
  type ReviewApplicationRow,
} from "./review-api";
import {
  ComparisonLine,
  DocumentPreview,
  EmptyState,
  Field,
  KpiTile,
  StatusBadge,
} from "./review-ui";

const STATUS_FILTERS: Array<{ key: string; label: string }> = [
  { key: "", label: "الكل" },
  { key: "new", label: "جديد" },
  { key: "assigned", label: "مُسند" },
  { key: "under_review", label: "قيد المراجعة" },
  { key: "needs_information", label: "بانتظار بيانات" },
  { key: "needs_documents", label: "بانتظار مستندات" },
  { key: "resubmitted", label: "أُعيد التقديم" },
  { key: "verified", label: "تم الفحص" },
  { key: "approved", label: "معتمد" },
  { key: "rejected", label: "مرفوض" },
  { key: "suspended", label: "معلّق" },
];

export function SupplierReviewCenter() {
  const [tab, setTab] = useState("queue");

  return (
    <div className="space-y-3" dir="rtl">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full max-w-2xl grid-cols-4">
          <TabsTrigger value="queue" className="gap-1.5">
            <ClipboardList className="h-3.5 w-3.5" /> طابور المراجعة
          </TabsTrigger>
          <TabsTrigger value="dashboard" className="gap-1.5">
            <BarChart3 className="h-3.5 w-3.5" /> المؤشرات
          </TabsTrigger>
          <TabsTrigger value="reports" className="gap-1.5">
            <FileSearch className="h-3.5 w-3.5" /> التقارير
          </TabsTrigger>
          <TabsTrigger value="help" className="gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" /> كيف يعمل
          </TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="mt-3">
          <QueueTab />
        </TabsContent>
        <TabsContent value="dashboard" className="mt-3">
          <DashboardTab />
        </TabsContent>
        <TabsContent value="reports" className="mt-3">
          <ReportsTab />
        </TabsContent>
        <TabsContent value="help" className="mt-3">
          <HowItWorksTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Queue + workspace ─────────────────────────────────────────────────────

function QueueTab() {
  const [apps, setApps] = useState<ReviewApplicationRow[]>([]);
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [lateOnly, setLateOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {};
      if (filter) params.status = filter;
      if (search.trim()) params.q = search.trim();
      if (lateOnly) params.late = "1";
      const data = await reviewApi.applications(params);
      setApps(data.applications);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر تحميل الطابور");
    } finally {
      setLoading(false);
    }
  }, [filter, search, lateOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(() => apps.find((a) => a.id === selectedId) ?? null, [apps, selectedId]);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(320px,420px)_1fr]">
      <Card className="flex min-h-[600px] flex-col overflow-hidden">
        <div className="space-y-2 border-b border-slate-200 p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900">طلبات البوابة</h3>
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </Button>
          </div>
          <div className="relative">
            <Search className="absolute right-2 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث بالاسم أو البريد أو البند أو العلامة…"
              className="h-9 pr-7 text-[12px]"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-medium transition",
                  filter === f.key
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-600">
            <input
              type="checkbox"
              checked={lateOnly}
              onChange={(e) => setLateOnly(e.target.checked)}
              className="h-3 w-3"
            />
            المتأخرة فقط (تجاوزت مدة المراجعة)
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> جارٍ التحميل…
            </div>
          ) : error ? (
            <EmptyState title="تعذّر تحميل الطابور" hint={error} icon={AlertTriangle} />
          ) : apps.length === 0 ? (
            <EmptyState
              title="لا توجد طلبات مطابقة"
              hint={
                search || filter || lateOnly
                  ? "جرّب إزالة الفلاتر أو البحث بكلمة أخرى."
                  : "لم يتقدّم أي مورد بعد."
              }
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {apps.map((app) => (
                <li key={app.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(app.id)}
                    className={cn(
                      "w-full px-3 py-2.5 text-right transition hover:bg-slate-50",
                      selectedId === app.id && "bg-slate-100",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-semibold text-slate-900">
                          {app.name}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-500">
                          <span className="font-mono">{app.reference}</span>
                          <span>·</span>
                          <span>{formatDate(app.createdAt)}</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <StatusBadge statusKey={app.statusKey} label={app.statusLabel} />
                        {app.isLate && (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-semibold text-rose-700">
                            <Clock className="h-2.5 w-2.5" /> متأخر
                          </span>
                        )}
                      </div>
                    </div>
                    {app.assignedEmployeeName && (
                      <div className="mt-1 text-[10px] text-slate-400">
                        المسؤول: {app.assignedEmployeeName}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <div className="min-w-0">
        {selected ? (
          <ApplicationWorkspace key={selected.id} app={selected} onChanged={() => void load()} />
        ) : (
          <Card className="flex min-h-[600px] items-center justify-center">
            <EmptyState
              title="اختر طلبًا من القائمة"
              hint="ستظهر هنا بيانات المورد ومستنداته ونتيجة المقارنة وسجل الإجراءات."
              icon={ClipboardList}
            />
          </Card>
        )}
      </div>
    </div>
  );
}

// ─── The workspace ─────────────────────────────────────────────────────────

function ApplicationWorkspace({
  app,
  onChanged,
}: {
  app: ReviewApplicationRow;
  onChanged: () => void;
}) {
  const [sub, setSub] = useState("data");
  const [actions, setActions] = useState<AvailableAction[]>([]);
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [preview, setPreview] = useState<DocumentView | null>(null);
  const [documents, setDocuments] = useState<DocumentView[]>([]);
  const [reading, setReading] = useState<ReadDocumentsResponse | null>(null);
  const [audit, setAudit] = useState<AuditEventRow[]>([]);
  const [verdicts, setVerdicts] = useState<CategoryVerdictRow[]>([]);

  const refreshSide = useCallback(async () => {
    const [a, au, v] = await Promise.all([
      reviewApi.actions(app.id).catch(() => null),
      reviewApi.audit(app.id).catch(() => ({ events: [] })),
      reviewApi.categoryVerdicts(app.id).catch(() => ({ verdicts: [] })),
    ]);
    if (a) {
      setActions(a.available);
      setRole(a.role);
    }
    setAudit(au.events);
    setVerdicts(v.verdicts);
  }, [app.id]);

  useEffect(() => {
    void refreshSide();
    // Document METADATA only — the bytes are fetched when the reviewer opens one.
    void reviewApi
      .detail(app.id)
      .then((d) => {
        const docs = (d as { documents?: DocumentView[] }).documents ?? [];
        setDocuments(docs);
      })
      .catch(() => setDocuments([]));
  }, [app.id, refreshSide]);

  const transition = async (to: string, body: Record<string, unknown> = {}) => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await reviewApi.transition(app.id, { to, ...body });
      setMessage({ tone: "ok", text: `تم نقل الطلب إلى «${r.label}»` });
      await refreshSide();
      onChanged();
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof Error ? err.message : "تعذّر تنفيذ الإجراء" });
    } finally {
      setBusy(false);
    }
  };

  const runRead = async (force: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const data = await reviewApi.readDocuments(app.id, force);
      setReading(data);
      setSub("compare");
      setMessage({
        tone: data.summary.unreadable > 0 ? "err" : "ok",
        text: `قرأنا ${data.summary.documents} مستندًا — ${data.summary.unreadable} غير مقروء، ${data.summary.mismatched} اختلاف يحتاج مراجعة.`,
      });
      await refreshSide();
    } catch (err) {
      setMessage({
        tone: "err",
        text: err instanceof Error ? err.message : "تعذّرت قراءة المستندات",
      });
    } finally {
      setBusy(false);
    }
  };

  const doApprove = async () => {
    if (!window.confirm(`اعتماد «${app.name}» وإنشاء ملف مورد فعلي؟`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await reviewApi.approve(app.id);
      setMessage({
        tone: "ok",
        text: r.supplierId ? `تم الاعتماد وإنشاء المورد (#${r.supplierId})` : "تم الاعتماد",
      });
      await refreshSide();
      onChanged();
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof Error ? err.message : "تعذّر الاعتماد" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex min-h-[600px] flex-col overflow-hidden">
      <div className="border-b border-slate-200 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-slate-900">{app.name}</h3>
              <StatusBadge statusKey={app.statusKey} label={app.statusLabel} />
              {app.isLate && (
                <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-semibold text-rose-700">
                  متأخر
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
              <span className="font-mono">{app.reference}</span>
              <span>·</span>
              <span>تقدّم في {formatDate(app.createdAt)}</span>
              {app.assignedEmployeeName && (
                <>
                  <span>·</span>
                  <span>المسؤول: {app.assignedEmployeeName}</span>
                </>
              )}
              {role && (
                <>
                  <span>·</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5">
                    دورك: {roleLabel(role)}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={() => void runRead(false)} disabled={busy}>
              {busy ? (
                <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="ml-1 h-3.5 w-3.5" />
              )}
              اقرأ المستندات وقارن
            </Button>
            {app.supplierId ? (
              <Badge className="bg-emerald-100 text-emerald-700">
                <BadgeCheck className="ml-1 h-3 w-3" /> مورد #{app.supplierId}
              </Badge>
            ) : (
              actions.some((a) => a.action === "approve") && (
                <Button size="sm" onClick={() => void doApprove()} disabled={busy}>
                  <CheckCircle2 className="ml-1 h-3.5 w-3.5" /> اعتماد وإنشاء مورد
                </Button>
              )
            )}
          </div>
        </div>

        {message && (
          <div
            className={cn(
              "mt-2 rounded-md border px-2.5 py-1.5 text-[12px]",
              message.tone === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-rose-200 bg-rose-50 text-rose-800",
            )}
          >
            {message.text}
          </div>
        )}

        <ActionBar actions={actions} busy={busy} onTransition={transition} />
      </div>

      <Tabs value={sub} onValueChange={setSub} className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-slate-200 px-3">
          <TabsList className="h-9 bg-transparent p-0">
            <TabsTrigger value="data" className="gap-1 text-[12px]">
              <FileText className="h-3.5 w-3.5" /> البيانات
            </TabsTrigger>
            <TabsTrigger value="documents" className="gap-1 text-[12px]">
              <FileSearch className="h-3.5 w-3.5" /> المستندات ({documents.length})
            </TabsTrigger>
            <TabsTrigger value="compare" className="gap-1 text-[12px]">
              <Sparkles className="h-3.5 w-3.5" /> المقارنة
            </TabsTrigger>
            <TabsTrigger value="activity" className="gap-1 text-[12px]">
              <History className="h-3.5 w-3.5" /> سجل الإجراءات ({audit.length})
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <TabsContent value="data" className="mt-0">
            <DataPane app={app} />
          </TabsContent>
          <TabsContent value="documents" className="mt-0">
            <DocumentsPane documents={documents} reading={reading} onOpen={setPreview} />
          </TabsContent>
          <TabsContent value="compare" className="mt-0">
            <ComparePane
              app={app}
              reading={reading}
              verdicts={verdicts}
              busy={busy}
              onReread={() => void runRead(true)}
              onVerdict={async (body) => {
                setBusy(true);
                try {
                  await reviewApi.saveCategoryVerdict(app.id, body);
                  await refreshSide();
                } catch (err) {
                  setMessage({
                    tone: "err",
                    text: err instanceof Error ? err.message : "تعذّر حفظ التحقق",
                  });
                } finally {
                  setBusy(false);
                }
              }}
            />
          </TabsContent>
          <TabsContent value="activity" className="mt-0">
            <AuditPane events={audit} />
          </TabsContent>
        </div>
      </Tabs>

      {preview && (
        <DocumentPreview
          url={reviewApi.documentUrl(app.id, preview.id)}
          title={`${preview.label} — ${preview.originalName}`}
          mimeType={preview.mimeType}
          onClose={() => setPreview(null)}
        />
      )}
    </Card>
  );
}

function roleLabel(role: string): string {
  return (
    { admin: "مدير النظام", approver: "معتمِد", reviewer: "مراجع", observer: "مطّلع" }[role] ?? role
  );
}

// ─── Action bar ────────────────────────────────────────────────────────────

/**
 * The transitions the SERVER says this user may perform.
 *
 * Rendered from `GET .../actions` rather than from a local table: a button that
 * the server will refuse is worse than no button, because the reviewer reads the
 * refusal as a broken screen.
 */
function ActionBar({
  actions,
  busy,
  onTransition,
}: {
  actions: AvailableAction[];
  busy: boolean;
  onTransition: (to: string, body?: Record<string, unknown>) => Promise<void>;
}) {
  const [prompting, setPrompting] = useState<AvailableAction | null>(null);
  const [note, setNote] = useState("");

  if (actions.length === 0) {
    return (
      <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] text-slate-500">
        لا توجد إجراءات متاحة لحالتك الحالية أو لدورك.
      </div>
    );
  }

  const needsNote = (to: string) =>
    ["rejected", "suspended", "needs_information", "needs_documents"].includes(to);

  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-1.5">
        {actions.map((a) => (
          <Button
            key={a.to}
            size="sm"
            variant={
              a.action === "approve" ? "default" : a.action === "reject" ? "destructive" : "outline"
            }
            disabled={busy}
            onClick={() => {
              if (needsNote(a.to)) {
                setPrompting(a);
                setNote("");
              } else {
                void onTransition(a.to);
              }
            }}
          >
            {a.label}
          </Button>
        ))}
      </div>

      {prompting && (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2">
          <div className="text-[12px] font-semibold text-amber-900">
            {prompting.label} — اكتب السبب أو المطلوب من المورد
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="mt-1.5 w-full rounded border border-amber-300 bg-white p-1.5 text-[12px]"
            placeholder="مثال: صورة البطاقة الضريبية غير واضحة — أعد رفعها."
          />
          <div className="mt-1.5 flex gap-1.5">
            <Button
              size="sm"
              disabled={busy || note.trim().length === 0}
              onClick={async () => {
                await onTransition(prompting.to, { note: note.trim() });
                setPrompting(null);
              }}
            >
              تأكيد
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPrompting(null)}>
              إلغاء
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Data pane ─────────────────────────────────────────────────────────────

function DataPane({ app }: { app: ReviewApplicationRow }) {
  return (
    <div className="space-y-3">
      <section>
        <h4 className="mb-1.5 text-[12px] font-bold text-slate-700">بيانات الشركة</h4>
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
          <Field label="اسم الشركة" value={app.name} />
          <Field label="جهة الاتصال" value={app.contactPerson} />
          <Field label="الهاتف" value={app.phone} />
          <Field label="البريد الإلكتروني" value={app.email} />
          <Field label="العنوان" value={app.address} />
          <Field label="السجل التجاري" value={app.commercialRegister} />
          <Field label="الرقم الضريبي" value={app.taxRegistration} />
        </div>
      </section>

      <section>
        <h4 className="mb-1.5 text-[12px] font-bold text-slate-700">التصنيفات والبنود</h4>
        <div className="space-y-2">
          <div>
            <div className="text-[11px] text-slate-500">التصنيفات التجارية</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {(app.tradeCategories ?? []).length === 0 ? (
                <span className="text-[12px] text-slate-400">—</span>
              ) : (
                app.tradeCategories.map((c) => (
                  <span
                    key={c}
                    className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700"
                  >
                    {c === "__other__" ? (app.otherTradeCategory ?? "أخرى") : c}
                  </span>
                ))
              )}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-slate-500">بنود يورّدها المورد</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {(app.suppliedItems ?? []).length === 0 ? (
                <span className="text-[12px] text-slate-400">—</span>
              ) : (
                app.suppliedItems.map((i) => (
                  <span
                    key={i}
                    className="rounded bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-800"
                  >
                    {i}
                  </span>
                ))
              )}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-slate-500">العلامات التجارية</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {(app.brandNames ?? []).length === 0 ? (
                <span className="text-[12px] text-slate-400">—</span>
              ) : (
                app.brandNames.map((b) => (
                  <span
                    key={b}
                    className="rounded bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-800"
                  >
                    {b}
                  </span>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      {app.decisionReason && (
        <section>
          <h4 className="mb-1 text-[12px] font-bold text-rose-700">سبب القرار</h4>
          <p className="rounded-md border border-rose-200 bg-rose-50 p-2 text-[12px] text-rose-800">
            {app.decisionReason}
          </p>
        </section>
      )}
    </div>
  );
}

// ─── Documents pane ────────────────────────────────────────────────────────

function DocumentsPane({
  documents,
  reading,
  onOpen,
}: {
  documents: DocumentView[];
  reading: ReadDocumentsResponse | null;
  onOpen: (doc: DocumentView) => void;
}) {
  if (documents.length === 0) {
    return <EmptyState title="لم يرفع المورد أي مستندات" icon={FileSearch} />;
  }
  const extractionOf = (id: number) =>
    reading?.documents.find((d) => d.id === id)?.extraction ?? null;

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {documents.map((doc) => {
        const ex = extractionOf(doc.id);
        return (
          <div
            key={doc.id}
            className="rounded-md border border-slate-200 bg-white p-2.5 transition hover:shadow-sm"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-slate-800">{doc.label}</div>
                <div className="truncate text-[10px] text-slate-500">{doc.originalName}</div>
              </div>
              {ex && (
                <span
                  className={cn(
                    "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                    ex.unreadable
                      ? "bg-amber-100 text-amber-800"
                      : "bg-emerald-100 text-emerald-800",
                  )}
                >
                  {ex.unreadable
                    ? "غير مقروء"
                    : `مقروء ${ex.confidence ? `(${Math.round(ex.confidence * 100)}%)` : ""}`}
                </span>
              )}
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[10px] text-slate-400">
                {doc.sizeBytes ? `${(doc.sizeBytes / 1024 / 1024).toFixed(1)} MB` : ""}
              </span>
              <Button size="sm" variant="outline" onClick={() => onOpen(doc)}>
                معاينة
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Compare pane ──────────────────────────────────────────────────────────

function ComparePane({
  app,
  reading,
  verdicts,
  busy,
  onReread,
  onVerdict,
}: {
  app: ReviewApplicationRow;
  reading: ReadDocumentsResponse | null;
  verdicts: CategoryVerdictRow[];
  busy: boolean;
  onReread: () => void;
  onVerdict: (body: {
    kind: string;
    name: string;
    verdict: string;
    note?: string;
    refId?: number | null;
  }) => Promise<void>;
}) {
  if (!reading) {
    return (
      <EmptyState
        title="لم تُقرأ المستندات بعد"
        hint="اضغط «اقرأ المستندات وقارن» لاستخراج البيانات ومقارنتها بما أعلنه المورد. النتيجة استرشادية والقرار لك."
        icon={Sparkles}
      />
    );
  }

  const verdictOf = (kind: string, name: string) =>
    verdicts.find((v) => v.kind === kind && v.name === name) ?? null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-slate-500">
          نتائج القراءة الآلية <strong>استرشادية</strong> — لا تُعد إثباتًا قانونيًا. راجع كل حقل
          بنفسك.
        </div>
        <Button size="sm" variant="ghost" onClick={onReread} disabled={busy}>
          <RefreshCw className={cn("ml-1 h-3 w-3", busy && "animate-spin")} /> أعد الفحص
        </Button>
      </div>

      <div className="grid gap-1.5 sm:grid-cols-2">
        {reading.comparison.map((row) => (
          <ComparisonLine key={row.key} row={row} />
        ))}
      </div>

      {reading.brandEvidence.length > 0 && (
        <section>
          <h4 className="mb-1.5 text-[12px] font-bold text-slate-700">إثبات العلامات التجارية</h4>
          <div className="flex flex-wrap gap-1.5">
            {reading.brandEvidence.map((b) => (
              <span
                key={b.brand}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11px]",
                  b.proven
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-slate-200 bg-slate-50 text-slate-600",
                )}
                title={b.sourceDocumentLabel ?? "لا مستند يثبتها"}
              >
                {b.brand} {b.proven ? "✓ مثبت" : "غير مثبت"}
              </span>
            ))}
          </div>
        </section>
      )}

      <section>
        <h4 className="mb-1.5 text-[12px] font-bold text-slate-700">التحقق من النشاط والتصنيفات</h4>
        <p className="mb-1.5 text-[11px] text-slate-500">
          هل المستندات تُثبت أن المورد يتاجر فعلًا في هذه التصنيفات؟ هذا حكمك أنت، لا حكم الآلة.
        </p>
        <div className="space-y-1.5">
          {(app.tradeCategories ?? []).map((cat) => {
            const name = cat === "__other__" ? (app.otherTradeCategory ?? "أخرى") : cat;
            const current = verdictOf("trade", name);
            return (
              <div
                key={`trade:${name}`}
                className="flex flex-wrap items-center justify-between gap-1.5 rounded-md border border-slate-200 bg-white p-2"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-medium text-slate-800">{name}</span>
                  {current && (
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                        current.verdict === "proven"
                          ? "bg-emerald-100 text-emerald-800"
                          : current.verdict === "not_proven"
                            ? "bg-rose-100 text-rose-800"
                            : "bg-amber-100 text-amber-800",
                      )}
                    >
                      {current.label}
                    </span>
                  )}
                </div>
                <div className="flex gap-1">
                  {[
                    { v: "proven", label: "مثبت" },
                    { v: "partial", label: "جزئي" },
                    { v: "not_proven", label: "غير مثبت" },
                    { v: "needs_document", label: "يحتاج مستندًا" },
                  ].map((opt) => (
                    <Button
                      key={opt.v}
                      size="sm"
                      variant={current?.verdict === opt.v ? "default" : "outline"}
                      className="h-6 px-1.5 text-[10px]"
                      disabled={busy}
                      onClick={() => void onVerdict({ kind: "trade", name, verdict: opt.v })}
                    >
                      {opt.label}
                    </Button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// ─── Audit pane ────────────────────────────────────────────────────────────

function AuditPane({ events }: { events: AuditEventRow[] }) {
  if (events.length === 0) {
    return <EmptyState title="لا توجد إجراءات مسجّلة بعد" icon={History} />;
  }
  return (
    <ol className="relative space-y-2 border-r-2 border-slate-200 pr-3">
      {events.map((e) => (
        <li key={e.id} className="relative">
          <span className="absolute -right-[19px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-slate-400" />
          <div className="rounded-md border border-slate-200 bg-white p-2">
            <div className="flex flex-wrap items-center justify-between gap-1">
              <span className="text-[12px] font-semibold text-slate-800">
                {EVENT_LABEL_AR[e.event] ?? e.event}
              </span>
              <span className="text-[10px] text-slate-400" title={formatDateTime(e.createdAt)}>
                {timeAgo(e.createdAt)}
              </span>
            </div>
            {e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus && (
              <div className="mt-0.5 text-[10px] text-slate-500">
                {e.fromStatus} ← {e.toStatus}
              </div>
            )}
            {e.note && <div className="mt-1 text-[11px] text-slate-700">{e.note}</div>}
            {e.actorName && (
              <div className="mt-1 flex items-center gap-1 text-[10px] text-slate-400">
                <UserCheck className="h-2.5 w-2.5" /> {e.actorName}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ─── Dashboard ─────────────────────────────────────────────────────────────

function DashboardTab() {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await reviewApi.dashboard());
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر تحميل المؤشرات");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Card className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> جارٍ التحميل…
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card>
        <EmptyState title="تعذّر تحميل المؤشرات" hint={error ?? undefined} icon={AlertTriangle} />
      </Card>
    );
  }

  const t = data.totals;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-5">
        <KpiTile label="إجمالي الطلبات" value={t.total} tone="info" />
        <KpiTile label="جديدة لم تُراجع" value={t.new} tone="info" />
        <KpiTile label="قيد المراجعة" value={t.underReview + t.assigned} tone="warn" />
        <KpiTile label="بانتظار المورد" value={t.awaitingSupplier} tone="warn" />
        <KpiTile label="متأخرة عن المدة" value={t.late} tone="bad" />
        <KpiTile label="تم فحصها" value={t.verified} tone="good" />
        <KpiTile label="معتمدة" value={t.approved} tone="good" />
        <KpiTile label="مرفوضة" value={t.rejected} tone="bad" />
        <KpiTile
          label="متوسط مدة المراجعة"
          value={t.avgReviewDays === null ? null : `${t.avgReviewDays} يوم`}
          tone="neutral"
          hint="من التقديم حتى القرار"
        />
        <KpiTile
          label="نسبة الاعتماد"
          value={t.approvalRate === null ? null : `${t.approvalRate}%`}
          tone="good"
          hint={t.decided === 0 ? "لا قرارات بعد" : `من ${t.decided} قرارًا`}
        />
      </div>

      <Card className="p-3">
        <h4 className="mb-2 text-[12px] font-bold text-slate-700">توزيع الحالات</h4>
        <div className="flex flex-wrap gap-2">
          {data.byStatus.map((s) => (
            <div
              key={s.status}
              className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1"
            >
              <StatusBadge statusKey={s.status} label={s.label} />
              <span className="text-[13px] font-bold tabular-nums text-slate-800">{s.count}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ─── Reports ───────────────────────────────────────────────────────────────

function ReportsTab() {
  const [data, setData] = useState<ReportsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await reviewApi.reports();
        if (alive) setData(r);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "تعذّر تحميل التقارير");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <Card className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> جارٍ التحميل…
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card>
        <EmptyState title="تعذّر تحميل التقارير" hint={error ?? undefined} icon={AlertTriangle} />
      </Card>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <ReportCard title="المعتمدون حسب التصنيف" rows={data.approvedByCategory} />
      <ReportCard
        title="أسباب الرفض"
        rows={data.rejectionReasons}
        emptyHint="لم يُسجَّل سبب رفض بعد."
      />
      <ReportCard
        title="تصنيفات مقترحة من الموردين"
        rows={data.proposedCategories}
        emptyHint="لم يقترح موردون تصنيفات جديدة."
      />
      <ReportCard title="مستندات أثارت استكمالًا أو رفضًا" rows={data.documentIssues} />
      <Card className="p-3">
        <h4 className="mb-2 text-[12px] font-bold text-slate-700">أداء المراجعين</h4>
        {data.reviewers.length === 0 ? (
          <div className="py-4 text-center text-[12px] text-slate-400">لا توجد بيانات بعد.</div>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-right text-[11px] text-slate-500">
                <th className="pb-1 font-medium">المراجع</th>
                <th className="pb-1 font-medium">راجع</th>
                <th className="pb-1 font-medium">اعتمد</th>
                <th className="pb-1 font-medium">رفض</th>
                <th className="pb-1 font-medium">متوسط المدة</th>
              </tr>
            </thead>
            <tbody>
              {data.reviewers.map((r) => (
                <tr key={r.name} className="border-t border-slate-100">
                  <td className="py-1 font-medium text-slate-800">{r.name}</td>
                  <td className="py-1 tabular-nums">{r.reviewed}</td>
                  <td className="py-1 tabular-nums text-emerald-700">{r.approved}</td>
                  <td className="py-1 tabular-nums text-rose-700">{r.rejected}</td>
                  <td className="py-1 tabular-nums">
                    {r.avgReviewDays === null ? "—" : `${r.avgReviewDays} يوم`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card className="p-3">
        <h4 className="mb-2 text-[12px] font-bold text-slate-700">ملخص</h4>
        <div className="space-y-1.5 text-[12px]">
          <div className="flex items-center justify-between rounded bg-amber-50 px-2 py-1.5">
            <span className="text-amber-900">بانتظار إجراء من المورد</span>
            <span className="font-bold tabular-nums text-amber-900">{data.needsFollowUp}</span>
          </div>
          <div className="rounded bg-slate-50 px-2 py-1.5 text-[11px] text-slate-500">
            {data.provenBrands.available ? "" : data.provenBrands.note}
          </div>
        </div>
      </Card>
    </div>
  );
}

function ReportCard({
  title,
  rows,
  emptyHint,
}: {
  title: string;
  rows: Array<{ name: string; count: number }>;
  emptyHint?: string;
}) {
  return (
    <Card className="p-3">
      <h4 className="mb-2 text-[12px] font-bold text-slate-700">{title}</h4>
      {rows.length === 0 ? (
        <div className="py-4 text-center text-[12px] text-slate-400">
          {emptyHint ?? "لا توجد بيانات بعد."}
        </div>
      ) : (
        <ul className="space-y-1">
          {rows.slice(0, 10).map((r) => (
            <li key={r.name} className="flex items-center justify-between gap-2 text-[12px]">
              <span className="truncate text-slate-700">{r.name}</span>
              <span className="shrink-0 font-bold tabular-nums text-slate-900">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ─── How it works ──────────────────────────────────────────────────────────

function HowItWorksTab() {
  const steps = [
    {
      icon: ClipboardList,
      title: "١. وصول الطلب",
      body: "المورد يتقدّم من بوابة التسجيل (خدمة منفصلة، نفس قاعدة البيانات). الطلب يدخل الطابور بحالة «جديد».",
    },
    {
      icon: UserCheck,
      title: "٢. الإسناد",
      body: "يُسند الطلب لمراجع. من لا يملك صلاحية المراجعة لا يرى أزرار الإجراءات.",
    },
    {
      icon: FileSearch,
      title: "٣. قراءة المستندات",
      body: "زر «اقرأ المستندات وقارن» يستخرج بيانات كل مستند (سجل، بطاقة ضريبية، فاتورة) ويقارنها بما أعلنه المورد. النتيجة استرشادية — القرار لك.",
    },
    {
      icon: ShieldCheck,
      title: "٤. الفحص",
      body: "تراجع كل حقل وتتحقق من أن النشاط مثبت بالمستندات، ثم تنقل الطلب إلى «تم الفحص». لا يمكن الاعتماد قبل هذه الخطوة.",
    },
    {
      icon: CheckCircle2,
      title: "٥. الاعتماد",
      body: "الاعتماد ينشئ ملف مورد فعليًا في النظام مع تصنيفاته التجارية وتصنيفات البنود. الرفض يتطلب سببًا مكتوبًا.",
    },
    {
      icon: XCircle,
      title: "٦. الرفض أو التعليق",
      body: "الرفض يوقف الطلب بسبب مسجّل. التعليق يوقف موردًا معتمدًا مؤقتًا (مثل مستند منتهٍ) ويمكن استئنافه.",
    },
    {
      icon: History,
      title: "٧. سجل الإجراءات",
      body: "كل تغيير حالة يُسجَّل باسم الموظف ووقته والسبب. السجل للقراءة فقط ولا يمكن تعديله.",
    },
  ];
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {steps.map((s) => (
        <Card key={s.title} className="flex gap-2.5 p-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100">
            <s.icon className="h-4 w-4 text-slate-600" />
          </div>
          <div>
            <div className="text-[12px] font-bold text-slate-800">{s.title}</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600">{s.body}</p>
          </div>
        </Card>
      ))}
    </div>
  );
}
