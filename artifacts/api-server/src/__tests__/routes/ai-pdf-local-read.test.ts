/**
 * Local PDF reading and attachment numbers.
 *
 * Live failure: a request to read the PDF attached to an EDC order ended as
 * «تعذّر معالجة طلبك» — the only document-reading path was Gemini `inline_data`,
 * which is capped at 20 requests/day/model and returns null once the day is
 * spent. A text-layer PDF needs no model at all.
 *
 * The extraction itself is validated against the REAL EDC attachments (both parse
 * correctly in plain Node, which is how the service runs). Here `pdf-parse` is
 * mocked so the test exercises the part we own — `renderPdfPage`, whose
 * column reconstruction is what makes a table row parseable — without depending
 * on pdf.js's font machinery, which is not reproducible under vitest.
 */
import { describe, it, expect, vi } from "vitest";

const fakeParse = vi.fn();
vi.mock("pdf-parse/lib/pdf-parse.js", () => ({ default: fakeParse }));

const { extractPdfText, extractPdfTextDetailed, extractNumbers, DEFAULT_NUMBER_PATTERNS } =
  await import("../../modules/ai-assistant/email");

/** A page whose glyph items sit on baselines, out of x-order. */
function pageData(items: Array<{ str: string; x: number; y: number }>) {
  return {
    getTextContent: async () => ({
      items: items.map((i) => ({ str: i.str, transform: [1, 0, 0, 1, i.x, i.y] })),
    }),
  };
}

describe("renderPdfPage (via extractPdfText)", () => {
  it("rebuilds a table row from glyph x/y, keeping columns separated", async () => {
    // The default renderer concatenates with no separator, so these columns
    // would run together ("11Each5.70243E+") and the row would not parse.
    fakeParse.mockImplementation(async (_buf, opts) => ({
      text: await opts.pagerender(
        pageData([
          { str: "1", x: 30, y: 500 },
          { str: "1", x: 60, y: 500 },
          { str: "Each", x: 90, y: 500 },
          { str: "5702428662864", x: 150, y: 500 },
          // Deliberately out of order: x decides, not array position.
          { str: "Quantity", x: 60, y: 560 },
          { str: "Line", x: 30, y: 560 },
        ]),
      ),
    }));

    const text = await extractPdfText(Buffer.from("x"));
    const rows = text.split("\n");
    // Each visual row on its own baseline, left-to-right within a row.
    expect(rows).toContain("1 1 Each 5702428662864");
    expect(rows).toContain("Line Quantity");
  });

  it("returns empty string when the PDF cannot be parsed", async () => {
    fakeParse.mockRejectedValue(new Error("bad XRef entry"));
    expect(await extractPdfText(Buffer.from("not a pdf"))).toBe("");
  });

  it("returns empty string for a file whose text layer is empty (a scan)", async () => {
    fakeParse.mockResolvedValue({ text: "\n\n   \n" });
    expect(await extractPdfText(Buffer.from("scan"))).toBe("");
  });

  it("counts the PAGES it actually rendered, so progress is evidence not an estimate", async () => {
    // «عدد الصفحات التي تمت معالجتها» — the count must come from the pages the
    // parser rendered. A document whose attachments span several pages is the
    // reason a single-order read felt instant while the year-long census did not.
    fakeParse.mockImplementation(async (_buf, opts) => {
      for (let i = 0; i < 3; i++) {
        await opts.pagerender(pageData([{ str: `page ${i + 1}`, x: 30, y: 500 }]));
      }
      return { text: "p1p2p3" };
    });
    const out = await extractPdfTextDetailed(Buffer.from("pdf"));
    expect(out.pages).toBe(3);
  });

  it("reports zero pages for a file that cannot be parsed, not a bogus count", async () => {
    fakeParse.mockRejectedValue(new Error("bad pdf"));
    const out = await extractPdfTextDetailed(Buffer.from("broken"));
    expect(out.pages).toBe(0);
    expect(out.text).toBe("");
  });
});

describe("extractNumbers on attachment text", () => {
  it("finds an EDC RFQ number inside the document, not just in a subject", () => {
    // Verbatim line from the real 26R011954 attachment.
    const text = "RFQ number: 26R011954\nDate: 23-SEP-26";
    expect(extractNumbers(text, DEFAULT_NUMBER_PATTERNS)).toContain("26R011954");
  });

  it("finds the EDC PO number shape too", () => {
    const numbers = extractNumbers(
      "PURCHASE ORDER PO number: P26E14630(RIG58)",
      DEFAULT_NUMBER_PATTERNS,
    );
    expect(numbers).toContain("P26E14630");
  });

  it("does not turn a document's dates or totals into order numbers", () => {
    const numbers = extractNumbers(
      "Issue Date: 23-SEP-2026 Grand Total 1,026.00",
      DEFAULT_NUMBER_PATTERNS,
    );
    expect(numbers).not.toContain("2026");
  });
});
