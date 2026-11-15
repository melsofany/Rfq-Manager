/**
 * Arabic ↔ English search terms for the item catalogue.
 *
 * The operator's report: «أنا كتبت بالعربي، المفروض هو يدور بالعربي والإنجليزي».
 * Measured on production: «سلك حراري 10ملم» returned «لم أعثر على صنف» while
 * `customer_po_items` holds 186 rows matching `CABLE`, 370 matching `HEAT` and 8
 * matching `THERMAL` — including `DRAIN HEATING ELEMENT 5 MT. CABLE 220V` and
 * `FREEZER DRAIN HEATER`. The descriptions come from the customer's ERP in
 * English; the manually entered ones are Arabic (`لفه سلك شعر السويدى ... كابل
 * 3*6`), so BOTH languages live in one column and a search must reach across.
 *
 * `ilike '%حراري%'` cannot match `CABLE`. That is the whole defect: the query
 * was correct, the vocabulary was missing.
 *
 * The pairs below are read from what production actually contains — the English
 * side is the top-40 tokens of `customer_po_items.description`, the Arabic side
 * the Arabic tokens that occur there — not from a general dictionary. Adding a
 * word the data never uses only widens the search for nothing.
 *
 * Deliberately NOT a translation API: a model call per search would spend the
 * quota whose exhaustion is this assistant's recorded failure mode, and it would
 * be non-deterministic, so the same question could search differently twice.
 */

/**
 * Arabic term → the English words it denotes. One Arabic word may map to several
 * English ones (`سلك` is a wire OR a cable), and all of them are OR-ed: a row
 * matches if it holds ANY of them.
 */
const AR_TO_EN: Record<string, string[]> = {
  // ── Conductors and cabling ──────────────────────────────────────────────
  سلك: ["WIRE", "CABLE"],
  اسلاك: ["WIRE", "CABLE"],
  كابل: ["CABLE", "WIRE"],
  كابلات: ["CABLE", "WIRE"],
  موصل: ["CONDUCTOR"],
  موصلات: ["CONDUCTOR"],
  شعر: ["WIRE"], // «سلك شعر» = stranded wire
  // ── Thermal / heating ───────────────────────────────────────────────────
  حراري: ["THERMAL", "HEAT", "HEATER", "HEATING"],
  حرارى: ["THERMAL", "HEAT", "HEATER", "HEATING"],
  حراره: ["HEAT", "HEATER", "HEATING"],
  سخان: ["HEATER", "WATER HEATER"],
  سخانات: ["HEATER", "WATER HEATER"],
  ترمستات: ["THERMOSTAT"],
  ثرموستات: ["THERMOSTAT"],
  // ── Cooling ─────────────────────────────────────────────────────────────
  فريزر: ["FREEZER"],
  ثلاجه: ["REFRIGERATOR"],
  تلاجه: ["REFRIGERATOR"],
  مبرد: ["REFRIGERATOR", "COOLER"],
  تكييف: ["AIR CONDITION", "CONDITIONER", "AC"],
  فريون: ["FREON"],
  ضاغط: ["COMPRESSOR"],
  كومبريسور: ["COMPRESSOR"],
  // ── Cooking / kitchen ───────────────────────────────────────────────────
  بوتاجاز: ["COOKER", "RANGE"],
  فرن: ["OVEN", "COOKER"],
  ميكروويف: ["MICROWAVE"],
  مقلايه: ["FRYER"],
  قلايه: ["FRYER"],
  غساله: ["WASHER", "WASHING MACHINE"],
  خلاط: ["BLENDER", "MIXER"],
  مفرمه: ["MEAT GRINDER", "MINCER"],
  // ── Electrical switchgear ───────────────────────────────────────────────
  قاطع: ["SWITCH", "BREAKER", "CONTACTOR"],
  قواطع: ["SWITCH", "BREAKER", "CONTACTOR"],
  كونتاكتور: ["CONTACTOR"],
  كونتكتور: ["CONTACTOR"],
  مفتاح: ["SWITCH"],
  محول: ["TRANSFORMER"],
  ترانس: ["TRANSFORMER"],
  // ── Lighting ────────────────────────────────────────────────────────────
  لمبه: ["LAMP", "BULB", "LED"],
  لمبات: ["LAMP", "BULB", "LED"],
  كشاف: ["FLOODLIGHT", "SPOTLIGHT", "LAMP"],
  ليد: ["LED"],
  // ── Materials ───────────────────────────────────────────────────────────
  مكرونه: ["HEAT SHRINK", "TUBING"],
  ماسوره: ["PIPE"],
  مواسير: ["PIPE"],
  كوع: ["ELBOW"],
  طبه: ["PLUG"],
  بلجه: ["BEARING"],
  ترامل: ["TERMINAL", "FERRULE"],
  مشترك: ["SOCKET", "ADAPTER", "EXTENSION"],
  // ── Units and measures are deliberately ABSENT ──────────────────────────
  // They are not discriminators: measured on production, `M` matches 79% of
  // `customer_po_items` (it is a substring of MM, MODEL, MADE…), `W` 57% and
  // `V` 50%. OR-ing one of those turns the search into the whole table, which
  // reads as a wrong answer rather than a wide one. A size is a refinement the
  // operator's own phrase already carries (`... 10ملم`), not an alternative.
  // ── Origin ──────────────────────────────────────────────────────────────
  ايطالي: ["ITALY", "ITALIAN"],
  ايطالى: ["ITALY", "ITALIAN"],
  الماني: ["GERMANY", "GERMAN"],
  تركي: ["TURKEY", "TURKISH"],
  اسباني: ["SPAIN", "SPANISH"],
  مصري: ["EGYPT", "EGYPTIAN"],
  صيني: ["CHINA", "CHINESE"],
};

