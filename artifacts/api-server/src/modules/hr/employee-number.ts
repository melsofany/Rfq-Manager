/**
 * Employee number: YY(hire year) + YY(birth year) + 4-digit sequence, e.g. 26 94 0001.
 * The sequence counts hires of the same hire year, so 2026 hires are 0001, 0002, …
 */

export const EMPLOYEE_NO_RE = /^\d{8}$/;

function twoDigits(year: number): string {
  return String(year % 100).padStart(2, "0");
}

export function buildEmployeeNo(hireYear: number, birthYear: number, seq: number): string {
  return `${twoDigits(hireYear)}${twoDigits(birthYear)}${String(seq).padStart(4, "0")}`;
}

/** Next sequence for a hire year, given the employee numbers that already exist. */
export function nextSequence(hireYear: number, existingNos: string[]): number | null {
  const prefix = twoDigits(hireYear);
  let max = 0;
  for (const no of existingNos) {
    if (!EMPLOYEE_NO_RE.test(no) || !no.startsWith(prefix)) continue;
    const seq = Number(no.slice(4));
    if (seq > max) max = seq;
  }
  const next = max + 1;
  return next > 9999 ? null : next;
}

/** Full generator: returns the number, or an Arabic error when the year's 9999 slots are used up. */
export function generateEmployeeNo(
  hireYear: number,
  birthYear: number,
  existingNos: string[],
): { employeeNo: string } | { error: string } {
  const seq = nextSequence(hireYear, existingNos);
  if (seq === null) return { error: "تم استنفاد أرقام التعيين لهذه السنة (9999)" };
  return { employeeNo: buildEmployeeNo(hireYear, birthYear, seq) };
}
