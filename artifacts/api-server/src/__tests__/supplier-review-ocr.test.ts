import { describe, it, expect } from "vitest";
import {
  COMPARE_RESULT,
  buildBrandEvidence,
  buildComparison,
  compareField,
  digitGroups,
  extractJsonBlock,
  isExpired,
  isReorderedSameNumber,
  normalizeForCompare,
  parseExtraction,
} from "../modules/supplier-review/ocr";

describe("OCR — reading the model's reply", () => {
  it("parses a fenced JSON reply", () => {
    const raw = '```json\n{"companyName":"الخديوي للمقاولات","taxRegistration":"111-222-333"}\n```';
    const e = parseExtraction(raw);
    expect(e.companyName).toBe("الخديوي للمقاولات");
    expect(e.taxRegistration).toBe("111-222-333");
    expect(e.unreadable).toBe(false);
  });

  it("parses a JSON block embedded in chatty prose", () => {
    const raw = 'إليك البيانات:\n{"commercialRegister":"12345"}\nشكرًا.';
    expect(parseExtraction(raw).commercialRegister).toBe("12345");
  });

  it("marks a reply with NO json as unreadable, not as an empty document", () => {
    // The distinction is the whole point: «no differences» must never be the
    // verdict for a file nobody could read.
    const e = parseExtraction("الصورة غير واضحة ولا يمكن قراءتها");
    expect(e.unreadable).toBe(true);
  });

  it("marks a JSON reply that names nothing as unreadable", () => {
    const e = parseExtraction('{"companyName":null,"taxRegistration":null}');
    expect(e.unreadable).toBe(true);
  });

  it("honours the model's own unreadable flag", () => {
    expect(parseExtraction('{"unreadable":true,"companyName":"x"}').unreadable).toBe(true);
  });

  it("turns the model's «absent» words into null, never into a value", () => {
    const e = parseExtraction(
      '{"companyName":"غير موجود","taxRegistration":"N/A","commercialRegister":"—"}',
    );
    expect(e.companyName).toBeNull();
    expect(e.taxRegistration).toBeNull();
    expect(e.commercialRegister).toBeNull();
  });

  it("clamps confidence into 0..1 and tolerates its absence", () => {
    expect(parseExtraction('{"companyName":"x","confidence":5}').confidence).toBe(1);
    expect(parseExtraction('{"companyName":"x","confidence":-2}').confidence).toBe(0);
    expect(parseExtraction('{"companyName":"x"}').confidence).toBeNull();
  });

  it("reads an Arabic-keyed reply — the model sometimes answers in Arabic", () => {
    // Measured live: asked for English keys, the model replied
    // {"اسم_الشركة": "...", "الرقم_الضريبي": "333-222-111"}. A parser that only
    // knew the English keys called a perfectly readable document unreadable.
    const e = parseExtraction(
      '{"اسم_الشركة":"الخديوي للمقاولات","الرقم_الضريبي":"333-222-111","رقم_السجل_التجاري":"12345"}',
    );
    expect(e.unreadable).toBe(false);
    expect(e.companyName).toBe("الخديوي للمقاولات");
    expect(e.taxRegistration).toBe("333-222-111");
    expect(e.commercialRegister).toBe("12345");
  });

  it("extractJsonBlock returns null for unparseable input rather than throwing", () => {
    expect(extractJsonBlock("{not json")).toBeNull();
    expect(extractJsonBlock(null)).toBeNull();
  });
});

describe("OCR — comparing values", () => {
  it("matches the same text written with Arabic spelling variants", () => {
    // إ/ا, ة/ه and ya variants are the same word to a human reader.
    expect(compareField("الخديوي للمقاولات", "الخديوى للمقاولات")).toBe(COMPARE_RESULT.MATCH);
  });

  it("matches a document that names the company in a longer form", () => {
    // Demanding equality would flag every real commercial register, which
    // prints the full legal name.
    expect(compareField("الخديوي للمقاولات", "الخديوي للمقاولات والتوريدات العمومية")).toBe(
      COMPARE_RESULT.MATCH,
    );
  });

  it("reports a MISMATCH when the names genuinely differ", () => {
    expect(compareField("الخديوي للمقاولات", "النيل للأسمنت")).toBe(COMPARE_RESULT.MISMATCH);
  });

  it("compares numbers on their digits, ignoring the printed separators", () => {
    expect(compareField("111-222-333", "111222333", "number")).toBe(COMPARE_RESULT.MATCH);
  });

  it("still reports a DIFFERENT tax number as a mismatch — digits are not folded", () => {
    // One changed digit is a different taxpayer.
    expect(compareField("111-222-333", "111-222-334", "number")).toBe(COMPARE_RESULT.MISMATCH);
  });

  it("says «not in the document» when the field was not found, not «mismatch»", () => {
    expect(compareField("111-222-333", null, "number")).toBe(COMPARE_RESULT.NOT_IN_DOCUMENT);
  });

  it("says «needs manual verification» when WE have no declared value", () => {
    // Nothing to compare against is not a difference.
    expect(compareField(null, "111-222-333", "number")).toBe(COMPARE_RESULT.MANUAL);
  });

  it("reports an unreadable document as unreadable whatever the values are", () => {
    expect(compareField("x", "x", "text", { unreadable: true })).toBe(COMPARE_RESULT.UNREADABLE);
  });

  it("does not fold a DIFFERENT size away (CABLE 50 vs 70 is a different article)", () => {
    expect(compareField("CABLE 50 MM", "CABLE 70 MM")).toBe(COMPARE_RESULT.MISMATCH);
  });
});