/**
 * English term → the Arabic words it denotes, for the reverse direction (a
 * manager typing `CABLE` about a row whose description is Arabic).
 */
const EN_TO_AR: Record<string, string[]> = {
  WIRE: ["سلك", "اسلاك", "شعر"],
  CABLE: ["كابل", "سلك"],
  CONDUCTOR: ["موصل"],
  THERMAL: ["حراري"],
  HEAT: ["حراري", "حراره"],
  HEATER: ["سخان", "حراري"],
  HEATING: ["حراري"],
  THERMOSTAT: ["ترمستات"],
  FREEZER: ["فريزر"],
  REFRIGERATOR: ["ثلاجه", "تلاجه"],
  COMPRESSOR: ["ضاغط", "كومبريسور"],
  FREON: ["فريون"],
  COOKER: ["بوتاجاز", "فرن"],
  OVEN: ["فرن"],
  FRYER: ["قلايه", "مقلايه"],
  BLENDER: ["خلاط"],
  SWITCH: ["مفتاح", "قاطع"],
  BREAKER: ["قاطع"],
  CONTACTOR: ["كونتاكتور", "قاطع"],
  LAMP: ["لمبه", "كشاف"],
  BULB: ["لمبه"],
  LED: ["ليد"],
  PIPE: ["ماسوره", "مواسير"],
  ELBOW: ["كوع"],
  TERMINAL: ["ترامل"],
  TRANSFORMER: ["محول", "ترانس"],
};

/**
 * English words that are too generic to be worth OR-ing: every row carries them
 * (WITH, MODEL, MADE, ONLY…), so adding them returns the whole table and the
 * search stops discriminating. Measured as the top tokens of production.
 */
const EN_STOPWORDS = new Set([
  "WITH",
  "MODEL",
  "MADE",
  "ONLY",
  "SIZE",
  "TYPE",
  "UNIT",
  "FOR",
  "AND",
  "THE",
  "NEW",
  "SET",
  "PCS",
  "EA",
  "EACH",
  "MAKER",
  "BRAND",
  "QTY",
  "ITEM",
  "PART",
  "NO",
]);

/** Arabic words that are too generic for the same reason. */
const AR_STOPWORDS = new Set([
  "قطعه",
  "قطعة",
  "عدد",
  "مقاس",
  "نوع",
  "لون",
  "جديد",
  "فقط",
  "مع",
  "من",
  "على",
  "في",
]);

/** Fold the Arabic letter variants so one spelling finds another. */
function foldArabic(w: string): string {
  return w
    .replace(/[\u0617-\u061A\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[إأآٱا]/g, "ا")
    .replace(/[ىي]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ؤئء]/g, "ء");
}

/** Arabic-Indic and extended digits → Latin, so «١٠» becomes «10». */
export function latinDigits(input: string): string {
  return (input || "").replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => {
    const code = d.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

const ARABIC_RE = /[\u0600-\u06FF]/;

/**
 * The extra terms to search for, beyond the operator's own words.
 *
 * Returns the ORIGINAL term first (so a direct hit is never lost) followed by
 * the cross-language words. Every returned term is matched with OR, because a
 * row that holds the English word and a row that holds the Arabic one are both
 * answers to the same question.
 *
 * A term with no known counterpart returns just itself — inventing a translation
 * would widen the search onto unrelated rows, which reads as a wrong answer
 * rather than a missing one.
 */
export function expandSearchTerms(term: string): string[] {
  const raw = latinDigits((term || "").trim());
  if (!raw) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const k = t.trim().toUpperCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(t.trim());
  };

  // The operator's own words come FIRST so a direct hit is never lost, and they
  // stay the whole phrase: splitting them into bare words would match
  // «سلك شعر السويدى» for a query about «سلك حراري» and present a non-thermal
  // wire as an answer. A wrong answer is worse than a missing one, so only the
  // CROSS-LANGUAGE counterpart is added, never a looser form of the input.
  push(raw);

  for (const w of raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    if (ARABIC_RE.test(w)) {
      // A token may glue digits to the word («10ملم»): read every Arabic run in
      // it, so the unit is found without splitting the size off as its own term.
      for (const run of w.match(/[\u0600-\u06FF]+/g) ?? []) {
        const folded = foldArabic(run);
        if (AR_STOPWORDS.has(folded)) continue;
        const en = AR_TO_EN[folded];
        if (en) for (const e of en) push(e);
      }
    } else {
      const up = w.toUpperCase();
      if (EN_STOPWORDS.has(up)) continue;
      const ar = EN_TO_AR[up];
      if (ar) for (const a of ar) push(a);
    }
  }

  return out;
}

/** Exposed for the vocabulary guard test. */
export const VOCAB = { AR_TO_EN, EN_TO_AR, EN_STOPWORDS, AR_STOPWORDS };
