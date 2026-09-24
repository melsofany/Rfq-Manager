/**
 * PDF table pagination.
 *
 * The operator's census report spans many pages. The table used a fixed row
 * height and a single header, so continuation pages carried no column headings
 * and a long description was cut off — the report could not be read page by
 * page. This renders a real multi-page document through pdfkit and pins both.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { generateAssistantPdf } from "../../modules/ai-assistant/pdf";

describe("generateAssistantPdf pagination", () => {
  it("spans multiple pages for a long table instead of overflowing one", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => [
      i + 1,
      `ITEM ${i + 1}`,
      "1531.032.GENRAL.7538",
      i + 1,
      (i + 1) * 10,
    ]);
    const buf = await generateAssistantPdf({
      title: "T",
      sections: [{ table: { columns: ["n", "desc", "line item", "orders", "qty"], rows } }],
    });
    const raw = buf.toString("latin1");
    const pages = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;
    expect(pages).toBeGreaterThan(1);
    expect(pages).toBeLessThan(60);
  });

  it("re-draws the column header on each new page and never clips a cell", () => {
    // The continuation pages carried no header, so the columns could not be
    // identified on them, and `lineBreak:false` cut a long description at the
    // cell edge. Both are structural, so they are pinned at the source.
    const src = readFileSync(new URL("../../modules/ai-assistant/pdf.ts", import.meta.url), "utf8");
    const renderer = src.slice(src.indexOf("function renderTable"));
    // The header is a function called before the first row and after each break.
    expect(renderer).toContain("drawHeaderRow");
    expect(renderer).toMatch(/addPage\(\);\s*drawHeaderRow\(\)/);
    // Rows size to their tallest cell so a wrapped description is not cut.
    expect(renderer).toContain("heightOfString");
    // The header is a fixed-height bar (its `lineBreak:false` is fine), so the
    // no-clip rule is asserted on the DATA-cell draw only. pdfkit CLIPS text
    // taller than the `height` it is given, so passing one there cut the last
    // line off a wrapped description («التوصيف مقصوص» — the live defect).
    const drawCall = renderer.slice(renderer.indexOf("doc.text(cell(v)"));
    const dataCell = drawCall.slice(0, drawCall.indexOf("});"));
    expect(dataCell).not.toMatch(/\bheight\s*:/);
    expect(dataCell).not.toContain("lineBreak");
  });
});