describe("OCR — the RTL digit-group reversal (measured live)", () => {
  it("recognises a reversed group order as the SAME number", () => {
    // Measured against the live model: an Arabic line printing
    // «الرقم الضريبي: 555-666-777» comes back as «777-666-555» because bidi
    // reorders the numeric groups. Reporting that as a mismatch puts a false
    // alarm in front of the reviewer on a document that actually matches.
    expect(compareField("555-666-777", "777-666-555", "number")).toBe(
      COMPARE_RESULT.MATCH_REORDERED,
    );
    expect(isReorderedSameNumber("555-666-777", "777-666-555")).toBe(true);
  });

  it("does NOT treat two different numbers as a reordering", () => {
    // The guard that keeps the above honest: the concatenated digits must be
    // identical, so this can only undo a bidi reorder.
    expect(isReorderedSameNumber("555-666-777", "555-666-778")).toBe(false);
    expect(compareField("555-666-777", "555-666-778", "number")).toBe(COMPARE_RESULT.MISMATCH);
  });

  it("does not apply to single-group numbers", () => {
    expect(isReorderedSameNumber("12345", "54321")).toBe(false);
  });

  it("splits groups for the console to show them", () => {
    expect(digitGroups("111-222-333")).toEqual(["111", "222", "333"]);
    expect(digitGroups("١١١-٢٢٢")).toEqual(["111", "222"]);
  });
});

describe("OCR — expiry", () => {
  it("flags a document whose expiry has passed", () => {
    expect(isExpired("2020-01-01", new Date("2026-11-20"))).toBe(true);
  });

  it("accepts a document still in date", () => {
    expect(isExpired("2030-01-01", new Date("2026-11-20"))).toBe(false);
  });

  it("reads the dd/mm/yyyy form Egyptian documents actually print", () => {
    expect(isExpired("01/01/2020", new Date("2026-11-20"))).toBe(true);
    expect(isExpired("31/12/2030", new Date("2026-11-20"))).toBe(false);
  });

  it("returns null for no expiry and for an unparseable one — never «valid»", () => {
    // «I could not read the date» and «the document is current» are different
    // answers; assuming the second is how an expired licence gets approved.
    expect(isExpired(null)).toBeNull();
    expect(isExpired("غير محدد")).toBeNull();
  });
});

describe("OCR — the comparison table", () => {
  const extraction = (over: Partial<ReturnType<typeof parseExtraction>> = {}) => ({
    companyName: "الخديوي للمقاولات",
    taxRegistration: "111-222-333",
    commercialRegister: "12345",
    activity: "توريد أدوات صحية",
    issuedAt: null,
    expiresAt: null,
    items: [],
    brands: [],
    issuer: null,
    invoiceValue: null,
    unreadable: false,
    confidence: 0.9,
    rawText: null,
    ...over,
  });

  it("confirms a field when ANY readable document carries it", () => {
    const rows = buildComparison({
      declared: {
        name: "الخديوي للمقاولات",
        taxRegistration: "111-222-333",
        commercialRegister: "12345",
        activity: "توريد أدوات صحية",
      },
      documents: [
        { id: 1, label: "السجل التجاري", extraction: extraction({ taxRegistration: null }) },
        { id: 2, label: "البطاقة الضريبية", extraction: extraction({ commercialRegister: null }) },
      ],
    });
    const tax = rows.find((r) => r.key === "taxRegistration")!;
    expect(tax.result).toBe(COMPARE_RESULT.MATCH);
    // The evidence names WHICH file confirmed it — the reviewer must be able to
    // check the reading, not trust the verdict.
    expect(tax.sourceDocumentId).toBe(2);
  });

  it("says «unreadable» (not «not found») when every document failed to read", () => {
    const rows = buildComparison({
      declared: { name: "x", taxRegistration: "1", commercialRegister: "2", activity: "y" },
      documents: [{ id: 1, label: "السجل", extraction: extraction({ unreadable: true }) }],
    });
    expect(rows.every((r) => r.result === COMPARE_RESULT.UNREADABLE)).toBe(true);
  });

  it("says «not in document» when the application has no documents at all", () => {
    const rows = buildComparison({
      declared: { name: "x", taxRegistration: "1", commercialRegister: "2", activity: "y" },
      documents: [],
    });
    expect(rows.every((r) => r.result === COMPARE_RESULT.NOT_IN_DOCUMENT)).toBe(true);
  });
});

describe("OCR — brand evidence", () => {
  it("proves a brand that appears on a document", () => {
    const evidence = buildBrandEvidence(
      ["ADONIS"],
      [
        {
          id: 7,
          label: "فاتورة سابقة",
          extraction: {
            companyName: null,
            taxRegistration: null,
            commercialRegister: null,
            activity: null,
            issuedAt: null,
            expiresAt: null,
            items: ["ADONIS CABLE 3X2.5"],
            brands: [],
            issuer: null,
            invoiceValue: null,
            unreadable: false,
            confidence: 0.8,
            rawText: null,
          },
        },
      ],
    );
    expect(evidence[0].proven).toBe(true);
    expect(evidence[0].sourceDocumentId).toBe(7);
  });

  it("leaves an unproven brand unproven rather than guessing", () => {
    const evidence = buildBrandEvidence(["SIEMENS"], []);
    expect(evidence[0].proven).toBe(false);
    expect(evidence[0].sourceDocumentId).toBeNull();
  });
});

describe("OCR — normalisation", () => {
  it("folds case, punctuation and spacing but NOT digits", () => {
    expect(normalizeForCompare("Cable, 3x2.5  MM")).toBe("cable 3x2 5 mm");
    expect(normalizeForCompare("١١١-٢٢٢")).toContain("١١١");
  });
});
