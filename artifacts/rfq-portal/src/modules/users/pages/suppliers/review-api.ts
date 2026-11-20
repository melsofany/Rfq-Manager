/**
 * The shared client for the supplier review centre.
 *
 * Every call goes through here so the console has ONE place that knows the
 * endpoint shapes and ONE place that extracts the server's error message. The
 * generated orval client does not cover these routes (they are not in the
 * OpenAPI spec — same as receipts/deliveries/accounts), so the `ApiError` body
 * extraction has to be done by hand; doing it inline in ten components is how
 * a real server message becomes a generic «حدث خطأ».
 */
import { getApiErrorMessage } from "@/lib/api-error";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body — the helper handles a null payload */
    }
    throw new Error(getApiErrorMessage({ data: body, status: res.status } as never));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type ReviewStatusKey =
  | "new"
  | "assigned"
  | "under_review"
  | "needs_information"
  | "needs_documents"
  | "resubmitted"
  | "verified"
  | "approved"
  | "rejected"
  | "suspended";

export interface ReviewApplicationRow {
  id: number;
  reference: string;
  status: string;
  statusKey: ReviewStatusKey;
  statusLabel: string;
  name: string;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  commercialRegister: string | null;
  taxRegistration: string | null;
  tradeCategories: string[];
  otherTradeCategory: string | null;
  itemCategoryIds: number[];
  suppliedItems: string[];
  brandNames: string[];
  assignedEmployeeId: number | null;
  assignedEmployeeName: string | null;
  dueAt: string | null;
  isLate: boolean;
  priority: string | null;
  decisionReason: string | null;
  supplierId: number | null;
  createdAt: string;
  submittedAt: string | null;
}

export interface DashboardTotals {
  total: number;
  new: number;
  assigned: number;
  underReview: number;
  needsInformation: number;
  needsDocuments: number;
  resubmitted: number;
  verified: number;
  approved: number;
  rejected: number;
  suspended: number;
  awaitingSupplier: number;
  late: number;
  decided: number;
  avgReviewDays: number | null;
  approvalRate: number | null;
  slaDays: number;
}

export interface DashboardResponse {
  totals: DashboardTotals;
  byStatus: Array<{ status: string; label: string; count: number }>;
}

export interface ComparisonRow {
  key: string;
  label: string;
  declared: string | null;
  extracted: string | null;
  result: string;
  sourceDocumentId: number | null;
  sourceDocumentLabel: string | null;
}

export interface ExtractionView {
  companyName: string | null;
  taxRegistration: string | null;
  commercialRegister: string | null;
  activity: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  items: string[];
  brands: string[];
  issuer: string | null;
  invoiceValue: string | null;
  unreadable: boolean;
  confidence: number | null;
  rawText: string | null;
}

export interface DocumentView {
  id: number;
  slot: string;
  label: string;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedAt?: string;
  freshlyRead?: boolean;
  extraction?: ExtractionView;
}

export interface ReadDocumentsResponse {
  documents: Array<DocumentView & { extraction: ExtractionView }>;
  comparison: ComparisonRow[];
  brandEvidence: Array<{
    brand: string;
    proven: boolean;
    sourceDocumentId: number | null;
    sourceDocumentLabel: string | null;
  }>;
  summary: {
    documents: number;
    unreadable: number;
    matched: number;
    mismatched: number;
    notFound: number;
  };
}

export interface CategoryVerdictRow {
  kind: string;
  refId: number | null;
  name: string;
  verdict: string;
  label: string;
  note: string | null;
  employeeName: string | null;
  updatedAt: string;
}

