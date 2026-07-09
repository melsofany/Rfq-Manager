import { google } from "googleapis";
import { logger } from "./logger";

function getAuth(readonly = true) {
  const base64 = process.env.GOOGLE_ACCOUNT_BASE_64;
  if (!base64) throw new Error("GOOGLE_ACCOUNT_BASE_64 not set");

  const json = Buffer.from(base64, "base64").toString("utf-8");
  const credentials = JSON.parse(json);

  return new google.auth.GoogleAuth({
    credentials,
    scopes: readonly
      ? ["https://www.googleapis.com/auth/spreadsheets.readonly"]
      : ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

export interface SheetRfqItem {
  itemId: string | null;
  lineItem: string | null;
  partNo: string | null;
  description: string;
  uom: string | null;
  qty: number | null;
  referencePrice: number | null;
  rfqNo: string;
  rfqDate: string;
  requiredResponseDate: string;
}

/**
 * Look up RFQ items from Google Sheets by customer RFQ number.
 *
 * Actual sheet columns (row 1 = headers, data from row 2):
 *   A: Item ID      B: UOM          C: Line Item
 *   D: Part No      E: Description  F: RFQ No (customer RFQ)
 *   G: Date/RFQ     H: QTY          I: Price/RFQ
 *   J: Res. Date
 *
 * Rows where column F matches customerRfqNo are returned.
 */
export async function lookupRfqFromSheet(
  customerRfqNo: string,
  sheetName = "DATA"
): Promise<SheetRfqItem[]> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID not set");

  const auth = getAuth(true);
  const sheets = google.sheets({ version: "v4", auth });

  const range = `${sheetName}!A2:J`;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });

  const rows = response.data.values ?? [];
  logger.info({ total: rows.length, customerRfqNo }, "Google Sheets rows fetched");

  const matched = rows.filter((row) => {
    const cellRfqNo = String(row[5] ?? "").trim();
    return cellRfqNo === customerRfqNo.trim();
  });

  if (matched.length === 0) return [];

  return matched.map((row) => ({
    itemId: String(row[0] ?? "").trim() || null,
    uom: String(row[1] ?? "").trim() || null,
    lineItem: String(row[2] ?? "").trim() || null,
    partNo: String(row[3] ?? "").trim() || null,
    description: String(row[4] ?? "").trim() || "(no description)",
    rfqNo: String(row[5] ?? "").trim(),
    rfqDate: String(row[6] ?? "").trim(),
    qty: row[7] != null && row[7] !== "" ? parseFloat(String(row[7])) : null,
    referencePrice: row[8] != null && row[8] !== "" ? parseFloat(String(row[8])) : null,
    requiredResponseDate: String(row[9] ?? "").trim(),
  }));
}

/**
 * List all unique RFQ numbers in the sheet (column F = RFQ No, excluding header).
 */
