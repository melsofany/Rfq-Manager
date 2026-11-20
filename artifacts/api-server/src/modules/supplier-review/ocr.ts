/**
 * Document reading and declared-vs-document comparison.
 *
 * The operator's rule, encoded: «نتائج الذكاء الاصطناعي استرشادية فقط، ولا يجوز
 * اعتبارها إثباتًا قانونيًا». So nothing here decides anything — it produces a
 * COMPARISON the reviewer reads, and every comparison row carries the evidence
 * that produced it. The reviewer's verdict is what gets stored as final.
 *
 * Two layers, and the split matters:
 *   * `parseExtraction` — pure. Turns the model's JSON reply into a typed
 *     result, and refuses to invent a value it did not receive.
 *   * `compareField` — pure. Compares one declared value against one extracted
 *     value and returns a VERDICT, including «not found» and «unreadable»,
 *     which are different answers and must not collapse into «mismatch».
 */
import { normalizeArabic } from "../../shared/arabic-text";

/** What we look for in a document. */
export interface DocumentExtraction {
  companyName: string | null;
  taxRegistration: string | null;
  commercialRegister: string | null;
  activity: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  items: string[];
  brands: string[];
  issuer: string | null;
  invoiceValue: string | null;
  /** True when the model could not read the file at all. */
  unreadable: boolean;
  /** 0–1. The model's own confidence; shown to the reviewer, never trusted. */
  confidence: number | null;
  /** Verbatim text the model returned, so the reviewer can check the reading. */
  rawText: string | null;
}

const EMPTY_EXTRACTION: DocumentExtraction = {
  companyName: null,
  taxRegistration: null,
  commercialRegister: null,
  activity: null,
  issuedAt: null,
  expiresAt: null,
  items: [],
  brands: [],
  issuer: null,
  invoiceValue: null,
  unreadable: false,
  confidence: null,
  rawText: null,
};

/** Pull the first JSON object out of a reply that may be fenced or chatty. */
export function extractJsonBlock(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  const text = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Read a field under ANY of its known key spellings.
 *
 * Discovered live: asked for English JSON keys, the model sometimes answers
 * `{"اسم_الشركة": "..."}` — the Arabic name of the field. A parser that only
 * knows the English keys reports «nothing found» for a perfectly readable
 * document, which is the silent-false-negative this module exists to avoid.
 */
function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  // Last resort: match a key whose Arabic form folds to one of the aliases.
  const wanted = new Set(keys.map((k) => normalizeForCompare(k).replace(/ /g, "")));
  for (const [key, value] of Object.entries(obj)) {
    const folded = normalizeForCompare(key).replace(/ /g, "");
    if (wanted.has(folded)) return value;
  }
  return undefined;
}

function str(value: unknown): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    // The model's way of saying "absent" must become null, not the word.
    if (!t || /^(null|none|غير موجود|غير متوفر|—|-|n\/a)$/i.test(t)) return null;
    return t;
  }
  if (typeof value === "number") return String(value);
  return null;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => str(v)).filter((v): v is string => Boolean(v));
  }
  const one = str(value);
  return one ? [one] : [];
}

/**
 * Turn the model's reply into a typed extraction.
 *
 * A reply with no parseable JSON is NOT an empty document — it is a failed
 * read, and `unreadable` says so. Collapsing the two would let the console show
 * «no differences» for a file nobody actually read.
 */
export function parseExtraction(raw: string | null): DocumentExtraction {
  const obj = extractJsonBlock(raw);
  if (!obj) {
    return { ...EMPTY_EXTRACTION, unreadable: Boolean(raw), rawText: raw ?? null };
  }
  const confidenceRaw = obj.confidence;
  const confidence =
    typeof confidenceRaw === "number"
      ? Math.max(0, Math.min(1, confidenceRaw))
      : typeof confidenceRaw === "string" && confidenceRaw.trim() !== ""
        ? Math.max(0, Math.min(1, Number(confidenceRaw) || 0))
        : null;
  const unreadableFlag = pick(obj, "unreadable", "غير_مقروء") === true || obj.readable === false;
  const result: DocumentExtraction = {
    companyName: str(
      pick(obj, "companyName", "company_name", "name", "اسم_الشركة", "اسم الشركة", "الاسم التجاري"),
    ),
    taxRegistration: str(
      pick(obj, "taxRegistration", "tax_registration", "taxCard", "الرقم_الضريبي", "الرقم الضريبي"),
    ),
    commercialRegister: str(
      pick(
        obj,
        "commercialRegister",
        "commercial_register",
        "رقم_السجل_التجاري",
        "رقم السجل التجاري",
      ),
    ),
    activity: str(pick(obj, "activity", "businessActivity", "النشاط")),
    issuedAt: str(
      pick(obj, "issuedAt", "issued_at", "issueDate", "تاريخ_الإصدار", "تاريخ الإصدار"),
    ),
    expiresAt: str(
      pick(obj, "expiresAt", "expires_at", "expiryDate", "تاريخ_الانتهاء", "تاريخ الانتهاء"),
    ),
    items: list(pick(obj, "items", "products", "البنود", "المنتجات")),
    brands: list(pick(obj, "brands", "brandNames", "العلامات_التجارية", "العلامات التجارية")),
    issuer: str(pick(obj, "issuer", "issuedBy", "الجهة_المصدرة", "الجهة المصدرة")),
    invoiceValue: str(pick(obj, "invoiceValue", "total", "إجمالي_الفاتورة", "الإجمالي")),
    unreadable: unreadableFlag,
    confidence,
    rawText: raw,
  };
  // A reply that names nothing at all is a failed read even without the flag.
  const namedSomething =
    result.companyName ||
    result.taxRegistration ||
    result.commercialRegister ||
    result.activity ||
    result.items.length > 0 ||
    result.brands.length > 0 ||
    result.issuer;
  if (!namedSomething && !result.unreadable) result.unreadable = true;
  return result;
}

