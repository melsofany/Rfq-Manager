/**
 * The supplier-application review lifecycle.
 *
 * Pure: no database, no request. Every transition rule lives here so the route
 * and the tests read the SAME rule — a second copy of the state machine is how
 * a route starts accepting a move the console refuses to offer.
 *
 * Two invariants the operator stated, encoded rather than documented:
 *   * a human decides. Nothing here allows VERIFIED/APPROVED to be reached from
 *     an OCR result; the transitions require an explicit move by an employee.
 *   * a decision is reversible only through an audited transition, never by
 *     writing the status column.
 */

/** The ten states of the review cycle, in lifecycle order. */
export const REVIEW_STATUS = {
  NEW: "new",
  ASSIGNED: "assigned",
  UNDER_REVIEW: "under_review",
  NEEDS_INFORMATION: "needs_information",
  NEEDS_DOCUMENTS: "needs_documents",
  RESUBMITTED: "resubmitted",
  VERIFIED: "verified",
  APPROVED: "approved",
  REJECTED: "rejected",
  SUSPENDED: "suspended",
} as const;

export type ReviewStatus = (typeof REVIEW_STATUS)[keyof typeof REVIEW_STATUS];

export const REVIEW_STATUS_VALUES: readonly ReviewStatus[] = Object.values(REVIEW_STATUS);

/** Arabic labels — the console is Arabic-first. */
export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  new: "طلب جديد",
  assigned: "مُسند لمراجع",
  under_review: "قيد المراجعة",
  needs_information: "يحتاج استكمال بيانات",
  needs_documents: "يحتاج مستندات إضافية",
  resubmitted: "تم استكمال المطلوب",
  verified: "اجتاز الفحص",
  approved: "معتمد",
  rejected: "مرفوض",
  suspended: "موقوف مؤقتًا",
};

/**
 * Statuses the portal itself can produce. The portal writes `draft`,
 * `submitted`, `under_review`, `needs_info`, `approved`, `rejected`; the
 * remaining states are review-only. Both vocabularies must be readable, so the
 * legacy names map onto the review vocabulary rather than being rejected.
 */
const PORTAL_ALIASES: Record<string, ReviewStatus> = {
  draft: REVIEW_STATUS.NEW,
  submitted: REVIEW_STATUS.NEW,
  under_review: REVIEW_STATUS.UNDER_REVIEW,
  needs_info: REVIEW_STATUS.NEEDS_INFORMATION,
  approved: REVIEW_STATUS.APPROVED,
  rejected: REVIEW_STATUS.REJECTED,
};

/** Normalise whatever the row holds into one vocabulary. */
export function normalizeStatus(raw: string | null | undefined): ReviewStatus {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return REVIEW_STATUS.NEW;
  if (REVIEW_STATUS_VALUES.includes(value as ReviewStatus)) return value as ReviewStatus;
  return PORTAL_ALIASES[value] ?? REVIEW_STATUS.NEW;
}

/**
 * Which moves are legal from each state.
 *
 * Deliberately NOT a free-for-all: a terminal decision is final unless someone
 * with the authority reopens it through SUSPENDED, which is an audited action
 * with a reason. Allowing APPROVED → UNDER_REVIEW directly would let a second
 * reviewer silently reverse a decision that already created a supplier.
 */
const TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  new: [
    REVIEW_STATUS.ASSIGNED,
    REVIEW_STATUS.UNDER_REVIEW,
    REVIEW_STATUS.NEEDS_INFORMATION,
    REVIEW_STATUS.NEEDS_DOCUMENTS,
    REVIEW_STATUS.REJECTED,
  ],
  assigned: [
    REVIEW_STATUS.UNDER_REVIEW,
    REVIEW_STATUS.NEEDS_INFORMATION,
    REVIEW_STATUS.NEEDS_DOCUMENTS,
    REVIEW_STATUS.REJECTED,
  ],
  under_review: [
    REVIEW_STATUS.NEEDS_INFORMATION,
    REVIEW_STATUS.NEEDS_DOCUMENTS,
    REVIEW_STATUS.VERIFIED,
    REVIEW_STATUS.REJECTED,
    REVIEW_STATUS.SUSPENDED,
  ],
  needs_information: [REVIEW_STATUS.RESUBMITTED, REVIEW_STATUS.REJECTED, REVIEW_STATUS.SUSPENDED],
  needs_documents: [REVIEW_STATUS.RESUBMITTED, REVIEW_STATUS.REJECTED, REVIEW_STATUS.SUSPENDED],
  resubmitted: [
    REVIEW_STATUS.UNDER_REVIEW,
    REVIEW_STATUS.NEEDS_INFORMATION,
    REVIEW_STATUS.NEEDS_DOCUMENTS,
    REVIEW_STATUS.VERIFIED,
    REVIEW_STATUS.REJECTED,
  ],
  verified: [REVIEW_STATUS.APPROVED, REVIEW_STATUS.REJECTED, REVIEW_STATUS.SUSPENDED],
  approved: [REVIEW_STATUS.SUSPENDED],
  rejected: [REVIEW_STATUS.SUSPENDED],
  suspended: [REVIEW_STATUS.UNDER_REVIEW, REVIEW_STATUS.REJECTED],
};

/**
 * Every stored spelling that MEANS a given review status.
 *
 * The portal writes its own names (`submitted`, `needs_info`) into the same
 * column the review console reads, so a filter on the console's vocabulary must
 * expand to all of them — otherwise the queue shows rows while its own filter
 * returns none, which reads as «the filter is broken».
 */
export function statusAliases(status: string): string[] {
  const key = normalizeStatus(status);
  const aliases = new Set<string>([status, key]);
  for (const [raw, mapped] of Object.entries(PORTAL_ALIASES)) {
    if (mapped === key) aliases.add(raw);
  }
  return [...aliases];
}

/** Statuses that describe an OPEN piece of work for a reviewer. */
export const OPEN_STATUSES: readonly ReviewStatus[] = [
  REVIEW_STATUS.NEW,
  REVIEW_STATUS.ASSIGNED,
  REVIEW_STATUS.UNDER_REVIEW,
  REVIEW_STATUS.RESUBMITTED,
];

/** Statuses that need the SUPPLIER to act, not us. */
export const AWAITING_SUPPLIER_STATUSES: readonly ReviewStatus[] = [
  REVIEW_STATUS.NEEDS_INFORMATION,
  REVIEW_STATUS.NEEDS_DOCUMENTS,
];

/** Statuses that are a finished decision. */
export const DECIDED_STATUSES: readonly ReviewStatus[] = [
  REVIEW_STATUS.APPROVED,
  REVIEW_STATUS.REJECTED,
];

export interface TransitionCheck {
  ok: boolean;
  /** Arabic reason, ready to hand back to the reviewer. */
  error?: string;
}

/**
 * Can `from` move to `to`?
 *
 * A no-op move (same status) is refused: it would write an audit row claiming
 * an action that changed nothing, which pollutes the trail an auditor reads.
 */
export function canTransition(from: ReviewStatus, to: ReviewStatus): TransitionCheck {
  if (from === to) {
    return { ok: false, error: `الطلب في حالة «${REVIEW_STATUS_LABELS[from]}» بالفعل` };
  }
  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      error: `لا يمكن الانتقال من «${REVIEW_STATUS_LABELS[from]}» إلى «${REVIEW_STATUS_LABELS[to]}»`,
    };
  }
  return { ok: true };
}

/**
 * A transition that requires a written reason.
 *
 * Rejection and suspension are decisions someone will be asked to justify —
 * to the supplier, or to the manager who reopens the file. An approval needs no
 * reason (it is the expected outcome) but a rejection without one is
 * unauditable.
 */
export function requiresReason(to: ReviewStatus): boolean {
  return to === REVIEW_STATUS.REJECTED || to === REVIEW_STATUS.SUSPENDED;
}

/**
 * A move that must carry documents or a note for the supplier — otherwise the
 * supplier receives «استكمل المطلوب» with no idea what is missing.
 */