export interface AuditEventRow {
  id: number;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  actorName: string | null;
  actorId: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AvailableAction {
  to: string;
  action: string;
  label: string;
}

export interface ReportsResponse {
  approvedByCategory: Array<{ name: string; count: number }>;
  rejectionReasons: Array<{ name: string; count: number }>;
  needsFollowUp: number;
  proposedCategories: Array<{ name: string; count: number }>;
  reviewers: Array<{
    name: string;
    reviewed: number;
    approved: number;
    rejected: number;
    avgReviewDays: number | null;
  }>;
  documentIssues: Array<{ name: string; count: number }>;
  provenBrands: { available: boolean; note: string };
}

export const reviewApi = {
  dashboard: (params: Record<string, string> = {}) =>
    request<DashboardResponse>(`/supplier-review/dashboard?${new URLSearchParams(params)}`),

  applications: (params: Record<string, string> = {}) =>
    request<{ applications: ReviewApplicationRow[]; counts: Record<string, number> }>(
      `/supplier-review/applications?${new URLSearchParams(params)}`,
    ),

  detail: (id: number) => request<unknown>(`/supplier-review/applications/${id}`),

  actions: (id: number) =>
    request<{ role: string; from: string; available: AvailableAction[] }>(
      `/supplier-review/applications/${id}/actions`,
    ),

  transition: (id: number, body: Record<string, unknown>) =>
    request<{ ok: boolean; from: string; to: string; label: string }>(
      `/supplier-review/applications/${id}/transition`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  readDocuments: (id: number, force = false) =>
    request<ReadDocumentsResponse>(`/supplier-review/applications/${id}/read-documents`, {
      method: "POST",
      body: JSON.stringify({ force }),
    }),

  categoryVerdicts: (id: number) =>
    request<{ verdicts: CategoryVerdictRow[] }>(
      `/supplier-review/applications/${id}/category-verdicts`,
    ),

  saveCategoryVerdict: (
    id: number,
    body: { kind: string; name: string; verdict: string; note?: string; refId?: number | null },
  ) =>
    request<{ ok: boolean }>(`/supplier-review/applications/${id}/category-verdicts`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  audit: (id: number) =>
    request<{ events: AuditEventRow[] }>(`/supplier-review/applications/${id}/audit`),

  reports: (params: Record<string, string> = {}) =>
    request<ReportsResponse>(`/supplier-review/reports?${new URLSearchParams(params)}`),

  approve: (id: number) =>
    request<{ ok: boolean; supplierId?: number }>(`/supplier-review/applications/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  documentUrl: (applicationId: number, documentId: number) =>
    `/api/supplier-review/applications/${applicationId}/documents/${documentId}`,
  /** The printable supplier file (cover + data + every attachment). */
  fileUrl: (applicationId: number) => `/api/supplier-review/applications/${applicationId}/file.pdf`,
};

/** The status colour per stage — one map, used by the badge and the filters. */
export const STATUS_TONE: Record<string, string> = {
  new: "bg-blue-100 text-blue-700 border-blue-200",
  assigned: "bg-sky-100 text-sky-700 border-sky-200",
  under_review: "bg-amber-100 text-amber-700 border-amber-200",
  needs_information: "bg-orange-100 text-orange-700 border-orange-200",
  needs_documents: "bg-orange-100 text-orange-700 border-orange-200",
  resubmitted: "bg-violet-100 text-violet-700 border-violet-200",
  verified: "bg-teal-100 text-teal-700 border-teal-200",
  approved: "bg-emerald-100 text-emerald-700 border-emerald-200",
  rejected: "bg-rose-100 text-rose-700 border-rose-200",
  suspended: "bg-slate-200 text-slate-700 border-slate-300",
};

/** The comparison verdict colour. A reordered match is a MATCH, shown as such. */
export const COMPARE_TONE: Record<string, string> = {
  match: "bg-emerald-50 text-emerald-700 border-emerald-200",
  match_reordered: "bg-emerald-50 text-emerald-700 border-emerald-200",
  mismatch: "bg-rose-50 text-rose-700 border-rose-200",
  not_in_document: "bg-slate-100 text-slate-600 border-slate-200",
  unreadable: "bg-amber-50 text-amber-700 border-amber-200",
  expired: "bg-rose-50 text-rose-700 border-rose-200",
  extraction_failed: "bg-amber-50 text-amber-700 border-amber-200",
  manual_review: "bg-sky-50 text-sky-700 border-sky-200",
};

export const COMPARE_LABEL_AR: Record<string, string> = {
  match: "متطابق",
  match_reordered: "متطابق (ترتيب المجموعات معكوس)",
  mismatch: "اختلاف يحتاج مراجعة",
  not_in_document: "غير موجود في المستند",
  unreadable: "مستند غير واضح",
  expired: "منتهي الصلاحية",
  extraction_failed: "تعذر استخراج البيانات",
  manual_review: "يحتاج تحققًا يدويًا",
};

export const EVENT_LABEL_AR: Record<string, string> = {
  submitted: "تم التقديم",
  review_assigned: "تم الإسناد لمراجع",
  review_started: "بدأت المراجعة",
  field_verdict: "حكم على حقل",
  document_comparison: "مقارنة المستندات",
  info_requested: "طُلب استكمال بيانات",
  docs_requested: "طُلب مستندات إضافية",
  resubmitted: "أعاد المورد التقديم",
  verified: "اجتاز الفحص",
  approved: "تم الاعتماد",
  rejected: "تم الرفض",
  suspended: "تم التعليق",
  resumed: "استُؤنف",
  document_viewed: "اطّلع على مستند",
  document_downloaded: "حمّل مستندًا",
  category_verdict: "تحقق من نشاط",
  decision_blocked: "مُنع قرار",
  status_changed: "تغيّرت الحالة",
  document_uploaded: "رُفع مستند",
  email_verified: "تم التحقق من البريد",
};

/** «منذ ٣ ساعات» — a timestamp is read as elapsed time on an audit trail. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "الآن";
  if (mins < 60) return `منذ ${mins} دقيقة`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `منذ ${hours} ساعة`;
  const days = Math.round(hours / 24);
  if (days < 30) return `منذ ${days} يوم`;
  return new Date(iso).toLocaleDateString("en-GB");
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-GB");
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}