/** The comparison verdicts the operator listed. */
export const COMPARE_RESULT = {
  MATCH: "match",
  MISMATCH: "mismatch",
  NOT_IN_DOCUMENT: "not_in_document",
  UNREADABLE: "unreadable",
  EXPIRED: "expired",
  EXTRACTION_FAILED: "extraction_failed",
  MANUAL: "manual_review",
  /**
   * Same digits, group order reversed — an RTL rendering artifact, not a
   * difference. Measured live: an Arabic line `الرقم الضريبي: 555-666-777` is
   * read back as `777-666-555`, because bidi reorders the numeric groups when
   * the surrounding text runs right-to-left. Reporting this as a mismatch
   * would put a false alarm in front of the reviewer on a document that
   * actually matches, so it is its own verdict and the console says so.
   */
  MATCH_REORDERED: "match_reordered",
} as const;

export type CompareResult = (typeof COMPARE_RESULT)[keyof typeof COMPARE_RESULT];

export const COMPARE_LABELS: Record<CompareResult, string> = {
  match: "متطابق",
  mismatch: "اختلاف يحتاج مراجعة",
  not_in_document: "غير موجود في المستند",
  unreadable: "مستند غير واضح",
  expired: "مستند منتهي الصلاحية",
  extraction_failed: "تعذر استخراج البيانات",
  manual_review: "يحتاج تحققًا يدويًا",
  match_reordered: "متطابق (ترتيب المجموعات معكوس — أثر اتجاه النص)",
};

/**
 * Fold a value for comparison: Arabic spelling variants, case, punctuation and
 * spacing. Deliberately does NOT fold DIGITS — a tax number that differs by one
 * digit is a different number, and folding it away is the bug, not the fix.
 */
