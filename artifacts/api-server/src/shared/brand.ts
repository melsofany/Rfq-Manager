/**
 * The Cortoba visual identity, in one place.
 *
 * Every printed document (supplier file, statements, payment orders) and every
 * outbound notification draws from these tokens. Two copies of a colour drift
 * apart the moment someone tweaks one — the same failure this repo has recorded
 * for `rtl()` and for the email-tool list.
 *
 * Colours come from the business card artwork, NOT from sampling the logo PNG:
 * the card is the approved source, and a logo file that renders slightly
 * differently (gradients, JPEG artefacts) must not redefine the brand.
 */

/** Brand palette. `gold` and `sand` are accents only — never body text. */
export const BRAND = {
  /** الأحمر القرطبي — primary: headings, buttons, rules. */
  red: "#8B2029",
  /** العنابي الداكن — dark section backgrounds and footers. */
  maroon: "#641D29",
  /** الذهبي — separators and small details only. */
  gold: "#C7A05B",
  /** النص الداكن — body text on light backgrounds. */
  ink: "#171416",
  /** خلفية الصفحة. */
  page: "#FBF7F7",
  /** بيج فاتح — soft section fill. */
  beige: "#F2E9DD",
  /** ذهبي فاتح — accent fills. */
  sand: "#D7B77F",
} as const;

/**
 * Company identity.
 *
 * `nameEn` is deliberately «CORTOBA FOR SUPPLIES» — the spelling printed on the
 * official card. Invoices and payslips had drifted to «Cortoba Supplies», so the
 * two spellings coexisted in the same system. One identity has to win: the card
 * is the document we hand to a bank or a customer, so it is the one that
 * identifies the company. Everything generated from now on uses this constant
 * instead of a literal.
 */
export const COMPANY = {
  nameAr: "قرطبة للتوريدات",
  nameEn: "CORTOBA FOR SUPPLIES",
  /** Arabic-first line used in documents and message bodies. */
  display: "شركة قرطبة للتوريدات",
  phone: "432-972-587",
  city: "مرسي مطروح",
  email: "info@cortoba-supplies.com",
  website: "cortoba-supplies.com",
} as const;

/** Font family names as registered with PDFKit. */
export const BRAND_FONTS = {
  /** Noto Kufi Arabic — headings and body per the identity sheet. */
  arabic: "Kufi",
  arabicBold: "KufiBold",
  /** Arial for the English company name; PDFKit ships Helvetica, its metric twin. */
  latin: "Helvetica",
  latinBold: "Helvetica-Bold",
} as const;

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * Reverse the word order of `text` for RTL display.
 *
 * PDFKit lays a string out strictly left-to-right and shapes each
 * space-separated word on its own (fontkit reverses the characters INSIDE a
 * word, so a single word is already correct). It never reorders words, so a
 * multi-word Arabic phrase comes out with its words in reverse reading order.
 *
 * The rule: compose the FULL string first, then reverse its words EXACTLY ONCE.
 * Applying it twice restores the logical order — which is how «إجمالي المستحق»
 * once reached a supplier as «المستحق: إجمالي».
 */
export function rtl(text: string | null | undefined): string {
  if (!text) return text ?? "";
  const trimmed = String(text).trim();
  if (!ARABIC_RE.test(trimmed)) return trimmed;
  const words = trimmed.split(/\s+/);
  if (words.length <= 1) return trimmed;
  return words.reverse().join(" ");
}

/** Compose a label with its value, then lay the RESULT out RTL (one reversal). */
export function rtlLabelValue(label: string, value: string | number | null | undefined): string {
  return rtl(`${label} ${value ?? ""}`.trim());
}

/** True when the text contains Arabic — used to pick a font. */
export function hasArabic(text: string | null | undefined): boolean {
  return ARABIC_RE.test(String(text ?? ""));
}
