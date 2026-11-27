import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseCsvRows, readXlsxRows, toCsv } from "@/lib/spreadsheet";

describe("parseCsvRows", () => {
  it("parses headers and rows with quoted commas, escaped quotes and CRLF", () => {
    const text = '﻿name,phone,note\r\n"شركة, المثال",0100,"قال ""مرحبا"""\r\nثاني,0111,\r\n';
    expect(parseCsvRows(text)).toEqual([
      { name: "شركة, المثال", phone: "0100", note: 'قال "مرحبا"' },
      { name: "ثاني", phone: "0111", note: "" },
    ]);
  });

  it("skips blank lines and returns [] for empty input", () => {
    expect(parseCsvRows("")).toEqual([]);
    expect(parseCsvRows("a,b\n\n1,2\n,\n")).toEqual([{ a: "1", b: "2" }]);
  });
});

describe("toCsv", () => {
  it("quotes fields containing separators, quotes or newlines", () => {
    const csv = toCsv([["h1", "h2"], ["a,b", 'say "hi"'], ["x\ny", 3]]);
    expect(csv).toBe('h1,h2\r\n"a,b","say ""hi"""\r\n"x\ny",3');
  });

  it("round-trips through parseCsvRows", () => {
    const rows = [["name", "note"], ["شركة، تجربة", 'a "quoted", value']];
    expect(parseCsvRows(toCsv(rows))).toEqual([{ name: "شركة، تجربة", note: 'a "quoted", value' }]);
  });
});

describe("readXlsxRows", () => {
  it("reads the first sheet as header-keyed rows with empty cells as empty strings", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Suppliers");
    ws.addRow(["name", "supplier_id", "email"]);
    ws.addRow(["شركة المثال", "SUP-001", "a@example.com"]);
    ws.addRow(["مؤسسة", null, null]);
    const buffer = (await wb.xlsx.writeBuffer()) as ArrayBuffer;

    const rows = await readXlsxRows(buffer);
    expect(rows).toEqual([
      { name: "شركة المثال", supplier_id: "SUP-001", email: "a@example.com" },
      { name: "مؤسسة", supplier_id: "", email: "" },
    ]);
  });
});