export function requiresRequestDetail(to: ReviewStatus): boolean {
  return to === REVIEW_STATUS.NEEDS_INFORMATION || to === REVIEW_STATUS.NEEDS_DOCUMENTS;
}

/**
 * The role each transition needs.
 *
 * `verified` is a REVIEWER act (he checked the documents); `approved` is a
 * separate APPROVER act. Splitting them is what makes «لا يجوز تحويل الطلب إلى
 * APPROVED لمجرد اجتياز OCR» structural instead of advisory.
 */
export type ReviewAction =
  | "assign"
  | "review"
  | "request_info"
  | "request_docs"
  | "verify"
  | "approve"
  | "reject"
  | "suspend"
  | "resume";

export const ACTION_FOR_TARGET: Partial<Record<ReviewStatus, ReviewAction>> = {
  [REVIEW_STATUS.ASSIGNED]: "assign",
  [REVIEW_STATUS.UNDER_REVIEW]: "review",
  [REVIEW_STATUS.NEEDS_INFORMATION]: "request_info",
  [REVIEW_STATUS.NEEDS_DOCUMENTS]: "request_docs",
  [REVIEW_STATUS.VERIFIED]: "verify",
  [REVIEW_STATUS.APPROVED]: "approve",
  [REVIEW_STATUS.REJECTED]: "reject",
  [REVIEW_STATUS.SUSPENDED]: "suspend",
  [REVIEW_STATUS.RESUBMITTED]: "resume",
};

/**
 * The four job roles the operator specified.
 *
 * `admin`      — everything, including granting permissions.
 * `reviewer`   — reads, reviews, verifies, requests more; recommends.
 * `approver`   — decides. Must be able to read what the reviewer verified.
 * `observer`   — reads and reports; cannot change or decide.
 *
 * `manager` in the existing system maps to `approver` (it already owns the
 * supplier write actions); `admin` keeps full authority.
 */
export type ReviewRole = "admin" | "approver" | "reviewer" | "observer";

const ROLE_ACTIONS: Record<ReviewRole, readonly ReviewAction[]> = {
  admin: [
    "assign",
    "review",
    "request_info",
    "request_docs",
    "verify",
    "approve",
    "reject",
    "suspend",
    "resume",
  ],
  approver: [
    "assign",
    "review",
    "request_info",
    "request_docs",
    "verify",
    "approve",
    "reject",
    "suspend",
    "resume",
  ],
  reviewer: ["review", "request_info", "request_docs", "verify"],
  observer: [],
};

/** Map the system's employee role onto a review role. */
export function reviewRoleOf(
  role: string | null | undefined,
  permissions?: Record<string, boolean> | null,
): ReviewRole {
  const value = (role ?? "").trim().toLowerCase();
  if (value === "admin") return "admin";
  // An explicit grant beats the role default — the same rule the rest of the
  // permission system uses, so a data-entry employee granted `supplier-review:approve`
  // really can decide.
  if (permissions?.["supplier-review:approve"] === true) return "approver";
  if (permissions?.["supplier-review:review"] === true) return "reviewer";
  if (value === "manager") return "approver";
  if (value === "purchasing") return "reviewer";
  return "observer";
}

/** May this review role perform the action? */
export function canPerform(role: ReviewRole, action: ReviewAction): boolean {
  return (ROLE_ACTIONS[role] ?? []).includes(action);
}

/** The actions a role may perform, for the console to render only real buttons. */
export function actionsFor(role: ReviewRole): ReviewAction[] {
  return [...(ROLE_ACTIONS[role] ?? [])];
}

/** Arabic labels for the actions. */
export const ACTION_LABELS: Record<ReviewAction, string> = {
  assign: "إسناد لمراجع",
  review: "بدء المراجعة",
  request_info: "طلب استكمال بيانات",
  request_docs: "طلب مستندات إضافية",
  verify: "اجتياز الفحص",
  approve: "اعتماد المورد",
  reject: "رفض الطلب",
  suspend: "إيقاف مؤقت",
  resume: "إعادة للمراجعة",
};
