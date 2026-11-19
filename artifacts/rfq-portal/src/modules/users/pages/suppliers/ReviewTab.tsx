/**
 * Supplier portal applications — the review tab.
 *
 * Suppliers apply through a SEPARATE public portal (its own repository and
 * service, same database). This tab is where an employee reads those
 * applications, matches the uploaded documents against the declared data, and
 * approves the good ones into the supplier list.
 *
 * The console is deliberately two-paned and never navigates away: a reviewer
 * works through a queue all day, and a page change per application is what makes
 * him stop using the screen.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ExternalLink, FileText, Loader2, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/contexts/LanguageContext";
import { getApiErrorMessage } from "@/lib/api-error";
import { cn } from "@/lib/utils";

interface ReviewApplication {
  id: number;
  reference: string;
  status: string;
  name: string;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  commercialRegister: string | null;
  taxRegistration: string | null;
  bankName: string | null;
  bankAccountHolder: string | null;
  bankAccountNumber: string | null;
  iban: string | null;
  swiftCode: string | null;
  bankBranch: string | null;
  tradeCategories: string[];
  itemCategoryIds: number[];
  otherTradeCategory: string | null;
  suppliedItems: string[];
  brandNames: string[];
  notes: string | null;
  verification: Record<string, string>;
  supplierId: number | null;
  createdAt: string;
}

interface ReviewDocument {
  id: number;
  slot: string;
  label: string;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedAt: string;
}

interface ReviewDetail {
  application: ReviewApplication;
  documents: ReviewDocument[];
  itemCategoryNames: Array<{ id: number; name: string }>;
}

/** The declared fields worth matching, each against the document that proves it. */
const MATCH_FIELDS: Array<{ key: keyof ReviewApplication; slot: string; labelKey: string }> = [
  { key: "name", slot: "commercial_register", labelKey: "rev.bankAccountHolder" },
  { key: "commercialRegister", slot: "commercial_register", labelKey: "rev.commercialRegister" },
  { key: "taxRegistration", slot: "tax_card", labelKey: "rev.taxRegistration" },
  { key: "bankName", slot: "bank_letter", labelKey: "rev.bankName" },
  { key: "bankAccountHolder", slot: "bank_letter", labelKey: "rev.bankAccountHolder" },
  { key: "bankAccountNumber", slot: "bank_letter", labelKey: "rev.bankAccountNumber" },
  { key: "iban", slot: "bank_letter", labelKey: "rev.iban" },
  { key: "swiftCode", slot: "bank_letter", labelKey: "rev.swift" },
];

const STATUS_TONE: Record<string, string> = {
  submitted: "bg-blue-100 text-blue-700",
  under_review: "bg-amber-100 text-amber-700",
  needs_info: "bg-orange-100 text-orange-700",
  approved: "bg-emerald-100 text-emerald-700",
  rejected: "bg-rose-100 text-rose-700",
  draft: "bg-slate-100 text-slate-600",
};

const FILTERS = ["", "submitted", "under_review", "needs_info", "approved", "rejected"];

