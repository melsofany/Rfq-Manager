/**
 * شرط إضافة موظف مشتريات: لازم يكون من الموظفين المعينين في الـ HR،
 * وفي حالة نشطة، ومش مربوط بحساب مشتريات قبل كده.
 */
export interface HrCandidateRow {
  id: number;
  fullName: string;
  status: string;
  procurementEmployeeId: number | null;
}

export type HrCandidateCheck = { ok: true } | { ok: false; status: number; error: string };

export function checkHrCandidate(row: HrCandidateRow | undefined): HrCandidateCheck {
  if (!row) {
    return { ok: false, status: 400, error: "الموظف ده مش موجود في قائمة المعينين" };
  }
  if (row.status !== "active") {
    return { ok: false, status: 400, error: "الموظف ده مش نشط في الـ HR" };
  }
  if (row.procurementEmployeeId != null) {
    return { ok: false, status: 409, error: "الموظف ده مربوط بحساب مشتريات بالفعل" };
  }
  return { ok: true };
}
