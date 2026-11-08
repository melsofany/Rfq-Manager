/**
 * منطق العمليات الميدانية — pure decision logic (no database, no Express).
 *
 * Everything that decides "may this person see / execute this task" lives here
 * so it can be unit-tested exhaustively. The routes only load rows and call
 * these functions; they never re-implement a rule. Keeping the rules in one
 * place is what makes the backend the authority instead of the Android UI.
 */

export type OperationKind = "receipt" | "delivery";

/** hr_employees.status values accepted by the HR module. */
export type HrStatus = "active" | "resigned" | "terminated" | string;

export interface Decision<T = undefined> {
  ok: boolean;
  status: number;
  error: string;
  /** Present only when ok === true. */
  value?: T;
}

function deny(status: number, error: string): Decision<never> {
  return { ok: false, status, error };
}

function allow<T>(value: T): Decision<T> {
  return { ok: true, status: 200, error: "", value };
}

// ── Login eligibility ───────────────────────────────────────────────────────

export interface LoginEligibilityInput {
  /** hr_employees row, or null when the employee number is unknown. */
  employee: { status: HrStatus; mobileAccessEnabled: boolean } | null;
  /** Whether a password has been set on the account. */
  hasPassword: boolean;
}

/**
 * May this employee sign in to the mobile app?
 *
 * Being `active` in HR is NOT sufficient — mobile access is a separate,
 * admin-controlled grant (`mobile_access_enabled`). This is the rule that stops
 * "any active HR employee" from becoming a field operator by accident.
 */
export function checkLoginEligibility(input: LoginEligibilityInput): Decision {
  const { employee, hasPassword } = input;
  if (!employee) return deny(401, "رقم الوظيفي أو كلمة المرور غير صحيحة");
  if (employee.status !== "active") {
    return deny(403, "الحساب غير نشط. برجاء التواصل مع الموارد البشرية");
  }
  if (!employee.mobileAccessEnabled) {
    return deny(403, "لم يتم تفعيل صلاحية الدخول للتطبيق لهذا الحساب");
  }
  if (!hasPassword) {
    return deny(403, "لم يتم إعداد كلمة مرور للتطبيق بعد. برجاء التواصل مع المسؤول");
  }
  return allow(undefined);
}

// ── Field-assignment eligibility ────────────────────────────────────────────

export interface AssignmentEligibilityInput {
  /** The employee that would receive a field assignment. */
  employee: { status: HrStatus } | null;
  /** Whether an ACTIVE field assignment already exists for this employee. */
  alreadyAssigned: boolean;
}

/** May this HR employee be granted FIELD_REPRESENTATIVE? */
export function checkFieldAssignmentEligibility(input: AssignmentEligibilityInput): Decision {
  const { employee, alreadyAssigned } = input;
  if (!employee) return deny(404, "الموظف غير موجود في الموارد البشرية");
  if (employee.status !== "active") {
    return deny(400, "لا يمكن تعيين موظف غير نشط كمندوب ميداني");
  }
  if (alreadyAssigned) {
    return deny(409, "الموظف معيّن بالفعل كمندوب ميداني");
  }
  return allow(undefined);
}

/**
 * May a NEW field task be assigned to this employee?
 *
 * A revoked representative keeps every historical task but receives no new
 * work. Historical rows are never touched by revocation.
 */
export function canReceiveNewAssignment(hasActiveFieldAssignment: boolean): boolean {
  return hasActiveFieldAssignment;
}

// ── Delegation ──────────────────────────────────────────────────────────────

export interface DelegationRow {
  status: string;
  scope: string;
  startsAt: Date;
  endsAt: Date | null;
}

/** Is the delegation currently in force at `now`? */
export function delegationIsActive(d: DelegationRow, now: Date): boolean {
  if (d.status !== "active") return false;
  if (d.startsAt.getTime() > now.getTime()) return false;
  if (d.endsAt && d.endsAt.getTime() < now.getTime()) return false;
  return true;
}

/** Does the delegation's scope cover this operation kind? */
export function delegationCoversScope(scope: string, kind: OperationKind): boolean {
  if (scope === "both") return true;
  return scope === kind;
}

// ── Task execution authorization ────────────────────────────────────────────

export interface TaskAuthInput {
  /** hr_employees.id of the signed-in employee. */
  employeeId: number;
  /** work_order_assignments.kind of the task. */
  kind: string;
  /** work_order_assignments.hr_employee_id — the responsible employee. */
  assignmentHrEmployeeId: number | null;
  /** Does the signed-in employee hold an ACTIVE field assignment? */
  hasActiveFieldAssignment: boolean;
  /** Active delegations for THIS assignment. */
  delegations: (DelegationRow & { toHrEmployeeId: number; id: number })[];
  now: Date;
}

export interface TaskAuthResult {
  /** owner = the responsible representative; delegate = temporary cover. */
  role: "owner" | "delegate";
  delegationId?: number;
}

/**
 * May the signed-in employee execute this task?
 *
 * Two ways only: (a) they are the responsible representative AND hold an active
 * field assignment; (b) they hold a currently-valid delegation for this exact
 * task whose scope covers this operation. A purchasing employee is never
 * authorised by their HR status alone.
 */
