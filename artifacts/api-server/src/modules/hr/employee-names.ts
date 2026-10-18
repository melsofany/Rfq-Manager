/**
 * Employee names: the Arabic name is the one printed on documents (per the state's records),
 * and the English name is required alongside it.
 */
const ARABIC_LETTER = /[؀-ۿ]/;
const ENGLISH_NAME = /^[A-Za-z][A-Za-z '.-]*$/;
const MAX_NAME = 200;

type NameResult = { error: string } | { fullName: string; fullNameEn: string };

export function validateEmployeeNames(ar: unknown, en: unknown): NameResult {
  const fullName = typeof ar === "string" ? ar.trim().replace(/\s+/g, " ") : "";
  const fullNameEn = typeof en === "string" ? en.trim().replace(/\s+/g, " ") : "";
  if (!fullName) return { error: "الاسم بالعربي مطلوب" };
  if (!ARABIC_LETTER.test(fullName)) return { error: "الاسم بالعربي لازم يكون بحروف عربية" };
  if (!fullNameEn) return { error: "الاسم بالإنجليزي مطلوب" };
  if (!ENGLISH_NAME.test(fullNameEn))
    return { error: "الاسم بالإنجليزي لازم يكون بحروف إنجليزية فقط" };
  if (fullName.length > MAX_NAME || fullNameEn.length > MAX_NAME)
    return { error: `الاسم أطول من ${MAX_NAME} حرف` };
  return { fullName, fullNameEn };
}
