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
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ParsedSupplier {
  _rowIndex: number;
  name: string;
  supplierId?: string;
  contactPerson?: string;
  email?: string;
  phone?: string;
  address?: string;
  category: string;
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
    // Check direct alias
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
  return {
    _rowIndex: 0,
    name: mapped.name,
    supplierId: mapped.supplierId,
    contactPerson: mapped.contactPerson,
    email: mapped.email,
    phone: mapped.phone,
    address: mapped.address,
    category: mapped.category ?? "general",
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
      setSelected(new Set(parsed.map((_, i) => i)));
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
        phone: r.phone || undefined,
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
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-right">الهاتف</th>
                  <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-right min-w-[140px]">
                    التصنيف
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr
                    key={i}
                    className={`border-b border-border last:border-0 ${
                      selected.has(i) ? "bg-background" : "bg-muted/10 opacity-60"
                    }`}
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
                    <td className="px-3 py-2 text-muted-foreground text-xs">
                      {row.phone ?? "-"}
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
                ))}
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
      </div>
    </div>
  );
}