export function normalizeForCompare(value: string | null | undefined): string {
  if (!value) return "";
  return normalizeArabic(String(value))
    .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
    .replace(/[.,;:،؛\-_/\\()"'\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Digits only — a tax/register number is compared on its digits. */
export function digitsOnly(value: string | null | undefined): string {
  if (!value) return "";
  return String(value)
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, "");
}

/**
 * Split a number into its printed groups, keeping the separators' meaning but
 * not their identity (`111-222-333` → `["111","222","333"]`).
 */
export function digitGroups(value: string | null | undefined): string[] {
  if (!value) return [];
  return String(value)
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .split(/[^0-9]+/)
    .filter(Boolean);
}

/**
 * Is `extracted` the same number as `declared`, only with its groups printed in
 * the opposite order?
 *
 * Requires the SAME digits in the same order once concatenated — so this can
 * never turn two different numbers into a match, only undo a bidi reordering.
 */
export function isReorderedSameNumber(
  declared: string | null | undefined,
  extracted: string | null | undefined,
): boolean {
  const dg = digitGroups(declared);
  const eg = digitGroups(extracted);
  if (dg.length < 2 || eg.length !== dg.length) return false;
  // The REVERSED groups must concatenate to exactly what was extracted. Comparing
  // the forward concatenations instead would reject the very case this exists
  // for: reversing groups changes the digit string (`555666777` vs `777666555`),
  // so equality there can never hold.
  return dg.slice().reverse().join("") === eg.join("");
}

/**
 * Compare one declared value against one extracted value.
 *
 * `kind: "number"` compares digits only (a tax number written `111-222-333`
 * and `111222333` is the same number). `kind: "text"` compares normalised text
 * and accepts a CONTAINED match — a document naming
 * «الخديوي للمقاولات والتوريدات» does confirm a declared «الخديوي للمقاولات»,
 * and demanding equality would flag every real document as a mismatch.
 */
export function compareField(
  declared: string | null | undefined,
  extracted: string | null | undefined,
  kind: "text" | "number" = "text",
  opts: { unreadable?: boolean } = {},
): CompareResult {
  if (opts.unreadable) return COMPARE_RESULT.UNREADABLE;
  const d = kind === "number" ? digitsOnly(declared) : normalizeForCompare(declared);
  const e = kind === "number" ? digitsOnly(extracted) : normalizeForCompare(extracted);
  if (!e) return COMPARE_RESULT.NOT_IN_DOCUMENT;
  if (!d) return COMPARE_RESULT.MANUAL;
  if (d === e) return COMPARE_RESULT.MATCH;
  if (kind === "number" && isReorderedSameNumber(declared, extracted)) {
    return COMPARE_RESULT.MATCH_REORDERED;
  }
  if (kind === "text") {
    // Contained either way — the shorter must be a real run of words, not one
    // stray token that happens to appear in both.
    if (d.length >= 4 && (e.includes(d) || d.includes(e))) return COMPARE_RESULT.MATCH;
    // A NUMBER in the declared value is decisive: `CABLE 50 MM` and
    // `CABLE 70 MM` share two words of three and are different articles. The
    // word-overlap rule below must never override a differing number, or the
    // console confirms a product the supplier does not actually supply.
    const dNums = d.match(/\d+/g) ?? [];
    const eNums = new Set(e.match(/\d+/g) ?? []);
    if (dNums.some((n) => !eNums.has(n))) return COMPARE_RESULT.MISMATCH;

    const dWords = d.split(" ").filter((w) => w.length > 2 && !/^\d+$/.test(w));
    const eWords = new Set(e.split(" ").filter((w) => w.length > 2 && !/^\d+$/.test(w)));
    if (dWords.length > 0) {
      const hit = dWords.filter((w) => eWords.has(w)).length;
      if (hit / dWords.length >= 0.75) return COMPARE_RESULT.MATCH;
    }
  }
  return COMPARE_RESULT.MISMATCH;
}

/**
 * Is a document past its expiry?
 *
 * Compared against `today` as a DATE. An unparseable expiry is NOT treated as
 * valid — «I could not read the date» and «the document is current» are
 * different answers, and assuming the second is how an expired licence gets
 * approved.
 */
export function isExpired(
  expiresAt: string | null | undefined,
  today: Date = new Date(),
): boolean | null {
  if (!expiresAt) return null;
  const raw = String(expiresAt).trim();
  // dd/mm/yyyy and dd-mm-yyyy are what Egyptian documents print.
  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(raw);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  let date: Date | null = null;
  if (iso) date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  else if (dmy) date = new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])));
  else {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  if (!date || Number.isNaN(date.getTime())) return null;
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return date.getTime() < todayUtc;
}

/** One row of the comparison table the console renders. */
export interface ComparisonRow {
  /** Stable key — also the field the reviewer's verdict is stored against. */
  key: string;
  label: string;
  declared: string | null;
  extracted: string | null;
  result: CompareResult;
  /** Which document produced the extracted value (null when none did). */
  sourceDocumentId: number | null;
  sourceDocumentLabel: string | null;
}

export interface ComparisonInput {
  declared: Record<string, string | null | undefined>;
  /** Extractions keyed by document id. */
  documents: Array<{
    id: number;
    label: string;
    extraction: DocumentExtraction;
  }>;
}

/** The declared fields we compare, in the order the console shows them. */
const COMPARED_FIELDS: Array<{
  key: string;
  label: string;
  kind: "text" | "number";
  from: (e: DocumentExtraction) => string | null;
}> = [
  { key: "name", label: "اسم الشركة", kind: "text", from: (e) => e.companyName },
  {
    key: "taxRegistration",
    label: "الرقم الضريبي",
    kind: "number",
    from: (e) => e.taxRegistration,
  },
  {
    key: "commercialRegister",
    label: "رقم السجل التجاري",
    kind: "number",
    from: (e) => e.commercialRegister,
  },
  { key: "activity", label: "النشاط", kind: "text", from: (e) => e.activity },
];

/**
 * Build the whole comparison table.
 *
 * A field is matched when ANY readable document confirms it — a tax number may
 * appear on the tax card and again on a previous invoice, and one confirmation
 * is enough. When every document is unreadable the verdict is «unreadable»,
 * never «not found»: we did not read it, so we cannot say it is absent.
 */
