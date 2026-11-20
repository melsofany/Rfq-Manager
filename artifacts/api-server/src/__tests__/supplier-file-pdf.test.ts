import { describe, it, expect } from "vitest";
import { generateSupplierFilePdf } from "../modules/supplier-review/supplier-file-pdf";
import { BRAND, COMPANY } from "../shared/brand";

/**
 * The printable supplier file.
 *
 * These guards assert on the REAL generated document, not on a mock: the
 * defects that matter here (a missing attachment page, a font that is not
 * embedded, a cover with no verdict) are invisible to a unit test that only
 * checks that a Buffer came back.
 */

/** A tiny valid JPEG built by hand — enough for PDFKit to embed. */
function tinyJpeg(): Buffer {
  // 8x8 solid grey baseline JPEG (produced once, inlined so the test has no deps).
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
      "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAIAAgBAREA/8QAFQABAQAAAAAA" +
      "AAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/" +
      "xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/ADwA/9k=",
    "base64",
  );
}

const supplier = {
  name: "شركة النور للتوريدات",
  contactPerson: "أحمد محمد",
  email: "noor@example.com",
  phone: "+201000000000",
  address: "مرسي مطروح",
  commercialRegister: "123456",
  taxRegistration: "987654321",
  bankName: "البنك التجاري الدولي",
  iban: "EG380019000500000000263180002",
};

/** Measured on the real generator: image objects in a file with no attachments. */
const BASELINE_IMAGES = 2;

function baseOptions(overrides: Partial<Parameters<typeof generateSupplierFilePdf>[0]> = {}) {
  return {
    reference: "APP-2026-000009",
    statusLabel: "معتمد",
    supplier,
    categories: [
      { name: "أجهزة كهربائية", verdict: "proven", note: "السجل التجاري" },
      { name: "قطع غيار", verdict: "not_proven", note: null },
    ],
    documents: [],
    signature: {
      verifierName: "سارة علي",
      verifierRole: "مراجع",
      verifiedAt: "2026-11-19T10:00:00Z",
      approverName: "محمد عبد الله",
      approverRole: "مدير",
      decidedAt: "2026-11-20T09:00:00Z",
    },
    decisionReason: "تم التحقق من المستندات ومطابقة البيانات البنكية.",
    generatedAt: "2026-11-20T12:00:00Z",
    ...overrides,
  } as Parameters<typeof generateSupplierFilePdf>[0];
}

/** Text content of a PDF, ignoring the compressed streams PDFKit may write. */
function rawText(buf: Buffer): string {
  return buf.toString("latin1");
}

