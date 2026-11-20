import { describe, it, expect } from "vitest";
import {
  ACTION_FOR_TARGET,
  AWAITING_SUPPLIER_STATUSES,
  DECIDED_STATUSES,
  OPEN_STATUSES,
  REVIEW_STATUS,
  actionsFor,
  canPerform,
  canTransition,
  normalizeStatus,
  requiresReason,
  requiresRequestDetail,
  reviewRoleOf,
} from "../modules/supplier-review/workflow";

const S = REVIEW_STATUS;

describe("review workflow — status vocabulary", () => {
  it("maps the portal's own status names onto the review vocabulary", () => {
    // The portal writes `submitted` / `needs_info`; the review console speaks
    // `new` / `needs_information`. Reading the portal's row must not produce an
    // unknown status, which would render an empty badge and break every filter.
    expect(normalizeStatus("submitted")).toBe(S.NEW);
    expect(normalizeStatus("needs_info")).toBe(S.NEEDS_INFORMATION);
    expect(normalizeStatus("under_review")).toBe(S.UNDER_REVIEW);
    expect(normalizeStatus("draft")).toBe(S.NEW);
  });

  it("keeps the review-only statuses it already understands", () => {
    expect(normalizeStatus("verified")).toBe(S.VERIFIED);
    expect(normalizeStatus("suspended")).toBe(S.SUSPENDED);
    expect(normalizeStatus("needs_documents")).toBe(S.NEEDS_DOCUMENTS);
  });

  it("treats an unknown or empty status as NEW rather than throwing", () => {
    expect(normalizeStatus(null)).toBe(S.NEW);
    expect(normalizeStatus("")).toBe(S.NEW);
    expect(normalizeStatus("something_else")).toBe(S.NEW);
  });
});

describe("review workflow — transitions", () => {
  it("walks the happy path from NEW to APPROVED", () => {
    expect(canTransition(S.NEW, S.UNDER_REVIEW).ok).toBe(true);
    expect(canTransition(S.UNDER_REVIEW, S.VERIFIED).ok).toBe(true);
    expect(canTransition(S.VERIFIED, S.APPROVED).ok).toBe(true);
  });

  it("refuses a no-op transition — an audit row claiming an action that changed nothing", () => {
    const r = canTransition(S.UNDER_REVIEW, S.UNDER_REVIEW);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("بالفعل");
  });

  it("refuses to jump straight from NEW to APPROVED", () => {
    // The operator's rule: approval is a human decision on a REVIEWED file.
    // A one-step NEW → APPROVED would make the whole review optional.
    expect(canTransition(S.NEW, S.APPROVED).ok).toBe(false);
  });

  it("refuses to reopen an APPROVED decision directly", () => {
    // Reversing an approval that already created a supplier must go through
    // SUSPENDED, which is audited and carries a reason.
    expect(canTransition(S.APPROVED, S.UNDER_REVIEW).ok).toBe(false);
    expect(canTransition(S.APPROVED, S.SUSPENDED).ok).toBe(true);
    expect(canTransition(S.SUSPENDED, S.UNDER_REVIEW).ok).toBe(true);
  });

  it("lets a request the supplier answered come back into the queue", () => {
    expect(canTransition(S.NEEDS_INFORMATION, S.RESUBMITTED).ok).toBe(true);
    expect(canTransition(S.RESUBMITTED, S.UNDER_REVIEW).ok).toBe(true);
    expect(canTransition(S.NEEDS_DOCUMENTS, S.RESUBMITTED).ok).toBe(true);
  });

  it("requires a reason for a rejection or a suspension, and detail for a request", () => {
    expect(requiresReason(S.REJECTED)).toBe(true);
    expect(requiresReason(S.SUSPENDED)).toBe(true);
    expect(requiresReason(S.APPROVED)).toBe(false);
    expect(requiresRequestDetail(S.NEEDS_INFORMATION)).toBe(true);
    expect(requiresRequestDetail(S.NEEDS_DOCUMENTS)).toBe(true);
  });

  it("classifies the statuses the dashboard counts on", () => {
    expect(OPEN_STATUSES).toContain(S.NEW);
    expect(OPEN_STATUSES).toContain(S.UNDER_REVIEW);
    expect(AWAITING_SUPPLIER_STATUSES).toContain(S.NEEDS_DOCUMENTS);
    expect(DECIDED_STATUSES).toContain(S.APPROVED);
    expect(DECIDED_STATUSES).not.toContain(S.VERIFIED);
  });
});

describe("review workflow — roles", () => {
  it("maps the system's job roles onto review roles", () => {
    expect(reviewRoleOf("admin")).toBe("admin");
    expect(reviewRoleOf("manager")).toBe("approver");
    expect(reviewRoleOf("purchasing")).toBe("reviewer");
    expect(reviewRoleOf("data_entry")).toBe("observer");
  });

  it("honours an explicit permission grant over the job role", () => {
    // A data-entry employee granted the approve key really can decide — the
    // grant is the authority, not the job title.
    expect(reviewRoleOf("data_entry", { "supplier-review:approve": true })).toBe("approver");
    expect(reviewRoleOf("data_entry", { "supplier-review:review": true })).toBe("reviewer");
  });

  it("gives a reviewer verification but NOT approval — the two-role split", () => {
    // «لا يجوز تحويل الطلب إلى APPROVED لمجرد اجتياز OCR»: the reviewer proves
    // the documents; a different authority approves.
    expect(canPerform("reviewer", "verify")).toBe(true);
    expect(canPerform("reviewer", "approve")).toBe(false);
    expect(canPerform("approver", "approve")).toBe(true);
    expect(canPerform("approver", "verify")).toBe(true);
  });

  it("gives an observer nothing that changes state", () => {
    expect(actionsFor("observer")).toEqual([]);
    expect(canPerform("observer", "review")).toBe(false);
    expect(canPerform("observer", "approve")).toBe(false);
  });

  it("has an action for every status a transition can target", () => {
    // A target with no action would be unreachable from the console: the route
    // resolves the permission from ACTION_FOR_TARGET.
    for (const target of [S.ASSIGNED, S.UNDER_REVIEW, S.VERIFIED, S.APPROVED, S.REJECTED]) {
      expect(ACTION_FOR_TARGET[target]).toBeTruthy();
    }
  });
});