function bytes(n?: number | null): string {
  if (!n) return "";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function SupplierReviewTab() {
  const { t } = useLanguage();
  const [apps, setApps] = useState<ReviewApplication[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [openDoc, setOpenDoc] = useState<ReviewDocument | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter) params.set("status", filter);
      if (search.trim()) params.set("q", search.trim());
      const res = await fetch(`/api/supplier-review/applications?${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(t("rev.loading"));
      const data = (await res.json()) as {
        applications: ReviewApplication[];
        counts: Record<string, number>;
      };
      setApps(data.applications);
      setCounts(data.counts);
    } catch {
      setApps([]);
    } finally {
      setLoading(false);
    }
  }, [filter, search, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(async (id: number) => {
    setSelectedId(id);
    setDetail(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/supplier-review/applications/${id}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("تعذّر تحميل الطلب");
      setDetail((await res.json()) as ReviewDetail);
    } catch (err) {
      setMessage({ tone: "err", text: getApiErrorMessage(err) });
    }
  }, []);

  const setVerdict = async (field: string, verdict: string) => {
    if (!detail) return;
    const next = { ...detail.application.verification, [field]: verdict };
    setDetail({ ...detail, application: { ...detail.application, verification: next } });
    try {
      await fetch(`/api/supplier-review/applications/${detail.application.id}/verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ verification: next }),
      });
    } catch {
      /* the verdict stays on screen; a failed save is retried by the next click */
    }
  };

  const approve = async () => {
    if (!detail) return;
    if (!window.confirm(t("rev.approveConfirm"))) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/supplier-review/applications/${detail.application.id}/approve`,
        { method: "POST", credentials: "include" },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string; supplierId?: number };
      if (!res.ok) throw new Error(data.error || t("rev.approveFailed"));
      setMessage({
        tone: "ok",
        text: `${t("rev.approved")} — ${t("rev.approvedWith").replace("{id}", String(data.supplierId))}`,
      });
      await Promise.all([load(), openDetail(detail.application.id)]);
    } catch (err) {
      setMessage({ tone: "err", text: getApiErrorMessage(err, t("rev.approveFailed")) });
    } finally {
      setBusy(false);
    }
  };

  const docFor = (slot: string) => detail?.documents.find((d) => d.slot === slot) ?? null;
  const mismatches = useMemo(
    () =>
      Object.entries(detail?.application.verification ?? {}).filter(([, v]) => v === "mismatch"),
    [detail],
  );

  return (
    <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      {/* ── Queue ─────────────────────────────────────────────────── */}
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f || "all"}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-semibold transition",
                filter === f
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70",
              )}
            >
              {f ? t(`rev.filter.${f}`) : t("rev.filter.all")}
              {f && counts[f] ? ` (${counts[f]})` : ""}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-3 rtl:right-3" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("rev.search")}
            className="ltr:pl-9 rtl:pr-9"
          />
        </div>

        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : apps.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t("rev.empty")}</p>
        ) : (
          <div className="max-h-[70vh] space-y-1.5 overflow-y-auto">
            {apps.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => void openDetail(a.id)}
                className={cn(
                  "w-full rounded-lg border p-3 text-start transition",
                  selectedId === a.id
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40 hover:bg-muted/40",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold">{a.name}</span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                      STATUS_TONE[a.status] ?? STATUS_TONE.draft,
                    )}
                  >
                    {t(`rev.filter.${a.status}`)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{a.reference}</span>
                  <span>·</span>
                  <span>{new Date(a.createdAt).toLocaleDateString("en-GB")}</span>
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {a.tradeCategories.slice(0, 3).join("، ") || t("rev.noTrade")}
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* ── Detail ────────────────────────────────────────────────── */}
      <Card className="space-y-4 p-5">
        {!selectedId ? (
          <p className="py-24 text-center text-sm text-muted-foreground">{t("rev.select")}</p>
        ) : !detail ? (
          <div className="flex justify-center py-24">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {message && (
              <div
                className={cn(
                  "rounded-lg px-3 py-2 text-sm",
                  message.tone === "ok"
                    ? "bg-emerald-50 text-emerald-800"
                    : "bg-rose-50 text-rose-800",
                )}
              >
                {message.text}
              </div>
            )}

            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">{detail.application.name}</h2>
                <p className="font-mono text-xs text-muted-foreground">
                  {detail.application.reference}
                </p>
              </div>
              <span
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-semibold",
                  STATUS_TONE[detail.application.status] ?? STATUS_TONE.draft,
                )}
              >
                {t(`rev.filter.${detail.application.status}`)}
              </span>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Field label={t("rev.contact")} value={detail.application.contactPerson} />
              <Field label={t("rev.email")} value={detail.application.email} />
              <Field label={t("rev.phone")} value={detail.application.phone} />
              <Field label={t("rev.address")} value={detail.application.address} />
              <Field
                label={t("rev.commercialRegister")}
                value={detail.application.commercialRegister}
              />
              <Field label={t("rev.taxRegistration")} value={detail.application.taxRegistration} />
            </dl>

            <div className="rounded-lg bg-muted/40 p-3">
              <div className="mb-2 text-xs font-bold text-muted-foreground">{t("rev.bank")}</div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <Field label={t("rev.bankName")} value={detail.application.bankName} />
                <Field label={t("rev.bankBranch")} value={detail.application.bankBranch} />
                <Field
                  label={t("rev.bankAccountHolder")}
                  value={detail.application.bankAccountHolder}
                />
                <Field
                  label={t("rev.bankAccountNumber")}
                  value={detail.application.bankAccountNumber}
                />
                <Field label={t("rev.iban")} value={detail.application.iban} />
                <Field label={t("rev.swift")} value={detail.application.swiftCode} />
              </dl>
            </div>

            {/* Categories: what the supplier will be filed under, in words. */}
            <div>
              <div className="mb-1.5 text-xs font-bold text-muted-foreground">
                {t("rev.categories")}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {detail.application.tradeCategories.length === 0 && (
                  <span className="text-sm text-amber-600">{t("rev.noTrade")}</span>
                )}
                {detail.application.tradeCategories.map((c) => (
                  <Badge key={c} variant="secondary">
                    {c}
                  </Badge>
                ))}
              </div>
              {detail.application.otherTradeCategory && (
                <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <strong>{t("rev.otherCategory")}:</strong> {detail.application.otherTradeCategory}{" "}
                  — {t("rev.otherCategoryNote")}
                </div>
              )}
              {detail.itemCategoryNames.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {detail.itemCategoryNames.map((c) => (
                    <span
                      key={c.id}
                      className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700"
                    >
                      {c.name}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {(detail.application.suppliedItems.length > 0 ||
              detail.application.brandNames.length > 0) && (
              <div className="space-y-2 rounded-lg bg-muted/40 p-3">
                {detail.application.suppliedItems.length > 0 && (
                  <div>
                    <div className="mb-1 text-xs font-bold text-muted-foreground">
                      {t("rev.items")} ({detail.application.suppliedItems.length})
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {detail.application.suppliedItems.map((it) => (
                        <span
                          key={it}
                          className="rounded bg-background px-2 py-0.5 text-xs ring-1 ring-border"
                        >
                          {it}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {detail.application.brandNames.length > 0 && (
                  <div>
                    <div className="mb-1 text-xs font-bold text-muted-foreground">
                      {t("rev.brands")}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {detail.application.brandNames.map((b) => (
                        <span
                          key={b}
                          className="rounded bg-background px-2 py-0.5 text-xs font-semibold ring-1 ring-border"
                        >
                          {b}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {detail.application.notes && (
              <div className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">
                <strong>{t("rev.notes")}:</strong> {detail.application.notes}
              </div>
            )}

            {/* ── Document matching ─────────────────────────────────── */}
            <div className="space-y-3 border-t border-border pt-4">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold text-muted-foreground">{t("rev.matching")}</div>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="rounded bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700">
                    {t("rev.matched")}{" "}
                    {
                      Object.values(detail.application.verification).filter((v) => v === "matched")
                        .length
                    }
                  </span>
                  {mismatches.length > 0 && (
                    <span className="rounded bg-rose-100 px-2 py-0.5 font-semibold text-rose-700">
                      {t("rev.mismatch")} {mismatches.length}
                    </span>
                  )}
                </div>
              </div>

              {detail.documents.length === 0 && (
                <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
                  {t("rev.noDocuments")}
                </div>
              )}

              <ul className="divide-y divide-border rounded-lg border border-border">
                {MATCH_FIELDS.map((f) => {
                  const value = detail.application[f.key];
                  const verdict = detail.application.verification[String(f.key)] ?? "unchecked";
                  const doc = docFor(f.slot);
                  return (
                    <li key={String(f.key)} className="flex items-center gap-3 p-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-muted-foreground">{t(f.labelKey)}</div>
                        <div className="truncate text-sm font-medium">
                          {typeof value === "string" && value ? value : "—"}
                        </div>
                        <button
                          type="button"
                          disabled={!doc}
                          onClick={() => doc && setOpenDoc(doc)}
                          className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-primary underline decoration-dotted disabled:text-muted-foreground disabled:no-underline"
                        >
                          {doc ? (
                            <>
                              <FileText className="h-3 w-3 shrink-0" />
                              {doc.originalName}
                            </>
                          ) : (
                            t("rev.noDocumentForField")
                          )}
                        </button>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        {(
                          [
                            ["unchecked", "bg-muted text-muted-foreground"],
                            ["matched", "bg-emerald-100 text-emerald-700"],
                            ["mismatch", "bg-rose-100 text-rose-700"],
                          ] as const
                        ).map(([v, cls]) => (
                          <button
                            key={v}
                            type="button"
                            onClick={() => void setVerdict(String(f.key), v)}
                            className={cn(
                              "rounded px-2 py-1 text-[11px] font-semibold transition",
                              verdict === v ? cls : "bg-background text-muted-foreground",
                            )}
                          >
                            {t(`rev.${v === "unchecked" ? "unchecked" : v}`)}
                          </button>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>

              {/* Uploaded documents that no declared field points at — the
                  reviewer still needs to SEE them (a previous invoice, prior
                  work), so they are listed rather than silently dropped. */}
              {detail.documents.filter((d) => !MATCH_FIELDS.some((f) => f.slot === d.slot)).length >
                0 && (
                <div>
                  <div className="mb-1 text-xs font-bold text-muted-foreground">
                    {t("rev.documents")}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.documents
                      .filter((d) => !MATCH_FIELDS.some((f) => f.slot === d.slot))
                      .map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() => setOpenDoc(d)}
                          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                        >
                          <FileText className="h-3 w-3" />
                          {d.label} — {d.originalName}
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>

            {/* ── Decision ──────────────────────────────────────────── */}
            {detail.application.status === "approved" ? (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                {detail.application.supplierId
                  ? t("rev.approvedWith").replace("{id}", String(detail.application.supplierId))
                  : t("rev.alreadyApproved")}
              </div>
            ) : detail.application.status === "rejected" ? (
              <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
                {t("rev.rejectedNotice")}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
                <Button onClick={() => void approve()} disabled={busy}>
                  {busy ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> {t("rev.approving")}
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4" /> {t("rev.approve")}
                    </>
                  )}
                </Button>
                {mismatches.length > 0 && (
                  <span className="text-xs text-rose-600">
                    {t("rev.mismatch")}: {mismatches.length}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </Card>

      {/* ── Document viewer ───────────────────────────────────────── */}
      {openDoc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpenDoc(null)}
        >
          <div
            className="flex h-full max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-background"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{openDoc.label}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {openDoc.originalName} {bytes(openDoc.sizeBytes)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={`/api/supplier-review/documents/${openDoc.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-semibold hover:bg-muted"
                >
                  <ExternalLink className="h-3 w-3" /> {t("rev.openInTab")}
                </a>
                <Button variant="ghost" size="sm" onClick={() => setOpenDoc(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-muted">
              {openDoc.mimeType?.startsWith("image/") ? (
                <img
                  src={`/api/supplier-review/documents/${openDoc.id}`}
                  alt={openDoc.originalName}
                  className="mx-auto max-w-full"
                />
              ) : openDoc.mimeType === "application/pdf" ? (
                <iframe
                  title={openDoc.originalName}
                  src={`/api/supplier-review/documents/${openDoc.id}`}
                  className="h-full w-full"
                />
              ) : (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  {t("rev.cannotPreview")}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value || "—"}</dd>
    </div>
  );
}

export default SupplierReviewTab;
