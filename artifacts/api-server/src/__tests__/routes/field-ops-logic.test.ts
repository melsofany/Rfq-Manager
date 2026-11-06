import { describe, it, expect } from "vitest";
import {
  checkLoginEligibility,
  checkFieldAssignmentEligibility,
  canReceiveNewAssignment,
  delegationIsActive,
  delegationCoversScope,
  authorizeTaskExecution,
  checkReceiptQuantities,
  checkDeliveryQuantities,
  type DelegationRow,
} from "../../modules/field-ops/assignment-logic";

const NOW = new Date("2026-11-06T10:00:00Z");

function deleg(over: Partial<DelegationRow & { toHrEmployeeId: number; id: number }> = {}) {
  return {
    id: 1,
    toHrEmployeeId: 20,
    status: "active",
    scope: "both",
    startsAt: new Date("2026-11-06T08:00:00Z"),
    endsAt: null,
    ...over,
  };
}

describe("checkLoginEligibility", () => {
  it("rejects an unknown employee number", () => {
    const r = checkLoginEligibility({ employee: null, hasPassword: true });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it("rejects an inactive HR employee even with mobile access", () => {
    const r = checkLoginEligibility({
      employee: { status: "resigned", mobileAccessEnabled: true },
      hasPassword: true,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it("rejects an active employee whose mobile access was never granted", () => {
    const r = checkLoginEligibility({
      employee: { status: "active", mobileAccessEnabled: false },
      hasPassword: true,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it("rejects an enabled employee with no password set", () => {
    const r = checkLoginEligibility({
      employee: { status: "active", mobileAccessEnabled: true },
      hasPassword: false,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it("accepts an active, enabled employee with a password", () => {
    const r = checkLoginEligibility({
      employee: { status: "active", mobileAccessEnabled: true },
      hasPassword: true,
    });
    expect(r.ok).toBe(true);
  });
});

describe("checkFieldAssignmentEligibility", () => {
  it("refuses a non-active employee", () => {
    const r = checkFieldAssignmentEligibility({
      employee: { status: "terminated" },
      alreadyAssigned: false,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it("refuses a duplicate active assignment", () => {
    const r = checkFieldAssignmentEligibility({
      employee: { status: "active" },
      alreadyAssigned: true,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
  });

  it("allows an active, unassigned employee", () => {
    expect(
      checkFieldAssignmentEligibility({ employee: { status: "active" }, alreadyAssigned: false })
        .ok,
    ).toBe(true);
  });

  it("a revoked assignment gets no new tasks", () => {
    expect(canReceiveNewAssignment(false)).toBe(false);
    expect(canReceiveNewAssignment(true)).toBe(true);
  });
});

describe("delegationIsActive", () => {
  it("is active inside its window", () => {
    expect(delegationIsActive(deleg(), NOW)).toBe(true);
  });
  it("is not active before it starts", () => {
    expect(delegationIsActive(deleg({ startsAt: new Date("2026-11-07T00:00:00Z") }), NOW)).toBe(
      false,
    );
  });
  it("is not active after it ends", () => {
    expect(delegationIsActive(deleg({ endsAt: new Date("2026-11-06T09:00:00Z") }), NOW)).toBe(
      false,
    );
  });
  it("is not active once revoked", () => {
    expect(delegationIsActive(deleg({ status: "revoked" }), NOW)).toBe(false);
  });
});

describe("delegationCoversScope", () => {
  it("both covers every operation", () => {
    expect(delegationCoversScope("both", "receipt")).toBe(true);
    expect(delegationCoversScope("both", "delivery")).toBe(true);
  });
  it("receipt scope does not cover delivery", () => {
    expect(delegationCoversScope("receipt", "receipt")).toBe(true);
    expect(delegationCoversScope("receipt", "delivery")).toBe(false);
  });
});

describe("authorizeTaskExecution", () => {
  const base = {
    employeeId: 10,
    kind: "receipt",
    assignmentHrEmployeeId: 10,
    hasActiveFieldAssignment: true,
    delegations: [],
    now: NOW,
  };

  it("authorises the responsible representative who holds an active assignment", () => {
    const r = authorizeTaskExecution(base);
    expect(r.ok).toBe(true);
    expect(r.value?.role).toBe("owner");
  });

  it("refuses the responsible employee whose field assignment was revoked", () => {
    const r = authorizeTaskExecution({ ...base, hasActiveFieldAssignment: false });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it("refuses an unrelated employee", () => {
    const r = authorizeTaskExecution({ ...base, employeeId: 99 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });

  it("authorises a purchasing employee holding a valid delegation", () => {
    const r = authorizeTaskExecution({ ...base, employeeId: 20, delegations: [deleg()] });
    expect(r.ok).toBe(true);
    expect(r.value?.role).toBe("delegate");
    expect(r.value?.delegationId).toBe(1);
  });

  it("refuses a delegation whose scope does not cover the operation", () => {
    const r = authorizeTaskExecution({
      ...base,
      employeeId: 20,
      kind: "delivery",
      delegations: [deleg({ scope: "receipt" })],
    });
    expect(r.ok).toBe(false);
  });

  it("refuses an expired delegation", () => {
    const r = authorizeTaskExecution({
      ...base,
      employeeId: 20,
      delegations: [deleg({ endsAt: new Date("2026-11-06T09:00:00Z") })],
    });
    expect(r.ok).toBe(false);
  });

  it("never lets HR status alone authorise execution", () => {
    // Not the owner, no delegation — regardless of being an active HR employee.
    const r = authorizeTaskExecution({ ...base, employeeId: 20, delegations: [] });
    expect(r.ok).toBe(false);
  });
});

describe("checkReceiptQuantities", () => {
  const ok = { orderedQty: 10, alreadyAccepted: 0, receivedQty: 6, acceptedQty: 6, rejectedQty: 0 };

  it("accepts a valid partial receipt", () => {
    expect(checkReceiptQuantities(ok).ok).toBe(true);
  });
  it("accepts a full receipt", () => {
    expect(checkReceiptQuantities({ ...ok, receivedQty: 10, acceptedQty: 10 }).ok).toBe(true);
  });
  it("rejects accepting more than ordered", () => {
    const r = checkReceiptQuantities({ ...ok, receivedQty: 11, acceptedQty: 11 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
  it("accounts for quantities already accepted", () => {
    const r = checkReceiptQuantities({ ...ok, alreadyAccepted: 8, receivedQty: 5, acceptedQty: 5 });
    expect(r.ok).toBe(false);
  });
  it("rejects accepted + rejected exceeding received", () => {
    const r = checkReceiptQuantities({ ...ok, receivedQty: 6, acceptedQty: 6, rejectedQty: 1 });
    expect(r.ok).toBe(false);
  });
  it("rejects negative quantities", () => {
    expect(checkReceiptQuantities({ ...ok, receivedQty: -1, acceptedQty: -1 }).ok).toBe(false);
  });
  it("rejects an empty submission", () => {
    expect(
      checkReceiptQuantities({ ...ok, receivedQty: 0, acceptedQty: 0, rejectedQty: 0 }).ok,
    ).toBe(false);
  });
  it("allows a pure rejection with no accepted qty", () => {
    expect(
      checkReceiptQuantities({ ...ok, receivedQty: 3, acceptedQty: 0, rejectedQty: 3 }).ok,
    ).toBe(true);
  });
});

describe("checkDeliveryQuantities", () => {
  const ok = { orderedQty: 10, acceptedFromSupplier: 10, alreadyDelivered: 0, deliveredQty: 7 };

  it("accepts a valid partial delivery", () => {
    expect(checkDeliveryQuantities(ok).ok).toBe(true);
  });
  it("rejects delivering more than was received from the supplier", () => {
    const r = checkDeliveryQuantities({ ...ok, acceptedFromSupplier: 4, deliveredQty: 6 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
  it("accounts for what was already delivered", () => {
    const r = checkDeliveryQuantities({ ...ok, alreadyDelivered: 8, deliveredQty: 3 });
    expect(r.ok).toBe(false);
  });
  it("rejects exceeding the customer PO balance", () => {
    const r = checkDeliveryQuantities({ ...ok, orderedQty: 5, deliveredQty: 6 });
    expect(r.ok).toBe(false);
  });
  it("is unguarded when there is no supplier link", () => {
    expect(checkDeliveryQuantities({ ...ok, acceptedFromSupplier: null }).ok).toBe(true);
  });
  it("rejects a zero or negative quantity", () => {
    expect(checkDeliveryQuantities({ ...ok, deliveredQty: 0 }).ok).toBe(false);
    expect(checkDeliveryQuantities({ ...ok, deliveredQty: -2 }).ok).toBe(false);
  });
});
