import { isValidYmd } from "./leave-logic";
/**
 * HR settings — القيم اللي المحاسب بيعدّلها (التأمينات، الضرايب، الغياب، الجزاءات، بدلات، بنك).
 * كل مفتاح ليه validator. القيمة null معناها "غير مضبوط". مفيش أرقام افتراضية.
 */

export const SETTING_KEYS = [
  "social_insurance",
  "health_insurance",
  "income_tax",
  "absence",
  "fines",
  "allowance_types",
  "bank_export",
  "end_of_service",
  "work_shift",
  "holidays",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export function isSettingKey(v: string): v is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(v);
}

type Result = { error: string } | { value: unknown };

/** null/undefined = not set; otherwise a finite number in [min, max] with at most 2 decimals. */
function optNum(
  v: unknown,
  min: number,
  max: number,
  label: string,
): { error: string } | { value: number | null } {
  if (v === null || v === undefined || v === "") return { value: null };
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max)
    return { error: `${label} لازم يكون بين ${min} و ${max}` };
  if (Math.round(n * 100) !== n * 100)
    return { error: `${label} لازم يكون بمنزلتين عشريتين كحد أقصى` };
  return { value: n };
}

function optInt(
  v: unknown,
  min: number,
  max: number,
  label: string,
): { error: string } | { value: number | null } {
  const r = optNum(v, min, max, label);
  if ("error" in r || r.value === null) return r;
  if (!Number.isInteger(r.value)) return { error: `${label} لازم يكون رقم صحيح` };
  return r;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Employee/employer rates and an optional monthly cap for an insurance scheme. */
function validateInsurance(v: unknown, label: string): Result {
  if (v === null) return { value: null };
  if (!isObj(v)) return { error: "صيغة غير صالحة" };
  const e = optNum(v.employeeRatePct, 0, 100, `نسبة ${label} على الموظف`);
  if ("error" in e) return e;
  const r = optNum(v.employerRatePct, 0, 100, `نسبة ${label} على الشركة`);
  if ("error" in r) return r;
  const c = optNum(v.capAmount, 0, 1e9, `سقف ${label}`);
  if ("error" in c) return c;
  return { value: { employeeRatePct: e.value, employerRatePct: r.value, capAmount: c.value } };
}

function validateIncomeTax(v: unknown): Result {
  if (v === null) return { value: null };
  if (!isObj(v) || !Array.isArray(v.brackets)) return { error: "صيغة شرائح الضريبة غير صالحة" };
  const rows = v.brackets;
  if (rows.length < 1 || rows.length > 20) return { error: "عدد الشرائح لازم يكون من 1 إلى 20" };
  const out: { upTo: number | null; ratePct: number }[] = [];
  let prev = 0;
  rows.forEach((row, i) => {
    if (!isObj(row)) throw new Error("صيغة الشريحة غير صالحة");
    const rate = optNum(row.ratePct, 0, 100, `نسبة الشريحة ${i + 1}`);
    if ("error" in rate || rate.value === null) throw new Error(`نسبة الشريحة ${i + 1} مطلوبة`);
    const isLast = i === rows.length - 1;
    const upTo = optNum(row.upTo, 0, 1e12, `حد الشريحة ${i + 1}`);
    if ("error" in upTo) throw new Error(upTo.error);
    if (isLast) {
      if (upTo.value !== null) throw new Error("آخر شريحة لازم تكون بدون حد أعلى (فوق آخر حد)");
    } else {
      if (upTo.value === null) throw new Error(`الشريحة ${i + 1} لازم يكون ليها حد أعلى`);
      if (upTo.value <= prev) throw new Error("حدود الشرائح لازم تكون تصاعدية");
      prev = upTo.value;
    }
    out.push({ upTo: upTo.value, ratePct: rate.value });
  });
  return { value: { brackets: out } };
}

function validateAbsence(v: unknown): Result {
  if (v === null) return { value: null };
  if (!isObj(v)) return { error: "صيغة غير صالحة" };
  const d = optInt(v.dailyDivisor, 1, 31, "قاعدة قسمة الراتب اليومي");
  if ("error" in d || d.value === null) return { error: "قاعدة قسمة الراتب اليومي مطلوبة" };
  // Weekly day(s) off (0 = Sunday … 6 = Saturday). An empty list is a valid choice.
  if (
    !Array.isArray(v.weeklyOffDays) ||
    v.weeklyOffDays.some((x) => !Number.isInteger(x) || x < 0 || x > 6)
  ) {
    return { error: "حدد أيام الإجازة الأسبوعية (أو اتركها فاضية لو مفيش)" };
  }
  const days = [...new Set(v.weeklyOffDays as number[])].sort((a, b) => a - b);
  return { value: { dailyDivisor: d.value, weeklyOffDays: days } };
}

function validateFines(v: unknown): Result {
  if (v === null) return { value: null };
  if (!isObj(v)) return { error: "صيغة غير صالحة" };
  const c = optInt(v.monthlyCapDays, 0, 60, "الحد الأقصى للجزاءات بالأيام في الشهر");
  if ("error" in c) return c;
  return { value: { monthlyCapDays: c.value } };
}

function validateAllowanceTypes(v: unknown): Result {
  if (v === null) return { value: null };
  if (!isObj(v) || !Array.isArray(v.items)) return { error: "صيغة البدلات غير صالحة" };
  const items: string[] = [];
  for (const raw of v.items) {
    if (typeof raw !== "string") return { error: "اسم البدل لازم يكون نص" };
    const t = raw.trim();
    if (!t) continue;
    if (t.length > 60) return { error: "اسم البدل طويل (60 حرف كحد أقصى)" };
    if (items.includes(t)) continue;
    items.push(t);
  }
  if (items.length > 30) return { error: "عدد أنواع البدلات لازم يكون 30 كحد أقصى" };
  return { value: { items } };
}

/** End-of-service rule: days of pay per year for the first years, then months per year after. */
function validateEndOfService(v: unknown): Result {
  if (v === null) return { value: null };
  if (!isObj(v)) return { error: "صيغة غير صالحة" };
  const d = optNum(v.firstYearsDays, 0, 60, "أيام الأجر لكل سنة (أول سنين)");
  if ("error" in d || d.value === null) return { error: "أيام الأجر لكل سنة مطلوبة" };
  const lim = optInt(v.firstYearsLimit, 0, 50, "عدد السنين الأولى");
  if ("error" in lim || lim.value === null) return { error: "عدد السنين الأولى مطلوب" };
  const m = optNum(v.laterMonthsPerYear, 0, 12, "الشهور لكل سنة بعد السنين الأولى");
  if ("error" in m || m.value === null) return { error: "الشهور لكل سنة بعد السنين الأولى مطلوبة" };
  return {
    value: { firstYearsDays: d.value, firstYearsLimit: lim.value, laterMonthsPerYear: m.value },
  };
}

function validateBankExport(v: unknown): Result {
  if (v === null) return { value: null };
  if (!isObj(v)) return { error: "صيغة غير صالحة" };
  const format = typeof v.format === "string" && v.format.trim() ? v.format.trim() : null;
  const notes = typeof v.notes === "string" && v.notes.trim() ? v.notes.trim() : null;
  if (format && format.length > 100) return { error: "اسم صيغة الملف طويل" };
  if (notes && notes.length > 500) return { error: "الملاحظات طويلة (500 حرف كحد أقصى)" };
  return { value: { format, notes } };
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Work shift — بداية ونهاية وقت العمل وعدد الدقائق المسموح بها للتأخير.
 * The times are wall-clock "HH:MM"; lateMinutes is the grace period after the
 * shift start before an arrival counts as late.
 */
/**
 * Official holidays (إجازات رسمية) declared by HR, e.g. 6 October or Sham El-Nessim.
 * A declared day is not counted as absence in attendance or payroll.
 */
function validateHolidays(v: unknown): Result {
  if (v === null) return { value: [] };
  if (!Array.isArray(v)) return { error: "صيغة غير صالحة" };
  if (v.length > 100) return { error: "عدد الإجازات الرسمية كبير جداً" };
  const seen = new Set<string>();
  const out: { date: string; name: string }[] = [];
  for (const item of v) {
    if (!isObj(item)) return { error: "صيغة غير صالحة" };
    const date = typeof item.date === "string" ? item.date : "";
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!isValidYmd(date)) return { error: "تاريخ الإجازة غير صالح" };
    if (!name || name.length > 100) return { error: "اكتب اسم الإجازة (حتى 100 حرف)" };
    if (seen.has(date)) return { error: `التاريخ ${date} مكرر` };
    seen.add(date);
    out.push({ date, name });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return { value: out };
}

function validateWorkShift(v: unknown): Result {
  if (v === null) return { value: null };
  if (!isObj(v)) return { error: "صيغة غير صالحة" };
  const start = typeof v.start === "string" ? v.start.trim() : "";
  const end = typeof v.end === "string" ? v.end.trim() : "";
  if (!HHMM_RE.test(start)) return { error: "وقت بداية العمل غير صالح (مثال 09:00)" };
  if (!HHMM_RE.test(end)) return { error: "وقت نهاية العمل غير صالح (مثال 17:00)" };
  const g = optInt(v.lateGraceMinutes, 0, 240, "الدقائق المسموح بها للتأخير");
  if ("error" in g) return g;
  return { value: { start, end, lateGraceMinutes: g.value ?? 0 } };
}

/** Validate one setting value. Returns the normalized value to store, or an Arabic error. */
export function validateSetting(key: SettingKey, value: unknown): Result {
  switch (key) {
    case "social_insurance":
      return validateInsurance(value, "التأمين الاجتماعي");
    case "health_insurance":
      return validateInsurance(value, "التأمين الصحي");
    case "income_tax":
      try {
        return validateIncomeTax(value);
      } catch (e) {
        return { error: (e as Error).message };
      }
    case "absence":
      return validateAbsence(value);
    case "fines":
      return validateFines(value);
    case "allowance_types":
      return validateAllowanceTypes(value);
    case "bank_export":
      return validateBankExport(value);
    case "end_of_service":
      return validateEndOfService(value);
    case "work_shift":
      return validateWorkShift(value);
    case "holidays":
      return validateHolidays(value);
  }
}