export function buildComparison(input: ComparisonInput): ComparisonRow[] {
  const docs = input.documents.filter((d) => !d.extraction.unreadable);
  const anyUnreadable = input.documents.some((d) => d.extraction.unreadable);
  const noDocuments = input.documents.length === 0;

  return COMPARED_FIELDS.map((field) => {
    const declared = input.declared[field.key] ?? null;
    let best: {
      result: CompareResult;
      value: string | null;
      doc: ComparisonInput["documents"][number];
    } | null = null;
    const rank: Record<CompareResult, number> = {
      match: 0,
      match_reordered: 0,
      mismatch: 1,
      manual_review: 2,
      expired: 3,
      not_in_document: 4,
      unreadable: 5,
      extraction_failed: 6,
    };

    for (const doc of docs) {
      const extracted = field.from(doc.extraction);
      const result = compareField(declared, extracted, field.kind);
      if (!best || rank[result] < rank[best.result]) {
        best = { result, value: extracted, doc };
      }
    }

    if (noDocuments) {
      return {
        key: field.key,
        label: field.label,
        declared,
        extracted: null,
        result: COMPARE_RESULT.NOT_IN_DOCUMENT,
        sourceDocumentId: null,
        sourceDocumentLabel: null,
      };
    }
    if (!best) {
      return {
        key: field.key,
        label: field.label,
        declared,
        extracted: null,
        result: anyUnreadable ? COMPARE_RESULT.UNREADABLE : COMPARE_RESULT.EXTRACTION_FAILED,
        sourceDocumentId: null,
        sourceDocumentLabel: null,
      };
    }
    return {
      key: field.key,
      label: field.label,
      declared,
      extracted: best.value,
      result: best.result,
      sourceDocumentId: best.doc.id,
      sourceDocumentLabel: best.doc.label,
    };
  });
}

/**
 * Brand / item evidence.
 *
 * Kept separate from the identity fields because the verdict vocabulary is
 * different: a brand is «مثبت» (appears on a document) or «غير مثبت» — there is
 * no mismatch, since a supplier may legitimately deal in brands we have not
 * seen invoiced yet.
 */
export interface BrandEvidence {
  brand: string;
  proven: boolean;
  sourceDocumentId: number | null;
  sourceDocumentLabel: string | null;
}

export function buildBrandEvidence(
  declaredBrands: string[],
  documents: ComparisonInput["documents"],
): BrandEvidence[] {
  return declaredBrands.map((brand) => {
    const needle = normalizeForCompare(brand);
    for (const doc of documents) {
      if (doc.extraction.unreadable) continue;
      const haystack = [
        ...doc.extraction.brands,
        ...doc.extraction.items,
        doc.extraction.rawText ?? "",
      ]
        .map(normalizeForCompare)
        .join(" | ");
      if (needle.length >= 3 && haystack.includes(needle)) {
        return {
          brand,
          proven: true,
          sourceDocumentId: doc.id,
          sourceDocumentLabel: doc.label,
        };
      }
    }
    return { brand, proven: false, sourceDocumentId: null, sourceDocumentLabel: null };
  });
}

/** The prompt handed to the vision model for a supplier document. */
export const SUPPLIER_DOC_PROMPT = `أنت تقرأ مستندًا رسميًا لمورد (سجل تجاري، بطاقة ضريبية، شهادة تسجيل ضريبي، فاتورة ضريبية، أمر توريد، عرض سعر، كتالوج، أو شهادة وكالة).
استخرج البيانات التالية وأعدها بصيغة JSON فقط دون أي نص إضافي:
{
  "companyName": "الاسم التجاري كما هو مطبوع",
  "taxRegistration": "الرقم الضريبي (أرقام فقط)",
  "commercialRegister": "رقم السجل التجاري (أرقام فقط)",
  "activity": "النشاط المذكور في المستند",
  "issuedAt": "تاريخ الإصدار YYYY-MM-DD إن وجد",
  "expiresAt": "تاريخ الانتهاء YYYY-MM-DD إن وجد",
  "items": ["أسماء البنود أو المنتجات إن وجدت"],
  "brands": ["العلامات التجارية إن وجدت"],
  "issuer": "الجهة المصدرة",
  "invoiceValue": "إجمالي الفاتورة إن كانت فاتورة",
  "confidence": 0.0,
  "unreadable": false
}
قواعد صارمة:
- لا تخترع قيمة. إن لم تجد الحقل فاكتب null.
- إن كانت الصورة غير واضحة أو غير مقروءة فاجعل "unreadable": true.
- "confidence" رقم بين 0 و1 يعبّر عن ثقتك في القراءة.
- لا تُصدر أي حكم على صحة المستند أو ملكية العلامة التجارية؛ أنت تقرأ فقط.`;