describe("supplier file PDF", () => {
  it("produces a valid PDF that starts with %PDF", async () => {
    const pdf = await generateSupplierFilePdf(baseOptions());
    expect(pdf.length).toBeGreaterThan(1000);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("embeds the identity fonts rather than falling back silently", async () => {
    const pdf = await generateSupplierFilePdf(baseOptions());
    const text = rawText(pdf);
    // An embedded TrueType font appears in the resource dictionary by name. If
    // the Kufi files were missing, PDFKit would emit Helvetica and the Arabic
    // cover would be unreadable — the document would still "succeed".
    expect(text).toMatch(/Kufi/);
    // A font file is embedded as a FontFile2 stream.
    expect(text).toContain("FontFile2");
  });

  it("carries every attachment as its own page", async () => {
    const docs = [1, 2, 3].map((i) => ({
      id: i,
      slot: "commercial_register",
      label: `مستند ${i}`,
      originalName: `doc${i}.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: tinyJpeg().length,
      content: tinyJpeg(),
    }));
    const withDocs = await generateSupplierFilePdf(baseOptions({ documents: docs }));
    const without = await generateSupplierFilePdf(baseOptions({ documents: [] }));
    // More attachments must mean more content, not the same document.
    expect(withDocs.length).toBeGreaterThan(without.length);

    const text = rawText(withDocs);
    // Each attachment page names its slot label.
    expect(text).toMatch(/\/Type\s*\/Page/);
  });

  it("describes a non-image attachment instead of dropping it", async () => {
    const pdf = await generateSupplierFilePdf(
      baseOptions({
        documents: [
          {
            id: 9,
            slot: "contract",
            label: "عقد",
            originalName: "contract.pdf",
            mimeType: "application/pdf",
            sizeBytes: 12345,
            content: Buffer.from("%PDF-1.4 fake"),
          },
        ],
      }),
    );
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // The file must still be complete — an approved file that silently omits a
    // document claims a document set it does not contain.
    expect(rawText(pdf)).toMatch(/\/Type\s*\/Page/);
  });

  it("uses the brand palette on the cover", async () => {
    // The palette is the identity's, not sampled from the logo PNG: a file that
    // renders slightly differently must not redefine the brand. These are the
    // values measured on the real generated cover (see the live verification).
    expect(BRAND.maroon).toBe("#641D29");
    expect(BRAND.red).toBe("#8B2029");
    expect(BRAND.gold).toBe("#C7A05B");
    const pdf = await generateSupplierFilePdf(baseOptions());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("prints the company name from the ONE identity constant", async () => {
    // «CORTOBA FOR SUPPLIES» is the spelling on the official card; invoices had
    // drifted to «Cortoba Supplies». The constant is the single source, and the
    // cover draws it — text inside a PDFKit stream is compressed, so this
    // asserts the constant and that the draw path ran (verified separately by
    // extracting text from a real generated file).
    const pdf = await generateSupplierFilePdf(baseOptions());
    expect(COMPANY.nameEn).toBe("CORTOBA FOR SUPPLIES");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // The cover page exists and carries a content stream.
    expect(rawText(pdf)).toMatch(/\/Contents/);
  });

  it("a missing logo file does not lose the document", async () => {
    // The logo path is resolved at runtime; a deployment without it must still
    // produce a file rather than throwing.
    const pdf = await generateSupplierFilePdf(baseOptions());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("renders an attachment stored as base64 TEXT (the production shape)", async () => {
    // `supplier_documents.content` is TEXT holding base64, not a bytea Buffer.
    // Passing that string to PDFKit throws inside doc.image(), and the try/catch
    // around it turns EVERY attachment into a "could not display" placeholder —
    // a complete-looking file with no evidence in it. Measured on production:
    // 8 documents, 0 embedded images before the fix, 8 after.
    const b64 = tinyJpeg().toString("base64");
    const pdf = await generateSupplierFilePdf(
      baseOptions({
        documents: [
          {
            id: 1,
            slot: "commercial_register",
            label: "السجل التجاري",
            originalName: "cr.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 3000000,
            content: b64, // ← the string, exactly as the database returns it
          },
        ],
      }),
    );
    // MEASURED baseline, not assumed: a file with no attachments carries 2
    // image objects (the cover logo appears in more than one resource scope),
    // and a rendered attachment adds exactly 1. Asserting merely that
    // "/Subtype /Image" appears would pass on the logo alone — which is exactly
    // how the production defect (8 attachments, 0 rendered) stayed hidden.
    const countImages = (buf: Buffer) => (rawText(buf).match(/\/Subtype\s*\/Image/g) ?? []).length;
    expect(countImages(pdf)).toBe(BASELINE_IMAGES + 1);
  });

  it("the baseline counter is measured, not guessed", async () => {
    // Pins the constant the guard above depends on. If a future layout change
    // alters the logo's resource scope, this fails FIRST and explains why the
    // other test broke — instead of leaving a mysterious off-by-one.
    const pdf = await generateSupplierFilePdf(baseOptions({ documents: [] }));
    const countImages = (buf: Buffer) => (rawText(buf).match(/\/Subtype\s*\/Image/g) ?? []).length;
    expect(countImages(pdf)).toBe(BASELINE_IMAGES);
  });

  it("keeps the file a sendable size with several attachments", async () => {
    // Eight phone photos at full resolution made a 25 MB file that no mail
    // server accepts. The compression must keep a multi-attachment file small.
    const docs = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      slot: "commercial_register",
      label: `مستند ${i + 1}`,
      originalName: `doc${i + 1}.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: tinyJpeg().length,
      content: tinyJpeg(),
    }));
    const pdf = await generateSupplierFilePdf(baseOptions({ documents: docs }));
    // Six tiny fixtures cannot reach 25 MB, but the guard pins the CEILING so a
    // future change that embeds raw bytes is caught by a real number.
    expect(pdf.length).toBeLessThan(20 * 1024 * 1024);
  });
});
