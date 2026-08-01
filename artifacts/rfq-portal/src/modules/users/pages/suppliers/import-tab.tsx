import { useCallback, useRef, useState } from "react";
import { read as xlsxRead, utils as xlsxUtils } from "xlsx";
import { useQueryClient } from "@tanstack/react-query";
import {
  useBulkImportSuppliers,
  useListCategories,
  getListCategoriesQueryKey,
  getListSuppliersQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronDown,
  Loader2,
  RotateCcw,
  Download,
  PhoneOff,
  Phone,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ParsedSupplier {
  _rowIndex: number;
  name: string;
  supplierId?: string;
  contactPerson?: string;
  email?: string;
  phone?: string;       // الرقم الأول (بتنسيق واتساب)
  phone2?: string;      // الرقم الثاني إن وُجد (بتنسيق واتساب)
  address?: string;
  category: string;
  phoneWarning?: string; // تحذير: أرضي مرفوض أو تنسيق غير معروف
}

// ─── Phone normalization helpers ─────────────────────────────────────────────

/**
 * بادئات المحمول المصرية (بعد حذف الصفر البادئ):
 * 10 = فودافون | 11 = اتصالات (e&) | 12 = أورنج | 15 = WE
 */
const EGYPT_MOBILE_PREFIXES = ["10", "11", "12", "15"];

/**
 * يحوّل رقم هاتف مصري (بأي تنسيق) إلى تنسيق واتساب الدولي (+20XXXXXXXXXX).
 * يُرجع null إذا كان الرقم أرضياً أو غير صالح.
 */
function normalizeEgyptianMobile(raw: string): string | null {
  // إزالة المسافات والرموز والحروف غير الرقمية ماعدا + في البداية
  let digits = raw.replace(/[^\d+]/g, "").replace(/\s/g, "");
  // إزالة + للمعالجة ثم إعادتها لاحقاً
  digits = digits.replace(/^\+/, "");
  // 0020... -> اقطع 00
  if (digits.startsWith("0020")) digits = digits.slice(2);
  // 00201... -> اقطع 00
  if (digits.startsWith("00")) digits = digits.slice(2);

  // الحالات الممكنة بعد التنظيف:
  // 01XXXXXXXXX  (11 رقم - تنسيق محلي)
  // 201XXXXXXXXX (12 رقم - مع كود الدولة)
  // 1XXXXXXXXX   (10 أرقام - بدون صفر ومن غير كود دولة)

  if (digits.length === 11 && digits.startsWith("0")) {
    // تحويل 0XXXXXXXXXX -> 20XXXXXXXXXX
    digits = "20" + digits.slice(1);
  } else if (digits.length === 10 && (digits.startsWith("1"))) {
    // تحويل 1XXXXXXXXX -> 201XXXXXXXXX (لو بدأ بـ 1x)
    digits = "20" + digits;
  }

  // الآن يجب أن يكون 12 رقم ويبدأ بـ 20
  if (digits.length !== 12) return null;
  if (!digits.startsWith("20")) return null;

  // الجزء المحلي (بعد 20)
  const local = digits.slice(2); // 10 أرقام
  const prefix = local.slice(0, 2); // e.g. "10", "11", "12", "15"

  if (!EGYPT_MOBILE_PREFIXES.includes(prefix)) {
    // رقم أرضي أو غير معروف
    return null;
  }

  return "+" + digits; // e.g. +201012345678
}

/**
 * يكتشف ما إذا كان الرقم يبدو كرقم أرضي مصري
 */
function looksLikeLandline(raw: string): boolean {
  let digits = raw.replace(/[^\d]/g, "");
  if (digits.startsWith("0020")) digits = digits.slice(2);
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  if (digits.startsWith("20")) digits = digits.slice(2);
  // أرقام أرضية مصرية تبدأ بـ 2 (القاهرة/الجيزة) أو 3 (الإسكندرية) أو 4X-6X
  const landlinePrefixes = ["2", "3", "40", "45", "46", "47", "48", "50", "55", "57",
    "62", "64", "65", "66", "68", "69"];
  return landlinePrefixes.some((p) => digits.startsWith(p));
}

interface PhoneParseResult {
  primary: string | null;   // الرقم الأساسي بتنسيق واتساب
  secondary: string | null; // الرقم الثاني (إن وُجد)
  warning: string | null;   // رسالة تحذير
}

/**
 * يحلل حقل الهاتف الذي قد يحتوي على رقم واحد أو رقمين.
 * يدعم الفاصل: / أو , أو ; أو | أو مسافة أو سطر جديد
 */
function parsePhoneField(raw: string): PhoneParseResult {
  if (!raw || !raw.trim()) return { primary: null, secondary: null, warning: null };

  // تقسيم على الفواصل الشائعة
  const parts = raw
    .split(/[,\/\\|;،\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const mobiles: string[] = [];
  let landlineCount = 0;
  let unknownCount = 0;

  for (const part of parts) {
    if (!part) continue;
    const normalized = normalizeEgyptianMobile(part);
    if (normalized) {
      if (!mobiles.includes(normalized)) {
        mobiles.push(normalized);
      }
    } else {
      const digitsOnly = part.replace(/\D/g, "");
      if (digitsOnly.length >= 7) {
        if (looksLikeLandline(part)) {
          landlineCount++;
        } else {
          unknownCount++;
        }
      }
    }
  }

  const primary = mobiles[0] ?? null;
  const secondary = mobiles[1] ?? null;

  let warning: string | null = null;
  if (landlineCount > 0 && mobiles.length === 0) {
    warning = "رقم أرضي — لن يُستورد (واتساب لا يدعم الأرضي)";
  } else if (landlineCount > 0 && mobiles.length > 0) {
    warning = `تم رفض ${landlineCount} رقم أرضي والاحتفاظ بالمحمول فقط`;
  } else if (unknownCount > 0 && mobiles.length === 0) {
    warning = "تنسيق الرقم غير معروف — لن يُستورد";
  } else if (mobiles.length > 2) {
    warning = `تم الاحتفاظ بأول رقمين فقط من ${mobiles.length} أرقام`;
  }

  return { primary, secondary, warning };
}

// ─── Column mapping helpers ──────────────────────────────────────────────────

const COL_ALIASES: Record<string, keyof ParsedSupplier> = {
  name: "name",
  "اسم المورد": "name",
  "الاسم": "name",
  supplier_name: "name",
  suppliername: "name",

  supplier_id: "supplierId",
  supplierid: "supplierId",
  "كود المورد": "supplierId",
  "رقم المورد": "supplierId",
  id: "supplierId",

  contact: "contactPerson",
  contact_person: "contactPerson",
  contactperson: "contactPerson",
  "الشخص المسؤول": "contactPerson",
  "المسؤول": "contactPerson",

  email: "email",
  "البريد الإلكتروني": "email",
  "الإيميل": "email",

  phone: "phone",
  mobile: "phone",
  "الهاتف": "phone",
  "الجوال": "phone",
  "رقم الهاتف": "phone",
  "الموبايل": "phone",
  "رقم الجوال": "phone",

  // دعم عمود الهاتف الثاني المستقل
  phone2: "phone2",
  mobile2: "phone2",
  "الهاتف 2": "phone2",
  "الهاتف2": "phone2",
  "جوال2": "phone2",
  "رقم ثاني": "phone2",

  address: "address",
  "العنوان": "address",

  category: "category",
  categories: "category",
  "التصنيف": "category",
  "الفئة": "category",
};

function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_-]+/g, "").replace(/\s/g, "");
}