export async function listSheetRfqNumbers(sheetName = "DATA"): Promise<string[]> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID not set");

  const auth = getAuth(true);
  const sheets = google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!F2:F`,
  });

  const rows = response.data.values ?? [];
  const unique = [...new Set(rows.map((r) => String(r[0] ?? "").trim()).filter(Boolean))];
  return unique.sort();
}

export interface SheetPoItem {
  itemId: string | null;
  lineItem: string | null;
  partNo: string | null;
  description: string;
  uom: string | null;
  qty: number | null;
  referencePrice: number | null;
  poNo: string;
}

/**
 * Look up purchase order items from Google Sheets by purchase order number.
 *
 * Same DATA sheet as RFQ lookup, but items are matched on column K
 * (purchase order number) and quantity is read from column M
 * (the PO quantity), not column H (the RFQ quantity):
 *   A: Item ID      B: UOM          C: Line Item
 *   D: Part No      E: Description  F: RFQ No
 *   G: Date/RFQ     H: QTY (RFQ)    I: Price/RFQ
 *   J: Res. Date     K: PO No        L: (unused)
 *   M: QTY (PO)
 *
 * Rows where column K matches poNo are returned.
 */
export async function lookupPoFromSheet(
  poNo: string,
  sheetName = "DATA"
): Promise<SheetPoItem[]> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID not set");

  const auth = getAuth(true);
  const sheets = google.sheets({ version: "v4", auth });

  const range = `${sheetName}!A2:M`;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });

  const rows = response.data.values ?? [];
  logger.info({ total: rows.length, poNo }, "Google Sheets rows fetched (PO lookup)");

  const matched = rows.filter((row) => {
    const cellPoNo = String(row[10] ?? "").trim();
    return cellPoNo === poNo.trim();
  });

  if (matched.length === 0) return [];

  return matched.map((row) => ({
    itemId: String(row[0] ?? "").trim() || null,
    uom: String(row[1] ?? "").trim() || null,
    lineItem: String(row[2] ?? "").trim() || null,
    partNo: String(row[3] ?? "").trim() || null,
    description: String(row[4] ?? "").trim() || "(no description)",
    poNo: String(row[10] ?? "").trim(),
    qty: row[12] != null && row[12] !== "" ? parseFloat(String(row[12])) : null,
    referencePrice: row[8] != null && row[8] !== "" ? parseFloat(String(row[8])) : null,
  }));
}

/**
 * List all unique purchase order numbers in the sheet (column K, excluding header).
 */
export async function listSheetPoNumbers(sheetName = "DATA"): Promise<string[]> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID not set");

  const auth = getAuth(true);
  const sheets = google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!K2:K`,
  });

  const rows = response.data.values ?? [];
  const unique = [...new Set(rows.map((r) => String(r[0] ?? "").trim()).filter(Boolean))];
  return unique.sort();
}

/**
 * Get the list of sheet tab names in the spreadsheet.
 */
export async function listSheetTabs(): Promise<string[]> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID not set");

  const auth = getAuth(true);
  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  return (meta.data.sheets ?? []).map((s) => s.properties?.title ?? "");
}

// ─── Mirror Sheet (bidirectional sync) ────────────────────────────────────────

function getMirrorSheetId(): string {
  const id = process.env.GOOGLE_MIRROR_SHEET_ID;
  if (!id) throw new Error("GOOGLE_MIRROR_SHEET_ID not set");
  return id;
}

const TAB_RFQS = "RFQs";
const TAB_ITEMS = "Items";
const TAB_SUPPLIERS = "Suppliers";
const TAB_OFFERS = "Supplier Offers";

const RFQS_HEADER = ["ID", "Internal RFQ No", "Customer RFQ No", "Customer RFQ Date", "Required Response Date", "Status", "Notes", "Expires At", "Created At"];
const ITEMS_HEADER = ["ID", "RFQ ID", "Internal RFQ No", "Line Item", "Part No", "Description", "QTY", "UOM", "Reference Price", "Created At"];
const SUPPLIERS_HEADER = ["ID", "Supplier ID", "Name", "Contact Person", "Email", "Phone", "Category", "Active", "Created At"];
const OFFERS_HEADER = ["ID", "Offer ID", "RFQ ID", "Internal RFQ No", "Customer RFQ No", "Supplier Name", "Line Item", "Part No", "Description", "QTY", "UOM", "Unit Price", "Tax Included", "Delivery Days", "Notes", "Submitted At"];

async function ensureTab(sheets: ReturnType<typeof google.sheets>, spreadsheetId: string, title: string): Promise<void> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }],
      },
    });
  }
}

async function clearAndWriteTab(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tabName: string,
  header: string[],
  rows: (string | number | boolean | null)[][]
): Promise<void> {
  await ensureTab(sheets, spreadsheetId, tabName);
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: tabName });
  const values = [header, ...rows];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values },
  });
}

