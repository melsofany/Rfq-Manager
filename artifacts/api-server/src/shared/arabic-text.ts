/**
 * Arabic text folding — the ONE implementation.
 *
 * Arabic writers use letter variants interchangeably (أ/ا, ى/ي, ة/ه, ؤ/ئ/ء)
 * and sprinkle diacritics and tatweel. Comparing raw strings therefore reports
 * a difference between two spellings of the same word.
 *
 * Lives in `shared/` because both the AI router and the supplier-document
 * comparison need it, and a module under `ai-assistant` must not be imported by
 * the supplier-review module (that would couple document reading to the chat
 * agent). Callers that need case/ punctuation folding add it themselves — this
 * function does not touch digits or punctuation, because folding a digit away
 * turns a different tax number into a matching one.
 */
export function normalizeArabic(input: string): string {
  return (input || "")
    .replace(/[\u0617-\u061A\u064B-\u0652\u0670\u0640]/g, "") // harakat + tatweel
    .replace(/[إأآٱا]/g, "ا")
    .replace(/[ىي]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ؤئء]/g, "ء")
    .toLowerCase()
    .trim();
}