function mapRow(row: Record<string, unknown>): ParsedSupplier | null {
  const mapped: Partial<ParsedSupplier> = {};
  for (const [rawKey, val] of Object.entries(row)) {
    const norm = normalizeKey(rawKey);
    const field =
      COL_ALIASES[rawKey.trim()] ??
      COL_ALIASES[norm] ??
      (Object.entries(COL_ALIASES).find(([k]) => normalizeKey(k) === norm)?.[1] as
        | keyof ParsedSupplier
        | undefined);
    if (field && val !== undefined && val !== null && val !== "") {
      (mapped[field] as unknown) = String(val).trim();
    }
  }
  if (!mapped.name) return null;

  // ── معالجة أرقام الهواتف ─────────────────────────────────────────────────
  const rawPhone = mapped.phone as string | undefined;
  const rawPhone2 = mapped.phone2 as string | undefined;

  let finalPhone: string | undefined;
  let finalPhone2: string | undefined;
  let phoneWarning: string | undefined;

  if (rawPhone) {
    const parsed = parsePhoneField(rawPhone);
    finalPhone = parsed.primary ?? undefined;
    finalPhone2 = parsed.secondary ?? undefined;
    if (parsed.warning) phoneWarning = parsed.warning;
  }

  // إذا كان هناك عمود phone2 مستقل وما وُجد رقم ثاني من phone
  if (rawPhone2 && !finalPhone2) {
    const parsed2 = parsePhoneField(rawPhone2);
    if (parsed2.primary) {
      finalPhone2 = parsed2.primary;
    } else if (parsed2.warning) {
      phoneWarning = phoneWarning
        ? phoneWarning + " | " + parsed2.warning
        : parsed2.warning;
    }
  }

  return {
    _rowIndex: 0,
    name: mapped.name as string,
    supplierId: mapped.supplierId as string | undefined,
    contactPerson: mapped.contactPerson as string | undefined,
    email: mapped.email as string | undefined,
    phone: finalPhone,
    phone2: finalPhone2,
    address: mapped.address as string | undefined,
    category: (mapped.category as string) ?? "general",
    phoneWarning,
  };
}