export interface MirrorData {
  rfqs: Array<{
    id: number; internalRfqNo: string; customerRfqNo: string;
    customerRfqDate: string | null; requiredResponseDate: string | null;
    status: string; notes: string | null; expiresAt: Date | null; createdAt: Date;
  }>;
  items: Array<{
    id: number; rfqId: number; internalRfqNo: string;
    lineItem: string | null; partNo: string | null; description: string;
    qty: string | null; uom: string | null; referencePrice: string | null; createdAt: Date;
  }>;
  suppliers: Array<{
    id: number; supplierId: string | null; name: string; contactPerson: string | null;
    email: string | null; phone: string | null; category: string; isActive: boolean; createdAt: Date;
  }>;
  offerItems: Array<{
    id: number; offerId: number; rfqId: number; internalRfqNo: string; customerRfqNo: string;
    supplierName: string; lineItem: string | null; partNo: string | null; description: string;
    qty: string | null; uom: string | null; price: string;
    taxIncluded: boolean; deliveryDays: number | null; notes: string | null; submittedAt: Date;
  }>;
}

/** Push all DB data to the mirror sheet (overwrites each tab). */
export async function pushToMirrorSheet(data: MirrorData): Promise<void> {
  const spreadsheetId = getMirrorSheetId();
  const auth = getAuth(false);
  const sheets = google.sheets({ version: "v4", auth });

  const rfqRows = data.rfqs.map((r) => [
    r.id, r.internalRfqNo, r.customerRfqNo,
    r.customerRfqDate ?? "", r.requiredResponseDate ?? "",
    r.status, r.notes ?? "",
    r.expiresAt ? r.expiresAt.toISOString() : "",
    r.createdAt.toISOString(),
  ]);

  const itemRows = data.items.map((i) => [
    i.id, i.rfqId, i.internalRfqNo,
    i.lineItem ?? "", i.partNo ?? "", i.description,
    i.qty ?? "", i.uom ?? "", i.referencePrice ?? "",
    i.createdAt.toISOString(),
  ]);

  const supplierRows = data.suppliers.map((s) => [
    s.id, s.supplierId ?? "", s.name, s.contactPerson ?? "",
    s.email ?? "", s.phone ?? "", s.category,
    s.isActive ? "Yes" : "No",
    s.createdAt.toISOString(),
  ]);

  const offerItemRows = data.offerItems.map((o) => [
    o.id, o.offerId, o.rfqId, o.internalRfqNo, o.customerRfqNo,
    o.supplierName, o.lineItem ?? "", o.partNo ?? "", o.description,
    o.qty ?? "", o.uom ?? "", o.price,
    o.taxIncluded ? "Yes" : "No",
    o.deliveryDays ?? "", o.notes ?? "",
    o.submittedAt.toISOString(),
  ]);

  await clearAndWriteTab(sheets, spreadsheetId, TAB_RFQS, RFQS_HEADER, rfqRows);
  await clearAndWriteTab(sheets, spreadsheetId, TAB_ITEMS, ITEMS_HEADER, itemRows);
  await clearAndWriteTab(sheets, spreadsheetId, TAB_SUPPLIERS, SUPPLIERS_HEADER, supplierRows);
  await clearAndWriteTab(sheets, spreadsheetId, TAB_OFFERS, OFFERS_HEADER, offerItemRows);

  logger.info(
    { rfqs: rfqRows.length, items: itemRows.length, suppliers: supplierRows.length, offerItems: offerItemRows.length },
    "Mirror sheet updated"
  );
}

export interface SheetIds {
  rfqIds: number[];
  itemIds: number[];
  supplierIds: number[];
}

/** Read the ID column (col A) from all mirror tabs. */
export async function readMirrorSheetIds(): Promise<SheetIds> {
  const spreadsheetId = getMirrorSheetId();
  const auth = getAuth(false);
  const sheets = google.sheets({ version: "v4", auth });

  async function readIds(tab: string): Promise<number[]> {
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${tab}!A2:A`,
      });
      return (res.data.values ?? [])
        .map((r) => parseInt(String(r[0] ?? ""), 10))
        .filter((n) => !isNaN(n) && n > 0);
    } catch {
      return [];
    }
  }

  const [rfqIds, itemIds, supplierIds] = await Promise.all([
    readIds(TAB_RFQS),
    readIds(TAB_ITEMS),
    readIds(TAB_SUPPLIERS),
  ]);

  return { rfqIds, itemIds, supplierIds };
}
