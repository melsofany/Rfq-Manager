import ExcelJS from "exceljs";

/** Normalise a cell value from exceljs into a plain primitive. */
function cellToPlain(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (value instanceof Date) return value;
    if ("result" in value) return (value as ExcelJS.CellFormulaValue).result ?? "";
    if ("richText" in value) {
      return (value as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("");
    }
    if ("text" in value) return (value as ExcelJS.CellHyperlinkValue).text;
    if ("error" in value) return "";
  }
  return value;
}

/**
 * Read the first sheet of an .xlsx workbook as header-keyed rows.
 * Empty cells become "", matching the previous sheet_to_json defval behaviour.
 */
export async function readXlsxRows(buffer: ArrayBuffer): Promise<Record<string, unknown>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber - 1] = String(cellToPlain(cell.value) ?? "").trim();
  });

  const rows: Record<string, unknown>[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const obj: Record<string, unknown> = {};
    let hasValue = false;
    headers.forEach((h, idx) => {
      if (!h) return;
      const v = cellToPlain(row.getCell(idx + 1).value);
      if (v !== "") hasValue = true;
      obj[h] = v;
    });
    if (hasValue) rows.push(obj);
  }
  return rows;
}

/** Parse RFC 4180 CSV text (quoted fields, escaped quotes, CRLF or LF) into header-keyed rows. */
export function parseCsvRows(text: string): Record<string, unknown>[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  if (records.length === 0) return [];
  const headers = records[0].map((h) => h.trim());
  return records
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => {
      const obj: Record<string, unknown> = {};
      headers.forEach((h, idx) => {
        if (h) obj[h] = r[idx] ?? "";
      });
      return obj;
    });
}

export interface SheetSpec {
  sheetName: string;
  rows: unknown[][];
  columnWidths?: number[];
  /** 1-based row indices to render bold (headers / titles). */
  boldRows?: number[];
  /** Cell ranges to merge, e.g. "A1:M1". */
  merges?: string[];
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** Build and download an .xlsx workbook from one or more sheets of raw rows. */
export async function downloadXlsx(fileName: string, sheets: SheetSpec[]) {
  const wb = new ExcelJS.Workbook();
  for (const spec of sheets) {
    const ws = wb.addWorksheet(spec.sheetName);
    spec.rows.forEach((row) => {
      ws.addRow(row.map((v) => (v === undefined ? null : v)));
    });
    if (spec.columnWidths) {
      ws.columns = spec.columnWidths.map((w) => ({ width: w }));
    }
    (spec.boldRows ?? []).forEach((r) => {
      ws.getRow(r).font = { bold: true };
    });
    (spec.merges ?? []).forEach((range) => ws.mergeCells(range));
  }
  const buffer = await wb.xlsx.writeBuffer();
  triggerDownload(
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    fileName,
  );
}

/** Serialise rows to CSV text, quoting fields that contain separators, quotes or newlines. */
export function toCsv(rows: unknown[][]): string {
  return rows
    .map((row) =>
      row
        .map((v) => {
          const s = v === null || v === undefined ? "" : String(v);
          return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    )
    .join("\r\n");
}

/** Download rows as a UTF-8 (with BOM, so Excel shows Arabic correctly) CSV file. */
export function downloadCsv(fileName: string, rows: unknown[][]) {
  triggerDownload(
    new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8;" }),
    fileName,
  );
}