// ─── File Parsing ────────────────────────────────────────────────────────────

async function parseFile(file: File): Promise<ParsedSupplier[]> {
  const ext = file.name.split(".").pop()?.toLowerCase();

  if (ext === "json") {
    const text = await file.text();
    const json = JSON.parse(text);
    const arr = Array.isArray(json) ? json : json.suppliers ?? json.data ?? [json];
    return arr
      .map((row: Record<string, unknown>, i: number) => {
        const s = mapRow(row);
        return s ? { ...s, _rowIndex: i + 1 } : null;
      })
      .filter(Boolean) as ParsedSupplier[];
  }

  if (ext === "csv" || ext === "xlsx" || ext === "xls") {
    const buffer = await file.arrayBuffer();
    const wb = xlsxRead(buffer, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsxUtils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
    return rows
      .map((row, i) => {
        const s = mapRow(row);
        return s ? { ...s, _rowIndex: i + 1 } : null;
      })
      .filter(Boolean) as ParsedSupplier[];
  }

  throw new Error("صيغة الملف غير مدعومة. يُرجى استخدام xlsx أو csv أو json");
}

// ─── Download Template ───────────────────────────────────────────────────────

function downloadTemplate() {
  const wb = xlsxUtils.book_new();
  const sampleData = [
    {
      name: "شركة المثال للتوريدات",
      supplier_id: "SUP-001",
      contact_person: "أحمد محمد",
      email: "ahmed@example.com",
      phone: "01012345678",
      address: "القاهرة، مصر",
      category: "general",
    },
    {
      name: "مؤسسة النماذج التجارية",
      supplier_id: "SUP-002",
      contact_person: "محمد علي",
      email: "m.ali@example.com",
      phone: "01112345678/01234567890",
      address: "الإسكندرية، مصر",
      category: "general",
    },
  ];
  const ws = xlsxUtils.json_to_sheet(sampleData);
  xlsxUtils.book_append_sheet(wb, ws, "Suppliers");
  const blob = new Blob(
    [xlsxUtils.sheet_to_csv(ws)],
    { type: "text/csv;charset=utf-8;" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "suppliers-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ─── ImportTab Component ──────────────────────────────────────────────────────

type ImportStep = "upload" | "preview" | "result";

interface ImportResultDetail {
  row?: number;
  name?: string;
  status?: "imported" | "skipped" | "error";
  reason?: string | null;
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors: number;
  details: ImportResultDetail[];
}

export default function ImportSuppliersTab() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<ImportStep>("upload");
  const [dragging, setDragging] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [rows, setRows] = useState<ParsedSupplier[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkCategory, setBulkCategory] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);

  const { data: categories = [] } = useListCategories({
    query: { queryKey: getListCategoriesQueryKey() },
  });

  const importMutation = useBulkImportSuppliers({
    mutation: {
      onSuccess: (data) => {
        setResult({
          imported: data.imported,
          skipped: data.skipped,
          errors: data.errors,
          details: data.details ?? [],
        });
        setStep("result");
        queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
      },
    },
  });

  // ── Drag & Drop ────────────────────────────────────────────────────────────

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    await processFile(file);
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processFile(file);
    e.target.value = "";
  }, []);

  async function processFile(file: File) {
    setParseError(null);
    setFileName(file.name);
    try {
      const parsed = await parseFile(file);
      if (parsed.length === 0) {
        setParseError("لم يتم العثور على بيانات صالحة في الملف. تأكد من وجود عمود 'name' أو 'الاسم'.");
        return;
      }
      setRows(parsed);
      // استثناء الصفوف التي تحتوي على أرضي فقط (بدون محمول) من الاختيار التلقائي
      const preSelected = new Set(
        parsed
          .map((r, i) => ({ r, i }))
          .filter(({ r }) => !r.phoneWarning?.includes("لن يُستورد") || r.phone)
          .map(({ i }) => i),
      );
      setSelected(preSelected);
      setStep("preview");
    } catch (err) {
      setParseError((err as Error).message || "خطأ في قراءة الملف");
    }
  }

  // ── Row Category Update ────────────────────────────────────────────────────

  function updateRowCategory(idx: number, cat: string) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, category: cat } : r)));
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  function toggleRow(idx: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((_, i) => i)));
  }

  // ── Bulk Assign ────────────────────────────────────────────────────────────

  function applyBulkCategory() {
    if (!bulkCategory) return;
    setRows((prev) =>
      prev.map((r, i) => (selected.has(i) ? { ...r, category: bulkCategory } : r)),
    );
  }

  // ── Submit ─────────────────────────────────────────────────────────────────

  function handleSubmit() {
    const toImport = rows
      .filter((_, i) => selected.has(i))
      .map((r) => ({
        name: r.name,
        supplierId: r.supplierId || undefined,
        contactPerson: r.contactPerson || undefined,
        email: r.email || undefined,
        // إذا كان هناك رقمان محمول: نضمهما بـ "/" ليراهما المستخدم في التفاصيل
        phone: r.phone
          ? r.phone2
            ? `${r.phone} / ${r.phone2}`
            : r.phone
          : undefined,
        address: r.address || undefined,
        category: r.category || "general",
      }));

    if (toImport.length === 0) return;
    importMutation.mutate({ data: { suppliers: toImport } });
  }

  // ── Reset ──────────────────────────────────────────────────────────────────

  function reset() {
    setStep("upload");
    setRows([]);
    setSelected(new Set());
    setParseError(null);
    setFileName("");
    setResult(null);
    setBulkCategory("");
  }

  // ─── إحصائيات التحذيرات للمعاينة ─────────────────────────────────────────
  const warningCount = rows.filter((r) => r.phoneWarning).length;
  const landlineOnlyCount = rows.filter(
    (r) => r.phoneWarning?.includes("لن يُستورد") && !r.phone,
  ).length;
  const dualMobileCount = rows.filter((r) => r.phone2).length;

  // ─── RENDER ────────────────────────────────────────────────────────────────

  if (step === "result" && result) {
    return (
      <div className="p-6 max-w-2xl mx-auto space-y-5">
        <div className="text-center space-y-2">
          <div className="flex justify-center">
            {result.errors === 0 && result.skipped === 0 ? (
              <CheckCircle2 size={48} className="text-green-500" />
            ) : result.imported === 0 ? (
              <XCircle size={48} className="text-red-500" />
            ) : (
              <AlertCircle size={48} className="text-yellow-500" />
            )}
          </div>
          <h2 className="text-lg font-semibold text-foreground">نتيجة الاستيراد</h2>
          <div className="flex justify-center gap-6 text-sm">
            <span className="text-green-600 font-medium">{result.imported} تم استيرادهم</span>
            <span className="text-yellow-600 font-medium">{result.skipped} تخطيناهم</span>
            <span className="text-red-600 font-medium">{result.errors} فشل</span>
          </div>
        </div>

        {result.details.length > 0 && (
          <div className="bg-card border border-border rounded-lg overflow-hidden">
            <div className="bg-muted/30 px-4 py-2 border-b border-border">
              <p className="text-xs font-medium text-muted-foreground">تفاصيل الاستيراد</p>
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-border">
              {result.details.map((d, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  {d.status === "imported" ? (
                    <CheckCircle2 size={14} className="text-green-500 shrink-0" />
                  ) : d.status === "skipped" ? (
                    <AlertCircle size={14} className="text-yellow-500 shrink-0" />
                  ) : (
                    <XCircle size={14} className="text-red-500 shrink-0" />
                  )}
                  <span className="text-foreground flex-1 truncate">{d.name}</span>
                  {d.reason && (
                    <span className="text-muted-foreground text-xs truncate max-w-[200px]">
                      {d.reason}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-center">
          <Button onClick={reset} variant="outline" className="gap-2">
            <RotateCcw size={14} /> استيراد ملف آخر
          </Button>
        </div>
      </div>
    );
  }

  if (step === "preview") {
    const selectedCount = selected.size;

    return (
      <div className="p-4 sm:p-6 space-y-4">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              مراجعة الموردين المستوردين
            </h2>
            <p className="text-muted-foreground text-xs mt-0.5">
              {fileName} — {rows.length} مورد
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={reset} className="gap-1.5">
              <RotateCcw size={13} /> رفع ملف آخر
            </Button>
            <Button
              size="sm"
              disabled={selectedCount === 0 || importMutation.isPending}
              onClick={handleSubmit}
              className="gap-1.5"
            >
              {importMutation.isPending ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Upload size={13} />
              )}
              استيراد {selectedCount > 0 ? `(${selectedCount})` : ""}
            </Button>
          </div>
        </div>

        {/* Phone warnings summary */}
        {warningCount > 0 && (
          <div className="flex flex-wrap gap-2">
            {landlineOnlyCount > 0 && (
              <div className="flex items-center gap-1.5 text-xs bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-1.5">
                <PhoneOff size={12} />
                <span>
                  {landlineOnlyCount} مورد {landlineOnlyCount === 1 ? "يحتوي" : "يحتوون"} على أرقام
                  أرضية فقط — تم إلغاء تحديدهم تلقائياً
                </span>
              </div>
            )}
            {dualMobileCount > 0 && (
              <div className="flex items-center gap-1.5 text-xs bg-blue-50 border border-blue-200 text-blue-700 rounded-lg px-3 py-1.5">
                <Phone size={12} />
                <span>
                  {dualMobileCount} مورد {dualMobileCount === 1 ? "لديه" : "لديهم"} رقمان محمول —
                  سيُحفظان معاً
                </span>
              </div>
            )}
          </div>
        )}

        {/* Bulk Category Assignment */}
        <div className="flex items-center gap-2 bg-muted/30 border border-border rounded-lg px-3 py-2.5 flex-wrap">
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            تعيين تصنيف جماعي ({selectedCount} مورد محدد):
          </span>
          <div className="relative flex-1 min-w-[160px] max-w-xs">
            <select
              value={bulkCategory}
              onChange={(e) => setBulkCategory(e.target.value)}
              className="w-full h-7 text-xs bg-background border border-border rounded px-2 pr-7 appearance-none focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">اختر التصنيف...</option>
              {categories.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!bulkCategory || selectedCount === 0}
            onClick={applyBulkCategory}
            className="h-7 text-xs px-3"
          >
            تطبيق
          </Button>
        </div>

        {/* Import error if any */}
        {importMutation.isError && (
          <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
            <AlertCircle size={14} />
            <span>حدث خطأ أثناء الاستيراد. يرجى المحاولة مرة أخرى.</span>
          </div>
        )}

        {/* Table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/30 border-b border-border">
                  <th className="px-3 py-2 text-center w-8">
                    <input
                      type="checkbox"
                      checked={selected.size === rows.length && rows.length > 0}
                      onChange={toggleAll}
                      className="rounded border-border"
                    />
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-right">#</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-right">الاسم</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-right">المسؤول</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-right">الإيميل</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-right">الهاتف (واتساب)</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-right min-w-[140px]">
                    التصنيف
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const hasWarning = !!row.phoneWarning;
                  const isLandlineOnly = hasWarning && row.phoneWarning?.includes("لن يُستورد") && !row.phone;
                  return (
                    <tr
                      key={i}
                      className={`border-b border-border last:border-0 ${
                        selected.has(i) ? "bg-background" : "bg-muted/10 opacity-60"
                      } ${isLandlineOnly ? "bg-red-50/30" : ""}`}
                    >
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={selected.has(i)}
                          onChange={() => toggleRow(i)}
                          className="rounded border-border"
                        />
                      </td>
                      <td className="px-3 py-2 text-muted-foreground text-xs font-mono">{row._rowIndex}</td>
                      <td className="px-3 py-2 font-medium text-foreground max-w-[160px] truncate">
                        {row.name}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground text-xs max-w-[120px] truncate">
                        {row.contactPerson ?? "-"}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground text-xs max-w-[160px] truncate">
                        {row.email ?? "-"}
                      </td>
                      <td className="px-3 py-2 text-xs min-w-[180px]">
                        {row.phone ? (
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1">
                              <span className="text-green-700 font-mono font-medium">{row.phone}</span>
                            </div>
                            {row.phone2 && (
                              <div className="flex items-center gap-1">
                                <span className="text-blue-600 font-mono text-xs">{row.phone2}</span>
                                <span className="text-muted-foreground text-[10px]">(ثاني)</span>
                              </div>
                            )}
                            {hasWarning && !isLandlineOnly && (
                              <div className="flex items-center gap-1 text-amber-600 text-[10px]">
                                <AlertCircle size={10} />
                                <span>{row.phoneWarning}</span>
                              </div>
                            )}
                          </div>
                        ) : isLandlineOnly ? (
                          <div className="flex items-center gap-1 text-red-500">
                            <PhoneOff size={11} />
                            <span className="text-[10px]">{row.phoneWarning}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="relative">
                          <select
                            value={row.category}
                            onChange={(e) => updateRowCategory(i, e.target.value)}
                            disabled={!selected.has(i)}
                            className="w-full h-7 text-xs bg-background border border-border rounded px-2 pr-6 appearance-none focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                          >
                            <option value="general">general</option>
                            {categories.map((c) => (
                              <option key={c.id} value={c.name}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <ChevronDown size={10} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // Upload step
  return (
    <div className="p-6 space-y-5 max-w-xl mx-auto">
      <div>
        <h2 className="text-base font-semibold text-foreground">استيراد موردين من ملف</h2>
        <p className="text-muted-foreground text-xs mt-1">
          يدعم صيغ <span className="font-medium">.xlsx</span> ،
          <span className="font-medium"> .xls</span> ،
          <span className="font-medium"> .csv</span> ،
          <span className="font-medium"> .json</span>
        </p>
      </div>

      {/* Phone format notice */}
      <div className="flex items-start gap-2 text-xs bg-blue-50 border border-blue-200 text-blue-700 rounded-lg px-3 py-2.5">
        <Phone size={13} className="mt-0.5 shrink-0" />
        <div className="space-y-0.5">
          <p className="font-medium">أرقام المحمول فقط — تنسيق واتساب تلقائي</p>
          <p className="text-blue-600">
            يقبل النظام أرقام المحمول المصرية (010 / 011 / 012 / 015) ويحوّلها تلقائياً
            لتنسيق واتساب الدولي (+20...). الأرقام الأرضية مرفوضة.
            يمكنك إدخال رقمين محمول في نفس الخلية مفصولين بـ /.
          </p>
        </div>
      </div>

      {/* Download template */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Download size={13} />
        <span>لا تعرف الصيغة؟</span>
        <button
          onClick={downloadTemplate}
          className="text-primary underline underline-offset-2 hover:text-primary/80"
        >
          حمّل قالب CSV
        </button>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
          dragging
            ? "border-primary bg-primary/5"
            : "border-border hover:border-primary/50 hover:bg-muted/20"
        }`}
      >
        <FileSpreadsheet size={40} className="mx-auto text-muted-foreground/40 mb-3" />
        <p className="text-sm font-medium text-foreground">اسحب الملف هنا أو انقر للاختيار</p>
        <p className="text-xs text-muted-foreground mt-1">xlsx · xls · csv · json</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls,.csv,.json"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {parseError && (
        <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2.5">
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          <span>{parseError}</span>
        </div>
      )}

      {/* Expected columns */}
      <div className="bg-muted/30 border border-border rounded-lg p-4 space-y-2">
        <p className="text-xs font-medium text-foreground">الأعمدة المتوقعة في الملف</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
          {[
            ["name / الاسم", "مطلوب"],
            ["supplier_id / رقم المورد", "اختياري"],
            ["contact_person / المسؤول", "اختياري"],
            ["email / الإيميل", "اختياري"],
            ["phone / الهاتف", "اختياري"],
            ["address / العنوان", "اختياري"],
            ["category / التصنيف", "اختياري"],
          ].map(([col, req]) => (
            <div key={col} className="flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${req === "مطلوب" ? "bg-primary" : "bg-muted-foreground/40"}`}
              />
              <span className="font-mono">{col}</span>
              <span className={req === "مطلوب" ? "text-primary font-medium" : ""}>{req === "مطلوب" ? "*" : ""}</span>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground mt-1 border-t border-border pt-2">
          💡 يمكن وضع رقمي محمول في عمود phone واحد مفصولين بـ <code className="bg-muted px-1 rounded">/</code>
          — مثال: <code className="bg-muted px-1 rounded">01012345678/01112345678</code>
        </p>
      </div>
    </div>
  );
}