export function authorizeTaskExecution(input: TaskAuthInput): Decision<TaskAuthResult> {
  const kind: OperationKind = input.kind === "delivery" ? "delivery" : "receipt";

  const isOwner =
    input.assignmentHrEmployeeId != null &&
    input.assignmentHrEmployeeId === input.employeeId &&
    input.hasActiveFieldAssignment;
  if (isOwner) return allow({ role: "owner" });

  const delegation = input.delegations.find(
    (d) =>
      d.toHrEmployeeId === input.employeeId &&
      delegationIsActive(d, input.now) &&
      delegationCoversScope(d.scope, kind),
  );
  if (delegation) return allow({ role: "delegate", delegationId: delegation.id });

  return deny(403, "هذه المهمة غير مسندة إليك");
}

/** Filter a list of delegations down to the one in force for this employee. */
export function pickActiveDelegation(
  delegations: (DelegationRow & { toHrEmployeeId: number })[],
  employeeId: number,
  kind: OperationKind,
  now: Date,
): (DelegationRow & { toHrEmployeeId: number }) | undefined {
  return delegations.find(
    (d) =>
      d.toHrEmployeeId === employeeId &&
      delegationIsActive(d, now) &&
      delegationCoversScope(d.scope, kind),
  );
}

// ── Quantity guards ─────────────────────────────────────────────────────────

export interface ReceiptGuardInput {
  /** Ordered qty on the supplier PO line. */
  orderedQty: number | null;
  /** Already accepted across previous receipts. */
  alreadyAccepted: number;
  /** Quantities in this submission. */
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
}

/**
 * Validate a receipt submission before it is written.
 *
 * Rules enforced: quantities are non-negative, the parts never exceed what was
 * actually received, and accepting more than was ordered is refused (an
 * over-receipt is a data-entry error, not a silent over-delivery).
 */
export function checkReceiptQuantities(input: ReceiptGuardInput): Decision {
  const { orderedQty, alreadyAccepted, receivedQty, acceptedQty, rejectedQty } = input;
  const values = [receivedQty, acceptedQty, rejectedQty];
  if (values.some((v) => !isFinite(v) || v < 0)) {
    return deny(400, "الكميات يجب أن تكون أرقامًا موجبة");
  }
  if (acceptedQty + rejectedQty > receivedQty + 1e-6) {
    return deny(400, "مجموع الكمية المقبولة والمرفوضة أكبر من الكمية المستلمة");
  }
  if (orderedQty != null && acceptedQty > 0) {
    const remaining = orderedQty - alreadyAccepted;
    if (acceptedQty > remaining + 1e-6) {
      return deny(400, `الكمية المقبولة أكبر من المتبقي (${remaining})`);
    }
  }
  // A zero-quantity line is a deliberate refusal (the app seeds every line with
  // its full quantity, so 0 is never an accidental blank) — allow it. It records
  // as a "rejected" receipt and must not block the rest of the submission.
  return allow(undefined);
}

export interface DeliveryGuardInput {
  /** Ordered qty on the customer PO line. */
  orderedQty: number | null;
  /** Qty accepted from the supplier (null = no supplier link, unguarded). */
  acceptedFromSupplier: number | null;
  /** Already delivered across previous deliveries. */
  alreadyDelivered: number;
  /** Qty in this submission. */
  deliveredQty: number;
}

/**
 * Validate a delivery submission.
 *
 * The two rules that must never be relaxed: you cannot deliver more than was
 * received and accepted from the supplier, and you cannot deliver more than the
 * customer's remaining balance.
 *
 * A zero delivered quantity is a DELIBERATE customer rejection, not an empty
 * form: the line is recorded as `rejected` (with a reason) and must not block
 * the rest of the submission. Rejecting the whole order must still be possible
 * when nothing has been accepted from the supplier yet, so a zero-qty line is
 * allowed even before a receipt exists — it can never over-deliver.
 */
export function checkDeliveryQuantities(input: DeliveryGuardInput): Decision {
  const { orderedQty, acceptedFromSupplier, alreadyDelivered, deliveredQty } = input;
  if (!isFinite(deliveredQty) || deliveredQty < 0) {
    return deny(400, "الكمية المسلّمة يجب أن تكون رقمًا موجبًا");
  }
  // Zero = full rejection of this line. Allowed; nothing is delivered.
  if (deliveredQty <= 0) return allow(undefined);

  if (
    acceptedFromSupplier != null &&
    deliveredQty + alreadyDelivered > acceptedFromSupplier + 1e-6
  ) {
    const available = Math.max(0, acceptedFromSupplier - alreadyDelivered);
    return deny(400, `الكمية المتاحة للتسليم ${available} فقط (لم يتم استلام المزيد من المورد)`);
  }
  if (orderedQty != null) {
    const remaining = orderedQty - alreadyDelivered;
    if (deliveredQty > remaining + 1e-6) {
      return deny(400, `الكمية المسلّمة أكبر من المتبقي على أمر العميل (${remaining})`);
    }
  }
  return allow(undefined);
}
