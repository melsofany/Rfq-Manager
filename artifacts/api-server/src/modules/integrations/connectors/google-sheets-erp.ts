/**
 * Google Sheets ERP Connector
 * يُرسل بيانات الموردين والـ RFQs والعروض إلى جداول بيانات Google
 * ويقرأ الموردين والـ RFQs من الـ Sheet كمصدر بيانات ERP
 */

import { google } from "googleapis";
import { logger } from "../../../shared/logger";

export interface GoogleSheetsErpConfig {
  serviceAccountBase64: string; // GOOGLE_ACCOUNT_BASE_64
  spreadsheetId: string; // GOOGLE_SHEET_ID أو Mirror Sheet
  dataSheetName?: string; // اسم تاب البيانات (افتراضي: DATA)
}

export interface ErpSupplier {
  externalId: string;
  name: string;
  contactPerson?: string;
  email?: string;
  phone?: string;
  address?: string;
  category?: string;
}

function getAuth(cfg: GoogleSheetsErpConfig) {
  const json = Buffer.from(cfg.serviceAccountBase64, "base64").toString("utf-8");
  const credentials = JSON.parse(json);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

export async function testConnection(
  cfg: GoogleSheetsErpConfig,
): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const auth = getAuth(cfg);
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.get({ spreadsheetId: cfg.spreadsheetId });
    return {
      ok: true,
      version: `Google Sheets: ${res.data.properties?.title ?? cfg.spreadsheetId}`,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** قراءة الموردين من Sheet (عمود A: الاسم، B: الإيميل، C: الهاتف، D: الفئة) */
export async function importSuppliers(cfg: GoogleSheetsErpConfig): Promise<ErpSupplier[]> {
  const sheetName = cfg.dataSheetName ?? "Suppliers";
  const auth = getAuth(cfg);
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: cfg.spreadsheetId,
    range: `${sheetName}!A2:F`,
  });

  const rows = res.data.values ?? [];
  logger.info({ count: rows.length }, "Google Sheets ERP: suppliers fetched");

  return rows
    .filter((r) => r[0] && String(r[0]).trim())
    .map((r, i) => ({
      externalId: `gsheets-supplier-${i + 2}`,
      name: String(r[0] ?? "").trim(),
      contactPerson: r[1] ? String(r[1]).trim() : undefined,
      email: r[2] ? String(r[2]).trim() : undefined,
      phone: r[3] ? String(r[3]).trim() : undefined,
      address: r[4] ? String(r[4]).trim() : undefined,
      category: r[5] ? String(r[5]).trim() : undefined,
    }));
}

/** كتابة الموردين في Sheet */
export async function exportSuppliers(
  cfg: GoogleSheetsErpConfig,
  suppliers: {
    name: string;
    email?: string;
    phone?: string;
    address?: string;
    category?: string;
    rating?: number;
  }[],
): Promise<void> {
  const sheetName = "ERP_Suppliers";
  const auth = getAuth(cfg);
  const sheets = google.sheets({ version: "v4", auth });

  // التأكد من وجود التاب
  const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.spreadsheetId });
  const tabExists = meta.data.sheets?.some((s) => s.properties?.title === sheetName);

  if (!tabExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: cfg.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
  }

  const rows: (string | number)[][] = [
    ["اسم المورد", "البريد الإلكتروني", "الهاتف", "العنوان", "الفئة", "التقييم", "آخر تحديث"],
    ...suppliers.map((s) => [
      s.name,
      s.email ?? "",
      s.phone ?? "",
      s.address ?? "",
      s.category ?? "",
      s.rating ?? "",
      new Date().toISOString().split("T")[0],
    ]),
  ];

  await sheets.spreadsheets.values.clear({
    spreadsheetId: cfg.spreadsheetId,
    range: `${sheetName}!A:G`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: cfg.spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });

  logger.info(
    { count: suppliers.length, tab: sheetName },
    "ERP Suppliers exported to Google Sheets",
  );
}

/** تصدير طلبات عروض الأسعار للـ Sheet */
export async function exportRfqs(
  cfg: GoogleSheetsErpConfig,
  rfqs: {
    internalRfqNo: string;
    customerRfqNo: string;
    status: string;
    supplierCount: number;
    offerCount: number;
    createdAt: string;
  }[],
): Promise<void> {
  const sheetName = "ERP_RFQs";
  const auth = getAuth(cfg);
  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.spreadsheetId });
  const tabExists = meta.data.sheets?.some((s) => s.properties?.title === sheetName);
  if (!tabExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: cfg.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
  }

  const rows = [
    ["رقم الطلب الداخلي", "رقم طلب العميل", "الحالة", "الموردون", "العروض", "تاريخ الإنشاء"],
    ...rfqs.map((r) => [
      r.internalRfqNo,
      r.customerRfqNo,
      r.status,
      r.supplierCount,
      r.offerCount,
      r.createdAt,
    ]),
  ];

  await sheets.spreadsheets.values.clear({
    spreadsheetId: cfg.spreadsheetId,
    range: `${sheetName}!A:F`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: cfg.spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
}

/** تصدير أوامر الشراء */
export async function exportPurchaseOrders(
  cfg: GoogleSheetsErpConfig,
  pos: {
    internalPoNo: string;
    sheetPoNo: string;
    supplierName?: string;
    status: string;
    itemCount: number;
    createdAt: string;
  }[],
): Promise<void> {
  const sheetName = "ERP_PurchaseOrders";
  const auth = getAuth(cfg);
  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.spreadsheetId });
  const tabExists = meta.data.sheets?.some((s) => s.properties?.title === sheetName);
  if (!tabExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: cfg.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
  }

  const rows = [
    ["رقم الأمر الداخلي", "رقم أمر الشراء", "المورد", "الحالة", "عدد البنود", "تاريخ الإنشاء"],
    ...pos.map((p) => [
      p.internalPoNo,
      p.sheetPoNo,
      p.supplierName ?? "",
      p.status,
      p.itemCount,
      p.createdAt,
    ]),
  ];

  await sheets.spreadsheets.values.clear({
    spreadsheetId: cfg.spreadsheetId,
    range: `${sheetName}!A:F`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: cfg.spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
}
