import { Fragment, useEffect, useState, useCallback } from "react";
import { Layout } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileText, IdCard } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { BankCombobox } from "@/components/BankCombobox";
import { findBankByName } from "@/lib/egyptian-banks";
import { clockTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Tab =
  | "attendance"
  | "onboard"
  | "leave"
  | "missions"
  | "exceptions"
  | "discipline"
  | "employees"
  | "devices"
  | "payroll"
  | "settlement"
  | "reports"
  | "settings";

interface AttendanceRow {
  employeeId: number;
  employeeNo: string;
  fullName: string;
  department: string | null;
  biometricPin: string | null;
  firstIn: string | null;
  lastOut: string | null;
  punchCount: number;
  lateMinutes: number;
  absent: boolean;
  dayOffKind: "holiday" | "weekly" | null;
  dayOffName: string | null;
  onMission: boolean;
  missionFullDay: boolean;
  missionWindows: string[];
  missingPunchWarning: boolean;
  shiftStart: string;
  lateGraceMinutes: number;
  hasException: boolean;
  exemptFromPunch: boolean;
}
interface AttendanceResponse {
  date: string;
  shiftStart: string;
  shiftEnd?: string | null;
  lateGraceMinutes?: number;
  totals: {
    employees: number;
    present: number;
    absent: number;
    late: number;
    onMission?: number;
  };
  rows: AttendanceRow[];
}

interface Mission {
  id: number;
  employeeId: number;
  employeeName?: string;
  employeeNo?: string;
  missionDate: string;
  missionType: string;
  startTime: string | null;
  endTime: string | null;
  destination: string | null;
  reason: string | null;
  status: string;
  decidedAt: string | null;
}
interface AttendanceException {
  id: number;
  employeeId: number;
  employeeName?: string;
  employeeNo?: string;
  department?: string | null;
  startTime: string | null;
  lateGraceMinutes: number | null;
  exemptFromPunch: boolean;
  note: string | null;
  isActive: boolean;
}
interface RewardRow {
  id: number;
  employeeId: number;
  kind: string;
  amount: string;
  days: string | null;
  period: string;
  reason: string | null;
}
interface HrEmployee {
  id: number;
  employeeNo: string;
  fullName: string;
  fullNameEn: string | null;
  procurementEmployeeId: number | null;
  jobTitle: string | null;
  department: string | null;
  hireDate: string | null;
  status: string;
  biometricPin: string | null;
  phone: string | null;
}
interface Device {
  sn: string;
  name: string | null;
  location: string | null;
  isActive: boolean;
  lastSeenAt: string | null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const todayStr = () => new Date().toISOString().slice(0, 10);

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const PHOTO_MAX_BYTES = 300 * 1024;

/** Read a picked image as a data URL, checking type and size first. */
function readPhoto(file: File, t: (key: string) => string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!PHOTO_TYPES.includes(file.type)) return reject(new Error(t("hr.photo.badType")));
    if (file.size > PHOTO_MAX_BYTES) return reject(new Error(t("hr.photo.tooBig")));
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(t("hr.photo.badType")));
    reader.readAsDataURL(file);
  });
}

function PhotoPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const { t } = useLanguage();
  const [err, setErr] = useState<string | null>(null);
  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setErr(null);
      onChange(await readPhoto(file, t));
    } catch (ex) {
      setErr((ex as Error).message);
    }
  }
  return (
    <div className="flex items-center gap-3">
      {value ? (
        <img src={value} alt="" className="h-16 w-16 rounded-md object-cover border" />
      ) : (
        <div className="h-16 w-16 rounded-md border bg-muted" />
      )}
      <div className="space-y-1">
        <span className="text-xs text-muted-foreground block">{t("hr.photo.label")}</span>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={pick}
          className="text-sm"
        />
        <p className="text-xs text-muted-foreground">{t("hr.photo.hint")}</p>
        {err && <p className="text-xs text-red-600">{err}</p>}
      </div>
    </div>
  );
}

/** Thumbnail with a change button, used in the employees list. */
function EmployeePhoto({ id }: { id: number }) {
  const { t } = useLanguage();
  const [version, setVersion] = useState(0);
  const [missing, setMissing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setErr(null);
      const photo = await readPhoto(file, t);
      await api(`/hr/employees/${id}/photo`, {
        method: "PUT",
        body: JSON.stringify({ photo }),
      });
      setMissing(false);
      setVersion((v) => v + 1);
    } catch (ex) {
      setErr((ex as Error).message);
    }
  }
  return (
    <div className="flex items-center gap-2">
      {missing ? (
        <div className="h-8 w-8 rounded-full bg-muted" />
      ) : (
        <img
          src={`/api/hr/employees/${id}/photo?v=${version}`}
          alt=""
          className="h-8 w-8 rounded-full object-cover"
          onError={() => setMissing(true)}
        />
      )}
      <label className="text-xs text-primary underline cursor-pointer">
        {t("hr.photo.change")}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={upload}
          className="hidden"
        />
      </label>
      {err && <span className="text-xs text-red-600">{err}</span>}
    </div>
  );
}

// ---------- بطاقات الموظفين ----------

/** Preview shows larger cards on screen; print shows only the 85.6 × 54 mm sides, one per page. */
const CARD_PRINT_CSS = `
@page { size: 85.6mm 54mm; margin: 0; }
#hr-card-print iframe { border: 0; display: block; background: #fff; }
#hr-card-print .hr-card-side { overflow: hidden; }
#hr-card-print .card-print { display: none; }
@media print {
  body * { visibility: hidden !important; }
  #hr-card-print, #hr-card-print * { visibility: visible !important; }
  #hr-card-print { position: fixed; left: 0; top: 0; width: 85.6mm; margin: 0 !important; padding: 0 !important; gap: 0 !important; }
  #hr-card-print .hr-card-side { width: 85.6mm !important; height: 54mm !important; page-break-after: always; break-after: page; }
  #hr-card-print .hr-card-side:last-child { page-break-after: auto; break-after: auto; }
  #hr-card-print .card-preview { display: none; }
  #hr-card-print .card-print { display: block; width: 85.6mm !important; height: 54mm !important; }
  #hr-card-print, #hr-card-print * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}`;

/** Opens a preview of the employee's card (front and back) with a print button. */
/** Opens an employee document in a hidden frame and prints it (or only previews it in a new tab). */
function openEmployeeDocument(id: number, key: string, print: boolean) {
  const url = `/api/hr/employees/${id}/documents/${key}`;
  if (!print) {
    window.open(url, "_blank");
    return;
  }
  const frame = document.createElement("iframe");
  // A real A4-sized frame (kept invisible), not a 0×0 one: a zero-size frame lays
  // the document out at the wrong width, so sheets break in the wrong places.
  frame.style.cssText =
    "position:fixed;left:0;top:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none";
  frame.onload = () => {
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!win || !doc) {
      frame.remove();
      return;
    }
    // Print only after the logo and the fonts are decoded; printing right at
    // `load` is what made the logo disappear on some prints.
    const pending = Array.from(doc.images)
      .filter((img) => !img.complete)
      .map(
        (img) =>
          new Promise<void>((done) => {
            img.onload = img.onerror = () => done();
          }),
      );
    void Promise.all([...pending, doc.fonts?.ready]).then(() => {
      setTimeout(() => {
        try {
          win.focus();
          win.print();
        } finally {
          setTimeout(() => frame.remove(), 60_000);
        }
      }, 300);
    });
  };
  frame.src = url;
  document.body.appendChild(frame);
}

type DocDefinition = {
  name: string;
  label: string;
  type: "text" | "date" | "select" | "textarea" | "money";
  options?: string[];
};
type DocDefinitions = {
  keys: string[];
  employee: DocDefinition[];
  company: DocDefinition[];
};
type DocStatus = {
  defaults: Record<string, string>;
  fields: Record<string, string>;
  effective: Record<string, string>;
  missing: Record<string, string[]>;
};

let docDefinitionsCache: Promise<DocDefinitions> | null = null;
function loadDocDefinitions(): Promise<DocDefinitions> {
  docDefinitionsCache ??= api<DocDefinitions>("/hr/document-definitions");
  return docDefinitionsCache;
}

const docTextInput = "border rounded px-2 py-1.5 bg-background text-sm w-full disabled:opacity-60";

/** One input per field, by type. Calls onChange with the field name and its new value. */
function DocFieldsGrid({
  defs,
  values,
  onChange,
  suggestions,
}: {
  defs: DocDefinition[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  suggestions?: string[];
}) {
  const { t } = useLanguage();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {defs.map((def) => (
        <label key={def.name} className={def.type === "textarea" ? "sm:col-span-2" : ""}>
          <span className={setLabel}>{def.label}</span>
          {def.type === "select" ? (
            <select
              className={docTextInput}
              value={values[def.name] ?? ""}
              onChange={(e) => onChange(def.name, e.target.value)}
            >
              <option value="">{t("hr.docs.select")}</option>
              {def.options?.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : def.type === "textarea" ? (
            <textarea
              className={`${docTextInput} min-h-[60px]`}
              maxLength={2000}
              value={values[def.name] ?? ""}
              onChange={(e) => onChange(def.name, e.target.value)}
            />
          ) : (
            <input
              className={docTextInput}
              type={def.type === "date" ? "date" : "text"}
              inputMode={def.type === "money" ? "decimal" : undefined}
              list={def.name === "directManager" && suggestions ? "doc-managers" : undefined}
              maxLength={300}
              value={values[def.name] ?? ""}
              onChange={(e) => onChange(def.name, e.target.value)}
            />
          )}
        </label>
      ))}
    </div>
  );
}

/** Documents for one employee: the fields to fill, what is still missing, and preview/print. */
function EmployeeDocumentsButton({ id }: { id: number }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [defs, setDefs] = useState<DocDefinitions | null>(null);
  const [status, setStatus] = useState<DocStatus | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [managers, setManagers] = useState<string[]>([]);

  async function loadAll() {
    const [d, s, all] = await Promise.all([
      loadDocDefinitions(),
      api<DocStatus>(`/hr/employees/${id}/document-fields`),
      api<HrEmployee[]>("/hr/employees"),
    ]);
    setDefs(d);
    setStatus(s);
    setDraft(s.effective);
    setManagers(all.filter((e) => e.id !== id && e.status === "active").map((e) => e.fullName));
  }

  function openDialog(next: boolean) {
    setOpen(next);
    setErr(null);
    setSaved(false);
    if (next) loadAll().catch((e) => setErr((e as Error).message));
  }

  async function save() {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await api(`/hr/employees/${id}/document-fields`, {
        method: "PUT",
        body: JSON.stringify({ fields: draft }),
      });
      await loadAll();
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const dirty = status !== null && JSON.stringify(draft) !== JSON.stringify(status.effective);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => openDialog(true)}>
        <FileText className="me-1 h-4 w-4" />
        {t("hr.docs.button")}
      </Button>
      <Dialog open={open} onOpenChange={openDialog}>
        <DialogContent className="max-w-3xl w-[calc(100vw-2rem)] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("hr.docs.title")}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">{t("hr.docs.hint")}</p>
          {defs && status && (
            <ul className="divide-y">
              {defs.keys.map((key) => {
                const missing = status.missing[key] ?? [];
                const ready = missing.length === 0 && !dirty;
                return (
                  <li key={key} className="py-2 space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm">{t(`hr.docs.${key}`)}</span>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openEmployeeDocument(id, key, false)}
                        >
                          {t("hr.docs.preview")}
                        </Button>
                        <Button
                          size="sm"
                          disabled={!ready}
                          onClick={() => openEmployeeDocument(id, key, true)}
                        >
                          {t("hr.docs.print")}
                        </Button>
                      </div>
                    </div>
                    {!ready && (
                      <p className="text-xs text-amber-700">
                        {dirty
                          ? t("hr.docs.unsaved")
                          : `${t("hr.docs.incomplete")} ${missing.join("، ")}`}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {defs && (
            <div className="space-y-3 border-t pt-3">
              <h3 className="font-semibold text-sm">{t("hr.docs.fields")}</h3>
              <p className="text-xs text-muted-foreground">{t("hr.docs.autoHint")}</p>
              <DocFieldsGrid
                defs={defs.employee}
                values={draft}
                onChange={(name, value) => setDraft({ ...draft, [name]: value })}
                suggestions={managers}
              />
              <datalist id="doc-managers">
                {managers.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <div className="flex items-center gap-3">
                <Button size="sm" onClick={save} disabled={busy || !dirty}>
                  {t("hr.docs.save")}
                </Button>
                {saved && <span className="text-xs text-green-700">{t("hr.docs.saved")}</span>}
                {err && <span className="text-xs text-red-600">{err}</span>}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Company values used by every employee's documents (Settings). */
function CompanyDocumentsCard({
  value,
  onSaved,
}: {
  value: Record<string, string> | null;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const [defs, setDefs] = useState<DocDefinitions | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>(value ?? {});
  useEffect(() => {
    loadDocDefinitions()
      .then(setDefs)
      .catch(() => setDefs(null));
  }, []);
  useEffect(() => {
    setDraft(value ?? {});
  }, [value]);
  const complete = defs !== null && defs.company.every((f) => !!draft[f.name]);
  return (
    <SettingCard
      title={t("hr.docs.companyTitle")}
      configured={!!value && complete}
      onSaved={onSaved}
      onSave={() => saveSetting("document_company", draft)}
    >
      <p className="text-xs text-muted-foreground">{t("hr.docs.companyHint")}</p>
      {defs && (
        <DocFieldsGrid
          defs={defs.company}
          values={draft}
          onChange={(name, v) => setDraft({ ...draft, [name]: v })}
        />
      )}
    </SettingCard>
  );
}

function EmployeeCardButton({ id }: { id: number }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  // Preview fits the screen: up to 517 px wide, less on phones (the dialog has about 48 px of padding).
  const previewWidth = Math.round(Math.min(517, Math.max(240, window.innerWidth - 100)));
  const previewHeight = Math.round((previewWidth * 668.6916) / 1060);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t("hr.card.open")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle>{t("hr.card.preview")}</DialogTitle>
          </DialogHeader>
          <style>{CARD_PRINT_CSS}</style>
          <div id="hr-card-print" className="flex flex-col items-center gap-4">
            {(["front", "back"] as const).map((side) => (
              <div
                key={side}
                className="hr-card-side"
                style={{ width: previewWidth, height: previewHeight }}
              >
                <iframe
                  className="card-preview"
                  title={t(side === "front" ? "hr.card.front" : "hr.card.back")}
                  src={`/api/hr/employees/${id}/card/${side}?width=${previewWidth}`}
                  scrolling="no"
                  width={previewWidth}
                  height={previewHeight}
                />
                <iframe
                  className="card-print"
                  title={t(side === "front" ? "hr.card.front" : "hr.card.back")}
                  src={`/api/hr/employees/${id}/card/${side}`}
                  scrolling="no"
                  width={324}
                  height={204}
                />
              </div>
            ))}
          </div>
          <div className="rounded border bg-muted/40 p-3 text-xs space-y-1">
            <p className="font-medium">{t("hr.card.printSetupTitle")}</p>
            <ol className="list-decimal ps-5 space-y-0.5 text-muted-foreground">
              <li>{t("hr.card.printSetup1")}</li>
              <li>{t("hr.card.printSetup2")}</li>
              <li>{t("hr.card.printSetup3")}</li>
              <li>{t("hr.card.printSetup4")}</li>
              <li>{t("hr.card.printSetup5")}</li>
              <li>{t("hr.card.printSetup6")}</li>
            </ol>
          </div>
          <DialogFooter>
            <Button onClick={() => window.print()}>{t("hr.card.print")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** General manager shown on every card: name plus signature image. */
function CardManagerCard({
  value,
  onSaved,
}: {
  value: { name: string; signature: string | null } | null;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const [name, setName] = useState(value?.name ?? "");
  const [signature, setSignature] = useState<string | null>(value?.signature ?? null);
  const [sigErr, setSigErr] = useState<string | null>(null);
  const SIG_MAX_BYTES = 150 * 1024;
  const SIG_TYPES = ["image/png", "image/jpeg", "image/webp"];
  function pickSignature(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!SIG_TYPES.includes(file.type)) {
      setSigErr(t("hr.card.badImage"));
      return;
    }
    if (file.size > SIG_MAX_BYTES) {
      setSigErr(t("hr.card.sigTooBig"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setSignature(String(reader.result));
      setSigErr(null);
    };
    reader.onerror = () => setSigErr(t("hr.card.badImage"));
    reader.readAsDataURL(file);
  }
  return (
    <SettingCard
      title={t("hr.card.manager")}
      configured={!!value}
      onSaved={onSaved}
      onSave={() => saveSetting("card_manager", { name: name.trim(), signature })}
    >
      <p className="text-xs text-muted-foreground">{t("hr.card.managerHint")}</p>
      <label className="block">
        <span className={setLabel}>{t("hr.card.managerName")}</span>
        <input
          className={setInput}
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="space-y-2">
        <span className={setLabel}>{t("hr.card.signature")}</span>
        <p className="text-xs text-muted-foreground">{t("hr.card.signatureHint")}</p>
        <div className="flex flex-wrap items-center gap-3">
          {signature ? (
            <img
              src={signature}
              alt=""
              className="h-16 w-40 rounded border bg-white object-contain"
            />
          ) : (
            <span className="text-xs text-muted-foreground">{t("hr.card.noSignature")}</span>
          )}
          <label className="cursor-pointer text-xs text-primary underline">
            {t("hr.card.uploadSignature")}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={pickSignature}
              className="hidden"
            />
          </label>
          {signature && (
            <Button variant="outline" size="sm" onClick={() => setSignature(null)}>
              {t("hr.card.removeSignature")}
            </Button>
          )}
        </div>
        {sigErr && <p className="text-xs text-red-600">{sigErr}</p>}
      </div>
    </SettingCard>
  );
}

function CardSideUpload({
  settingKey,
  label,
  configured,
  onSaved,
}: {
  settingKey: "card_front" | "card_back";
  label: string;
  configured: boolean;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/\.html?$/i.test(file.name)) {
      setErr(t("hr.card.badFile"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const html = await file.text();
      await saveSetting(settingKey, { html });
      onSaved();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      await saveSetting(settingKey, null);
      onSaved();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded border p-3">
      <span className="text-sm font-medium">{label}</span>
      <span
        className={`rounded px-2 py-0.5 text-xs ${
          configured ? "bg-green-100 text-green-800" : "bg-muted text-muted-foreground"
        }`}
      >
        {configured ? t("hr.card.uploaded") : t("hr.card.default")}
      </span>
      <label className="cursor-pointer text-xs text-primary underline">
        {t("hr.card.upload")}
        <input
          type="file"
          accept=".html,text/html"
          onChange={upload}
          disabled={busy}
          className="hidden"
        />
      </label>
      {configured && (
        <Button variant="outline" size="sm" onClick={remove} disabled={busy}>
          {t("hr.card.remove")}
        </Button>
      )}
      {err && <span className="w-full text-xs text-red-600">{err}</span>}
    </div>
  );
}

function CardDesignCard({
  front,
  back,
  onSaved,
}: {
  front: unknown;
  back: unknown;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <h2 className="font-semibold">{t("hr.card.title")}</h2>
        <p className="text-xs text-muted-foreground">{t("hr.card.hint")}</p>
        <CardSideUpload
          settingKey="card_front"
          label={t("hr.card.front")}
          configured={!!front}
          onSaved={onSaved}
        />
        <CardSideUpload
          settingKey="card_back"
          label={t("hr.card.back")}
          configured={!!back}
          onSaved={onSaved}
        />
      </CardContent>
    </Card>
  );
}

export default function HrPage() {
  const { t } = useLanguage();
  const [tab, setTab] = useState<Tab>("attendance");

  const tabs: { id: Tab; label: string }[] = [
    { id: "attendance", label: t("hr.tab.attendance") },
    { id: "onboard", label: t("hr.tab.onboard") },
    { id: "leave", label: t("hr.tab.leave") },
    { id: "missions", label: t("hr.tab.missions") },
    { id: "exceptions", label: t("hr.tab.exceptions") },
    { id: "discipline", label: t("hr.tab.discipline") },
    { id: "employees", label: t("hr.tab.employees") },
    { id: "devices", label: t("hr.tab.devices") },
    { id: "payroll", label: t("hr.tab.payroll") },
    { id: "settlement", label: t("hr.tab.settlement") },
    { id: "reports", label: t("hr.tab.reports") },
    { id: "settings", label: t("hr.tab.settings") },
  ];

  return (
    <Layout>
      <div className="p-4 md:p-6 space-y-6">
        <div className="flex items-center gap-3">
          <IdCard className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t("hr.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("hr.subtitle")}</p>
          </div>
        </div>

        <div className="flex gap-2 border-b">
          {tabs.map((x) => (
            <button
              key={x.id}
              onClick={() => setTab(x.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                tab === x.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {x.label}
            </button>
          ))}
        </div>

        {tab === "attendance" && <AttendanceTab />}
        {tab === "onboard" && <OnboardTab />}
        {tab === "leave" && <LeaveTab />}
        {tab === "missions" && <MissionsTab />}
        {tab === "exceptions" && <ExceptionsTab />}
        {tab === "discipline" && <DisciplineTab />}
        {tab === "employees" && <EmployeesTab />}
        {tab === "devices" && <DevicesTab />}
        {tab === "payroll" && <PayrollTab />}
        {tab === "settlement" && <SettlementTab />}
        {tab === "reports" && <ReportsTab />}
        {tab === "settings" && <SettingsTab />}
      </div>
    </Layout>
  );
}

function AttendanceTab() {
  const { t } = useLanguage();
  const [date, setDate] = useState(todayStr());
  const [shiftStart, setShiftStart] = useState<string | null>(null);
  const [data, setData] = useState<AttendanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed the shift start from HR settings the first time the tab opens, so the
  // operator does not have to re-enter it on every visit.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api<{ settings: Record<string, unknown> }>("/hr/settings");
        const ws = r.settings.work_shift as { start?: string } | null;
        if (!cancelled) setShiftStart(ws?.start ?? "09:00");
      } catch {
        if (!cancelled) setShiftStart("09:00");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    if (shiftStart === null) return;
    try {
      setError(null);
      setData(
        await api<AttendanceResponse>(`/hr/attendance?date=${date}&shiftStart=${shiftStart}`),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, [date, shiftStart]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-muted-foreground mb-1">{t("hr.att.date")}</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border rounded px-2 py-1.5 bg-background"
          />
        </label>
        <label className="text-sm">
          <span className="block text-muted-foreground mb-1">{t("hr.att.shiftStart")}</span>
          <input
            type="time"
            value={shiftStart ?? ""}
            onChange={(e) => setShiftStart(e.target.value)}
            className="border rounded px-2 py-1.5 bg-background"
          />
        </label>
        <Button variant="outline" onClick={load}>
          {t("hr.att.refresh")}
        </Button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label={t("hr.att.total")} value={data.totals.employees} />
            <Stat label={t("hr.att.present")} value={data.totals.present} />
            <Stat label={t("hr.att.absent")} value={data.totals.absent} tone="red" />
            <Stat label={t("hr.att.late")} value={data.totals.late} tone="amber" />
            <Stat label={t("hr.att.onMission")} value={data.totals.onMission ?? 0} tone="amber" />
          </div>

          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="p-2 text-start">{t("hr.col.no")}</th>
                    <th className="p-2 text-start">{t("hr.col.name")}</th>
                    <th className="p-2 text-start">{t("hr.col.dept")}</th>
                    <th className="p-2 text-start">{t("hr.att.firstIn")}</th>
                    <th className="p-2 text-start">{t("hr.att.lastOut")}</th>
                    <th className="p-2 text-start">{t("hr.att.late")}</th>
                    <th className="p-2 text-start">{t("hr.att.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.employeeId} className="border-t">
                      <td className="p-2">{r.employeeNo}</td>
                      <td className="p-2">{r.fullName}</td>
                      <td className="p-2">{r.department ?? "—"}</td>
                      <td className="p-2">{clockTime(r.firstIn)}</td>
                      <td className="p-2">{clockTime(r.lastOut)}</td>
                      <td className="p-2">
                        {r.lateMinutes > 0 ? `${r.lateMinutes} ${t("hr.att.minutes")}` : "—"}
                      </td>
                      <td className="p-2">
                        {r.exemptFromPunch && (
                          <span
                            className="me-2 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-800 dark:bg-sky-950/50 dark:text-sky-300"
                            title={t("hr.att.exemptHint")}
                          >
                            {t("hr.att.exemptBadge")}
                          </span>
                        )}
                        {r.onMission && (
                          <span className="me-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                            {r.missionFullDay
                              ? t("hr.att.missionFullDay")
                              : `${t("hr.att.missionTimed")} ${r.missionWindows.join(" ، ")}`}
                          </span>
                        )}
                        {r.dayOffKind && (
                          <span className="me-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                            {r.dayOffKind === "holiday"
                              ? `${t("hr.att.holiday")}: ${r.dayOffName ?? ""}`
                              : t("hr.att.weeklyOff")}
                          </span>
                        )}
                        {r.absent ? (
                          <span className="text-red-600">{t("hr.att.absentLabel")}</span>
                        ) : r.dayOffKind && r.punchCount === 0 ? null : (
                          <span className="text-green-700">{t("hr.att.presentLabel")}</span>
                        )}
                        {r.missingPunchWarning && (
                          <span
                            className="ms-2 text-xs text-amber-700 dark:text-amber-400"
                            title={t("hr.att.missionNoPunchHint")}
                          >
                            ⚠ {t("hr.att.missionNoPunch")}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {data.rows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-6 text-center text-muted-foreground">
                        {t("hr.att.noEmployees")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "red" | "amber" | "green";
}) {
  const color =
    tone === "red"
      ? "text-red-600"
      : tone === "amber"
        ? "text-amber-600"
        : tone === "green"
          ? "text-green-700"
          : "text-foreground";
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-2xl font-bold ${color}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

function EmployeesTab() {
  const { t } = useLanguage();
  const [rows, setRows] = useState<HrEmployee[]>([]);
  const [procAccounts, setProcAccounts] = useState<{ id: number; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ id: number; name: string }[]>("/hr/procurement-accounts")
      .then(setProcAccounts)
      .catch(() => setProcAccounts([]));
  }, []);
  const [form, setForm] = useState({
    employeeNo: "",
    fullName: "",
    fullNameEn: "",
    department: "",
    jobTitle: "",
    biometricPin: "",
  });

  const load = useCallback(async () => {
    try {
      setRows(await api<HrEmployee[]>("/hr/employees"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      setError(null);
      await api("/hr/employees", { method: "POST", body: JSON.stringify(form) });
      setForm({
        employeeNo: "",
        fullName: "",
        fullNameEn: "",
        department: "",
        jobTitle: "",
        biometricPin: "",
      });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function setStatus(id: number, status: string) {
    try {
      await api(`/hr/employees/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const [editId, setEditId] = useState<number | null>(null);
  const [draft, setDraft] = useState({
    fullName: "",
    fullNameEn: "",
    procurementId: "",
    jobTitle: "",
    department: "",
    phone: "",
    biometricPin: "",
  });
  const [rehireId, setRehireId] = useState<number | null>(null);
  const [rehireDate, setRehireDate] = useState(todayStr());
  const emptyBank = { bankName: "", accountHolder: "", accountNo: "", iban: "" };
  const [bankDraft, setBankDraft] = useState(emptyBank);
  const [salaryDraft, setSalaryDraft] = useState({ basicSalary: "", incentive: "" });
  const [currentSalary, setCurrentSalary] = useState<{
    basicSalary: string;
    incentive: string;
  } | null>(null);
  const [rewardPeriod, setRewardPeriod] = useState(todayStr().slice(0, 7));
  const [rewardDraft, setRewardDraft] = useState({
    mode: "amount" as "amount" | "days",
    value: "",
    reason: "",
  });
  const [rewards, setRewards] = useState<RewardRow[]>([]);
  const [nationalDraft, setNationalDraft] = useState("");
  const [currentNational, setCurrentNational] = useState<string | null>(null);
  const [currentBank, setCurrentBank] = useState<{
    bankName: string;
    accountHolder: string;
    accountMasked: string;
    ibanMasked: string | null;
  } | null>(null);

  async function startEdit(r: HrEmployee) {
    setEditId(r.id);
    setBankDraft(emptyBank);
    setCurrentBank(null);
    setNationalDraft("");
    setCurrentNational(null);
    setSalaryDraft({ basicSalary: "", incentive: "" });
    setCurrentSalary(null);
    setRewardDraft({ mode: "amount", value: "", reason: "" });
    setRewards([]);
    loadRewards(r.id, rewardPeriod);
    setDraft({
      fullName: r.fullName ?? "",
      fullNameEn: r.fullNameEn ?? "",
      procurementId: r.procurementEmployeeId != null ? String(r.procurementEmployeeId) : "",
      jobTitle: r.jobTitle ?? "",
      department: r.department ?? "",
      phone: r.phone ?? "",
      biometricPin: r.biometricPin ?? "",
    });
    try {
      const file = await api<{
        profile: { nationalIdMasked: string | null } | null;
        contracts: { basicSalary: string; incentive: string; isCurrent: boolean }[];
        bankAccounts: {
          bankName: string;
          accountHolder: string;
          accountMasked: string;
          ibanMasked: string | null;
          isPrimary: boolean;
        }[];
      }>(`/hr/employees/${r.id}/file`);
      const cur = file.contracts.find((c) => c.isCurrent);
      setCurrentSalary(cur ? { basicSalary: cur.basicSalary, incentive: cur.incentive } : null);
      const primary = file.bankAccounts.find((b) => b.isPrimary) ?? file.bankAccounts[0];
      setCurrentBank(primary ?? null);
      setCurrentNational(file.profile?.nationalIdMasked ?? null);
    } catch {
      setCurrentBank(null);
    }
  }

  async function loadRewards(empId: number, period: string) {
    try {
      const rows = await api<RewardRow[]>(`/hr/pay-adjustments?period=${period}`);
      setRewards(rows.filter((x) => x.employeeId === empId && x.kind === "bonus"));
    } catch {
      setRewards([]);
    }
  }

  async function addReward(empId: number) {
    try {
      setError(null);
      const isDays = rewardDraft.mode === "days";
      await api("/hr/pay-adjustments", {
        method: "POST",
        body: JSON.stringify({
          employeeId: empId,
          kind: "bonus",
          period: rewardPeriod,
          reason: rewardDraft.reason,
          ...(isDays ? { days: rewardDraft.value } : { amount: rewardDraft.value }),
        }),
      });
      setRewardDraft({ ...rewardDraft, value: "", reason: "" });
      loadRewards(empId, rewardPeriod);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteReward(empId: number, id: number) {
    try {
      setError(null);
      await api(`/hr/pay-adjustments/${id}`, { method: "DELETE" });
      loadRewards(empId, rewardPeriod);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function saveEdit(id: number) {
    try {
      setError(null);
      const bankTouched = [
        bankDraft.bankName,
        bankDraft.accountHolder,
        bankDraft.accountNo,
        bankDraft.iban,
      ].some((x) => x.trim() !== "");
      const salaryTouched =
        salaryDraft.basicSalary.trim() !== "" || salaryDraft.incentive.trim() !== "";
      if (salaryTouched && currentSalary) {
        await api(`/hr/employees/${id}/salary`, {
          method: "PUT",
          body: JSON.stringify({
            basicSalary: salaryDraft.basicSalary.trim() || currentSalary.basicSalary,
            incentive: salaryDraft.incentive.trim() || currentSalary.incentive,
          }),
        });
      }
      if (nationalDraft.trim() !== "") {
        await api(`/hr/employees/${id}/national-id`, {
          method: "PUT",
          body: JSON.stringify({ nationalId: nationalDraft.trim() }),
        });
      }
      if (
        bankTouched &&
        (!bankDraft.bankName || !bankDraft.accountHolder || !bankDraft.accountNo)
      ) {
        setError(t("hr.emp.bankIncomplete"));
        return;
      }
      await api(`/hr/employees/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          fullName: draft.fullName,
          fullNameEn: draft.fullNameEn,
          procurementEmployeeId: draft.procurementId === "" ? null : Number(draft.procurementId),
          jobTitle: draft.jobTitle,
          department: draft.department,
          phone: draft.phone,
          biometricPin: draft.biometricPin.trim() === "" ? null : draft.biometricPin.trim(),
        }),
      });
      if (bankTouched) {
        await api(`/hr/employees/${id}/bank`, { method: "PUT", body: JSON.stringify(bankDraft) });
      }
      setEditId(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function rehire(id: number) {
    try {
      setError(null);
      await api(`/hr/employees/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "active", hireDate: rehireDate }),
      });
      setRehireId(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const input = "border rounded px-2 py-1.5 bg-background text-sm";

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2 items-end">
        <input
          className={input}
          placeholder={t("hr.col.no")}
          value={form.employeeNo}
          onChange={(e) => setForm({ ...form, employeeNo: e.target.value })}
          required
        />
        <input
          className={input}
          placeholder={t("hr.col.nameAr")}
          value={form.fullName}
          onChange={(e) => setForm({ ...form, fullName: e.target.value })}
          required
        />
        <input
          className={input}
          dir="ltr"
          placeholder={t("hr.col.nameEn")}
          value={form.fullNameEn}
          onChange={(e) => setForm({ ...form, fullNameEn: e.target.value })}
          required
        />
        <input
          className={input}
          placeholder={t("hr.col.dept")}
          value={form.department}
          onChange={(e) => setForm({ ...form, department: e.target.value })}
        />
        <input
          className={input}
          placeholder={t("hr.col.job")}
          value={form.jobTitle}
          onChange={(e) => setForm({ ...form, jobTitle: e.target.value })}
        />
        <input
          className={input}
          placeholder={t("hr.col.pin")}
          value={form.biometricPin}
          onChange={(e) => setForm({ ...form, biometricPin: e.target.value })}
        />
        <Button type="submit">{t("hr.emp.add")}</Button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="p-2 text-start">{t("hr.photo.col")}</th>
                <th className="p-2 text-start">{t("hr.col.no")}</th>
                <th className="p-2 text-start">{t("hr.col.name")}</th>
                <th className="p-2 text-start">{t("hr.col.dept")}</th>
                <th className="p-2 text-start">{t("hr.col.job")}</th>
                <th className="p-2 text-start">{t("hr.col.pin")}</th>
                <th className="p-2 text-start">{t("hr.col.status")}</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr className="border-t">
                    <td className="p-2">
                      <EmployeePhoto id={r.id} />
                    </td>
                    <td className="p-2">{r.employeeNo}</td>
                    <td className="p-2">{r.fullName}</td>
                    <td className="p-2">{r.department ?? "—"}</td>
                    <td className="p-2">{r.jobTitle ?? "—"}</td>
                    <td className="p-2">
                      {r.biometricPin ?? (
                        <span className="text-amber-600">{t("hr.emp.noPin")}</span>
                      )}
                    </td>
                    <td className="p-2">{t(`hr.status.${r.status}`)}</td>
                    <td className="p-2 text-end">
                      <div className="flex flex-wrap justify-end gap-2">
                        <EmployeeCardButton id={r.id} />
                        <EmployeeDocumentsButton id={r.id} />
                        <Button variant="outline" size="sm" onClick={() => startEdit(r)}>
                          {t("hr.emp.edit")}
                        </Button>
                        {r.status === "active" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setStatus(r.id, "resigned")}
                          >
                            {t("hr.emp.offboard")}
                          </Button>
                        )}
                        {r.status !== "active" && rehireId !== r.id && (
                          <Button variant="outline" size="sm" onClick={() => setRehireId(r.id)}>
                            {t("hr.emp.rehire")}
                          </Button>
                        )}
                        {rehireId === r.id && (
                          <span className="flex items-center gap-2">
                            <input
                              type="date"
                              className={input}
                              value={rehireDate}
                              onChange={(e) => setRehireDate(e.target.value)}
                            />
                            <Button size="sm" onClick={() => rehire(r.id)}>
                              {t("hr.emp.rehireConfirm")}
                            </Button>
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                  {editId === r.id && (
                    <tr className="bg-muted/30">
                      <td colSpan={8} className="p-3">
                        <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                          {(
                            [
                              ["fullName", t("hr.col.nameAr")],
                              ["fullNameEn", t("hr.col.nameEn")],
                              ["jobTitle", t("hr.col.job")],
                              ["department", t("hr.col.dept")],
                              ["phone", t("hr.onb.phone")],
                              ["biometricPin", t("hr.col.pin")],
                            ] as const
                          ).map(([k, label]) => (
                            <label key={k} className="block">
                              <span className="text-xs text-muted-foreground block mb-1">
                                {label}
                              </span>
                              <input
                                className={input + " w-full"}
                                value={draft[k]}
                                onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                              />
                            </label>
                          ))}
                          <label className="block">
                            <span className="text-xs text-muted-foreground block mb-1">
                              {t("hr.emp.procAccount")}
                            </span>
                            <select
                              className={input + " w-full"}
                              value={draft.procurementId}
                              onChange={(e) =>
                                setDraft({ ...draft, procurementId: e.target.value })
                              }
                            >
                              <option value="">{t("hr.emp.procNone")}</option>
                              {procAccounts.map((a) => (
                                <option key={a.id} value={String(a.id)}>
                                  {a.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <div className="mt-4 space-y-2 border-t pt-3">
                          <h3 className="text-sm font-semibold">{t("hr.emp.salarySection")}</h3>
                          <p className="text-xs text-muted-foreground">
                            {currentSalary
                              ? `${t("hr.emp.salaryCurrent")}: ${currentSalary.basicSalary} / ${currentSalary.incentive}`
                              : t("hr.emp.salaryNone")}
                          </p>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-w-md">
                            {(["basicSalary", "incentive"] as const).map((k) => (
                              <label key={k} className="block">
                                <span className="text-xs text-muted-foreground block mb-1">
                                  {k === "basicSalary" ? t("hr.emp.basic") : t("hr.emp.incentive")}
                                </span>
                                <input
                                  className={input + " w-full"}
                                  inputMode="decimal"
                                  value={salaryDraft[k]}
                                  onChange={(e) =>
                                    setSalaryDraft({ ...salaryDraft, [k]: e.target.value })
                                  }
                                />
                              </label>
                            ))}
                          </div>
                        </div>
                        <div className="mt-4 space-y-2 border-t pt-3">
                          <h3 className="text-sm font-semibold">{t("hr.emp.rewardsSection")}</h3>
                          <div className="flex flex-wrap gap-2 items-end">
                            <label className="block">
                              <span className="text-xs text-muted-foreground block mb-1">
                                {t("hr.emp.rewardPeriod")}
                              </span>
                              <input
                                type="month"
                                className={input}
                                value={rewardPeriod}
                                onChange={(e) => {
                                  setRewardPeriod(e.target.value);
                                  loadRewards(r.id, e.target.value);
                                }}
                              />
                            </label>
                            <select
                              className={input}
                              value={rewardDraft.mode}
                              onChange={(e) =>
                                setRewardDraft({
                                  ...rewardDraft,
                                  mode: e.target.value as "amount" | "days",
                                })
                              }
                            >
                              <option value="amount">{t("hr.emp.rewardByAmount")}</option>
                              <option value="days">{t("hr.emp.rewardByDays")}</option>
                            </select>
                            <input
                              className={input + " w-28"}
                              inputMode="decimal"
                              placeholder={
                                rewardDraft.mode === "days"
                                  ? t("hr.emp.rewardDays")
                                  : t("hr.emp.rewardAmount")
                              }
                              value={rewardDraft.value}
                              onChange={(e) =>
                                setRewardDraft({ ...rewardDraft, value: e.target.value })
                              }
                            />
                            <input
                              className={input + " flex-1 min-w-40"}
                              placeholder={t("hr.emp.rewardReason")}
                              value={rewardDraft.reason}
                              onChange={(e) =>
                                setRewardDraft({ ...rewardDraft, reason: e.target.value })
                              }
                            />
                            <Button size="sm" type="button" onClick={() => addReward(r.id)}>
                              {t("hr.emp.rewardAdd")}
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground">{t("hr.emp.rewardHint")}</p>
                          <ul className="text-sm space-y-1">
                            {rewards.map((x) => (
                              <li key={x.id} className="flex items-center gap-2">
                                <span>
                                  {x.days !== null
                                    ? `${Number(x.days)} ${t("hr.emp.rewardDaysUnit")}`
                                    : x.amount}
                                </span>
                                {x.reason && (
                                  <span className="text-muted-foreground">· {x.reason}</span>
                                )}
                                <Button
                                  size="sm"
                                  variant="outline"
                                  type="button"
                                  onClick={() => deleteReward(r.id, x.id)}
                                >
                                  {t("hr.emp.rewardDelete")}
                                </Button>
                              </li>
                            ))}
                            {rewards.length === 0 && (
                              <li className="text-muted-foreground">{t("hr.emp.rewardNone")}</li>
                            )}
                          </ul>
                        </div>
                        <div className="mt-4 space-y-2 border-t pt-3">
                          <h3 className="text-sm font-semibold">{t("hr.emp.nationalSection")}</h3>
                          <p className="text-xs text-muted-foreground">
                            {currentNational
                              ? `${t("hr.emp.nationalCurrent")}: ${currentNational}`
                              : t("hr.emp.nationalNone")}
                          </p>
                          <label className="block max-w-sm">
                            <span className="text-xs text-muted-foreground block mb-1">
                              {t("hr.emp.nationalNew")}
                            </span>
                            <input
                              className={input + " w-full"}
                              inputMode="numeric"
                              maxLength={14}
                              value={nationalDraft}
                              onChange={(e) => setNationalDraft(e.target.value.replace(/\D/g, ""))}
                            />
                          </label>
                        </div>
                        <div className="mt-4 space-y-2 border-t pt-3">
                          <h3 className="text-sm font-semibold">{t("hr.emp.bankSection")}</h3>
                          <p className="text-xs text-muted-foreground">
                            {currentBank
                              ? `${t("hr.emp.bankCurrent")}: ${currentBank.bankName} · ${currentBank.accountMasked}${
                                  currentBank.ibanMasked ? ` · IBAN ${currentBank.ibanMasked}` : ""
                                }`
                              : t("hr.emp.bankNone")}
                          </p>
                          <p className="text-xs text-muted-foreground">{t("hr.emp.bankHint")}</p>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <span className="text-xs text-muted-foreground block">
                                {t("hr.onb.bankName")}
                              </span>
                              <BankCombobox
                                value={bankDraft.bankName}
                                onChange={(v) => setBankDraft({ ...bankDraft, bankName: v })}
                              />
                            </div>
                            {(
                              [
                                ["accountHolder", t("hr.onb.accountHolder")],
                                ["accountNo", t("hr.onb.accountNo")],
                                ["iban", t("hr.emp.iban")],
                              ] as const
                            ).map(([k, label]) => (
                              <label key={k} className="block">
                                <span className="text-xs text-muted-foreground block mb-1">
                                  {label}
                                </span>
                                <input
                                  className={input + " w-full"}
                                  value={bankDraft[k]}
                                  onChange={(e) =>
                                    setBankDraft({ ...bankDraft, [k]: e.target.value })
                                  }
                                />
                              </label>
                            ))}
                          </div>
                        </div>
                        <div className="flex gap-2 mt-3">
                          <Button size="sm" onClick={() => saveEdit(r.id)}>
                            {t("hr.set.save")}
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => setEditId(null)}>
                            {t("hr.emp.cancel")}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-muted-foreground">
                    {t("hr.emp.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function DevicesTab() {
  const { t } = useLanguage();
  const [rows, setRows] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api<Device[]>("/hr/devices"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(d: Device) {
    try {
      await api(`/hr/devices/${encodeURIComponent(d.sn)}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !d.isActive }),
      });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("hr.dev.help")}</p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="p-2 text-start">{t("hr.dev.sn")}</th>
                <th className="p-2 text-start">{t("hr.dev.lastSeen")}</th>
                <th className="p-2 text-start">{t("hr.col.status")}</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.sn} className="border-t">
                  <td className="p-2 font-mono">{d.sn}</td>
                  <td className="p-2">
                    {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "—"}
                  </td>
                  <td className="p-2">{d.isActive ? t("hr.dev.active") : t("hr.dev.pending")}</td>
                  <td className="p-2 text-end">
                    <Button variant="outline" size="sm" onClick={() => toggle(d)}>
                      {d.isActive ? t("hr.dev.deactivate") : t("hr.dev.activate")}
                    </Button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-muted-foreground">
                    {t("hr.dev.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

interface LeaveType {
  id: number;
  nameAr: string;
  nameEn: string;
  annualDays: number;
  paid: boolean;
  requiresCertificate: boolean;
  isActive: boolean;
}
interface LeaveRequest {
  id: number;
  employeeId: number;
  employeeName: string;
  leaveTypeId: number;
  leaveNameAr: string;
  startDate: string;
  endDate: string;
  days: string;
  status: string;
  reason: string | null;
}
interface BalanceRow {
  employeeId: number;
  employeeNo: string;
  fullName: string;
  balances: {
    leaveTypeId: number;
    nameAr: string;
    allocated: number;
    used: number;
    pending: number;
    remaining: number;
  }[];
}

function ExceptionsTab() {
  const { t } = useLanguage();
  const [rows, setRows] = useState<AttendanceException[]>([]);
  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [form, setForm] = useState({
    employeeId: "",
    startTime: "",
    lateGraceMinutes: "",
    exemptFromPunch: false,
    note: "",
  });

  const load = useCallback(async () => {
    try {
      setError(null);
      const [ex, emp] = await Promise.all([
        api<AttendanceException[]>("/hr/attendance-exceptions"),
        api<HrEmployee[]>("/hr/employees"),
      ]);
      setRows(ex);
      setEmployees(emp.filter((e) => e.status === "active"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.employeeId) return;
    try {
      setError(null);
      setSaved(null);
      const emp = employees.find((x) => String(x.id) === form.employeeId);
      await api(`/hr/attendance-exceptions/${form.employeeId}`, {
        method: "PUT",
        body: JSON.stringify({
          startTime: form.startTime || null,
          lateGraceMinutes: form.lateGraceMinutes === "" ? null : Number(form.lateGraceMinutes),
          exemptFromPunch: form.exemptFromPunch,
          note: form.note,
        }),
      });
      setSaved(t("hr.exc.savedFor").replace("{name}", emp?.fullName ?? ""));
      setForm({
        employeeId: "",
        startTime: "",
        lateGraceMinutes: "",
        exemptFromPunch: false,
        note: "",
      });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(employeeId: number) {
    try {
      setError(null);
      setSaved(null);
      await api(`/hr/attendance-exceptions/${employeeId}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const input = "border rounded px-2 py-1.5 bg-background text-sm";

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground space-y-1">
          <p>{t("hr.exc.intro")}</p>
          <p>{t("hr.exc.introHint")}</p>
        </CardContent>
      </Card>

      <form onSubmit={save} className="flex flex-wrap gap-2 items-end">
        <select
          className={input}
          value={form.employeeId}
          onChange={(e) => setForm({ ...form, employeeId: e.target.value })}
          required
        >
          <option value="">{t("hr.mission.pickEmployee")}</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.fullName}
            </option>
          ))}
        </select>
        <label className="flex flex-col text-xs text-muted-foreground gap-1">
          {t("hr.exc.startTime")}
          <input
            type="time"
            className={input}
            value={form.startTime}
            onChange={(e) => setForm({ ...form, startTime: e.target.value })}
          />
        </label>
        <label className="flex flex-col text-xs text-muted-foreground gap-1">
          {t("hr.exc.grace")}
          <input
            type="number"
            min={0}
            max={240}
            className={`${input} w-24`}
            placeholder={t("hr.exc.inherit")}
            value={form.lateGraceMinutes}
            onChange={(e) => setForm({ ...form, lateGraceMinutes: e.target.value })}
          />
        </label>
        <label className="flex items-center gap-2 text-sm pb-1.5">
          <input
            type="checkbox"
            checked={form.exemptFromPunch}
            onChange={(e) => setForm({ ...form, exemptFromPunch: e.target.checked })}
          />
          {t("hr.exc.exempt")}
        </label>
        <input
          className={input}
          placeholder={t("hr.exc.note")}
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
        />
        <Button type="submit">{t("hr.exc.save")}</Button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {saved && <p className="text-sm text-green-700">{saved}</p>}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="p-2 text-start">{t("hr.col.no")}</th>
                <th className="p-2 text-start">{t("hr.col.name")}</th>
                <th className="p-2 text-start">{t("hr.exc.startTime")}</th>
                <th className="p-2 text-start">{t("hr.exc.grace")}</th>
                <th className="p-2 text-start">{t("hr.exc.exempt")}</th>
                <th className="p-2 text-start">{t("hr.exc.note")}</th>
                <th className="p-2 text-start">{t("hr.att.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2">{r.employeeNo ?? "—"}</td>
                  <td className="p-2">{r.employeeName ?? "—"}</td>
                  <td className="p-2">{r.startTime ?? t("hr.exc.inherit")}</td>
                  <td className="p-2">
                    {r.lateGraceMinutes === null ? t("hr.exc.inherit") : r.lateGraceMinutes}
                  </td>
                  <td className="p-2">{r.exemptFromPunch ? "✓" : "—"}</td>
                  <td className="p-2">{r.note ?? "—"}</td>
                  <td className="p-2">
                    {r.isActive ? (
                      <button
                        className="text-xs text-red-600 underline"
                        onClick={() => remove(r.employeeId)}
                      >
                        {t("hr.exc.remove")}
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("hr.exc.disabled")}</span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-muted-foreground">
                    {t("hr.exc.none")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function MissionsTab() {
  const { t } = useLanguage();
  const [missions, setMissions] = useState<Mission[]>([]);
  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    employeeId: "",
    missionDate: todayStr(),
    missionType: "full_day",
    startTime: "08:00",
    endTime: "12:00",
    destination: "",
    reason: "",
  });
  const isTimed = form.missionType === "timed";

  const load = useCallback(async () => {
    try {
      setError(null);
      const [mi, emp] = await Promise.all([
        api<Mission[]>("/hr/missions"),
        api<HrEmployee[]>("/hr/employees"),
      ]);
      setMissions(mi);
      setEmployees(emp.filter((e) => e.status === "active"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      setError(null);
      await api("/hr/missions", {
        method: "POST",
        body: JSON.stringify({
          employeeId: Number(form.employeeId),
          missionDate: form.missionDate,
          missionType: form.missionType,
          startTime: isTimed ? form.startTime : null,
          endTime: isTimed ? form.endTime : null,
          destination: form.destination,
          reason: form.reason,
        }),
      });
      setForm({ ...form, destination: "", reason: "" });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function act(id: number, path: string, body?: object) {
    try {
      setError(null);
      await api(`/hr/missions/${id}/${path}`, {
        method: "PATCH",
        body: JSON.stringify(body ?? {}),
      });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const input = "border rounded px-2 py-1.5 bg-background text-sm";
  const pending = missions.filter((m) => m.status === "pending");

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="flex flex-wrap gap-2 items-end">
        <select
          className={input}
          value={form.employeeId}
          onChange={(e) => setForm({ ...form, employeeId: e.target.value })}
          required
        >
          <option value="">{t("hr.mission.pickEmployee")}</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.fullName}
            </option>
          ))}
        </select>
        <input
          type="date"
          className={input}
          value={form.missionDate}
          onChange={(e) => setForm({ ...form, missionDate: e.target.value })}
          required
        />
        <select
          className={input}
          value={form.missionType}
          onChange={(e) => setForm({ ...form, missionType: e.target.value })}
        >
          <option value="full_day">{t("hr.mission.typeFullDay")}</option>
          <option value="timed">{t("hr.mission.typeTimed")}</option>
        </select>
        {isTimed && (
          <>
            <input
              type="time"
              className={input}
              value={form.startTime}
              onChange={(e) => setForm({ ...form, startTime: e.target.value })}
              required
            />
            <input
              type="time"
              className={input}
              value={form.endTime}
              onChange={(e) => setForm({ ...form, endTime: e.target.value })}
              required
            />
          </>
        )}
        <input
          className={input}
          placeholder={t("hr.mission.destination")}
          value={form.destination}
          onChange={(e) => setForm({ ...form, destination: e.target.value })}
        />
        <input
          className={input}
          placeholder={t("hr.mission.reason")}
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
        />
        <Button type="submit">{t("hr.mission.add")}</Button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat label={t("hr.mission.total")} value={missions.length} />
        <Stat label={t("hr.mission.pending")} value={pending.length} tone="amber" />
        <Stat
          label={t("hr.mission.approved")}
          value={missions.filter((m) => m.status === "approved").length}
          tone="green"
        />
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="p-2 text-start">{t("hr.col.no")}</th>
                <th className="p-2 text-start">{t("hr.col.name")}</th>
                <th className="p-2 text-start">{t("hr.mission.date")}</th>
                <th className="p-2 text-start">{t("hr.mission.type")}</th>
                <th className="p-2 text-start">{t("hr.mission.window")}</th>
                <th className="p-2 text-start">{t("hr.mission.destination")}</th>
                <th className="p-2 text-start">{t("hr.mission.status")}</th>
                <th className="p-2 text-start">{t("hr.att.status")}</th>
              </tr>
            </thead>
            <tbody>
              {missions.map((m) => (
                <tr key={m.id} className="border-t">
                  <td className="p-2">{m.employeeNo ?? "—"}</td>
                  <td className="p-2">{m.employeeName ?? "—"}</td>
                  <td className="p-2">{m.missionDate}</td>
                  <td className="p-2">
                    {m.missionType === "full_day"
                      ? t("hr.mission.typeFullDay")
                      : t("hr.mission.typeTimed")}
                  </td>
                  <td className="p-2">
                    {m.startTime && m.endTime ? `${m.startTime} – ${m.endTime}` : "—"}
                  </td>
                  <td className="p-2">{m.destination ?? "—"}</td>
                  <td className="p-2">
                    <span
                      className={
                        m.status === "approved"
                          ? "text-green-700"
                          : m.status === "pending"
                            ? "text-amber-700"
                            : "text-red-600"
                      }
                    >
                      {t(`hr.mission.st.${m.status}`)}
                    </span>
                  </td>
                  <td className="p-2 space-x-2">
                    {m.status === "pending" && (
                      <>
                        <button
                          className="text-xs text-green-700 underline"
                          onClick={() => act(m.id, "decision", { decision: "approve" })}
                        >
                          {t("hr.mission.approve")}
                        </button>
                        <button
                          className="text-xs text-red-600 underline"
                          onClick={() => act(m.id, "decision", { decision: "reject" })}
                        >
                          {t("hr.mission.reject")}
                        </button>
                      </>
                    )}
                    {m.status === "approved" && (
                      <button
                        className="text-xs text-muted-foreground underline"
                        onClick={() => act(m.id, "cancel")}
                      >
                        {t("hr.mission.cancel")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {missions.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-muted-foreground">
                    {t("hr.mission.none")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

/** Client copy of the server rule: birth date from an Egyptian national ID. */
function birthDateFromNationalIdClient(v: string): string | null {
  if (!/^\d{14}$/.test(v)) return null;
  const century = v[0] === "2" ? 1900 : v[0] === "3" ? 2000 : null;
  if (century === null) return null;
  const year = century + Number(v.slice(1, 3));
  const month = Number(v.slice(3, 5));
  const day = Number(v.slice(5, 7));
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function LeaveTab() {
  const { t } = useLanguage();
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    employeeId: "",
    leaveTypeId: "",
    startDate: todayStr(),
    endDate: todayStr(),
    reason: "",
    certificateNote: "",
  });
  const selectedType = types.find((x) => String(x.id) === form.leaveTypeId);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [ty, rq, emp, bal] = await Promise.all([
        api<LeaveType[]>("/hr/leave-types"),
        api<LeaveRequest[]>("/hr/leave-requests"),
        api<HrEmployee[]>("/hr/employees"),
        api<{ rows: BalanceRow[] }>(`/hr/leave-balances?year=${new Date().getFullYear()}`),
      ]);
      setTypes(ty);
      setRequests(rq);
      setEmployees(emp.filter((e) => e.status === "active"));
      setBalances(bal.rows);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      setError(null);
      await api("/hr/leave-requests", {
        method: "POST",
        body: JSON.stringify({
          employeeId: Number(form.employeeId),
          leaveTypeId: Number(form.leaveTypeId),
          startDate: form.startDate,
          endDate: form.endDate,
          reason: form.reason,
          certificateNote: form.certificateNote,
        }),
      });
      setForm({ ...form, reason: "", certificateNote: "" });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function act(id: number, path: string, body?: object) {
    try {
      setError(null);
      await api(`/hr/leave-requests/${id}/${path}`, {
        method: "PATCH",
        body: JSON.stringify(body ?? {}),
      });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const input = "border rounded px-2 py-1.5 bg-background text-sm";

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="flex flex-wrap gap-2 items-end">
        <select
          className={input}
          value={form.employeeId}
          onChange={(e) => setForm({ ...form, employeeId: e.target.value })}
          required
        >
          <option value="">{t("hr.leave.pickEmployee")}</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.fullName}
            </option>
          ))}
        </select>
        <select
          className={input}
          value={form.leaveTypeId}
          onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })}
          required
        >
          <option value="">{t("hr.leave.pickType")}</option>
          {types
            .filter((x) => x.isActive)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.nameAr}
              </option>
            ))}
        </select>
        <input
          type="date"
          className={input}
          value={form.startDate}
          onChange={(e) => setForm({ ...form, startDate: e.target.value })}
          required
        />
        <input
          type="date"
          className={input}
          value={form.endDate}
          onChange={(e) => setForm({ ...form, endDate: e.target.value })}
          required
        />
        <input
          className={input}
          placeholder={t("hr.leave.reason")}
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
        />
        {selectedType?.requiresCertificate && (
          <input
            className={input}
            placeholder={t("hr.leave.certificate")}
            value={form.certificateNote}
            onChange={(e) => setForm({ ...form, certificateNote: e.target.value })}
            required
          />
        )}
        <Button type="submit">{t("hr.leave.submit")}</Button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="p-2 text-start">{t("hr.col.name")}</th>
                <th className="p-2 text-start">{t("hr.leave.type")}</th>
                <th className="p-2 text-start">{t("hr.leave.from")}</th>
                <th className="p-2 text-start">{t("hr.leave.to")}</th>
                <th className="p-2 text-start">{t("hr.leave.days")}</th>
                <th className="p-2 text-start">{t("hr.col.status")}</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2">{r.employeeName}</td>
                  <td className="p-2">{r.leaveNameAr}</td>
                  <td className="p-2">{r.startDate}</td>
                  <td className="p-2">{r.endDate}</td>
                  <td className="p-2">{Number(r.days)}</td>
                  <td className="p-2">{t(`hr.leave.status.${r.status}`)}</td>
                  <td className="p-2 text-end space-x-1 rtl:space-x-reverse">
                    {r.status === "pending" && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => act(r.id, "decision", { decision: "approve" })}
                        >
                          {t("hr.leave.approve")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => act(r.id, "decision", { decision: "reject" })}
                        >
                          {t("hr.leave.reject")}
                        </Button>
                      </>
                    )}
                    {(r.status === "pending" || r.status === "approved") && (
                      <Button size="sm" variant="outline" onClick={() => act(r.id, "cancel")}>
                        {t("hr.leave.cancel")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {requests.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-muted-foreground">
                    {t("hr.leave.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div>
        <h2 className="text-lg font-semibold mb-2">
          {t("hr.leave.balances")} {new Date().getFullYear()}
        </h2>
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="p-2 text-start">{t("hr.col.name")}</th>
                  {types[0] &&
                    balances[0]?.balances.map((b) => (
                      <th key={b.leaveTypeId} className="p-2 text-start">
                        {b.nameAr}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {balances.map((row) => (
                  <tr key={row.employeeId} className="border-t">
                    <td className="p-2">{row.fullName}</td>
                    {row.balances.map((b) => (
                      <td key={b.leaveTypeId} className="p-2">
                        {b.remaining} / {b.allocated}
                        {b.pending > 0 && (
                          <span className="text-amber-600 ms-1">
                            ({b.pending} {t("hr.leave.pendingShort")})
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface CaseRow {
  id: number;
  employeeId: number;
  title: string;
  incidentDate: string;
  status: string;
  penaltyType: string | null;
  penaltyAmount: string | null;
  decision: string | null;
}

function DisciplineTab() {
  const { t } = useLanguage();
  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    employeeId: "",
    title: "",
    incidentDate: todayStr(),
    description: "",
  });
  const [decide, setDecide] = useState<
    Record<number, { penaltyType: string; penaltyAmount: string; decision: string }>
  >({});

  const load = useCallback(async () => {
    try {
      setError(null);
      const [emp, cs] = await Promise.all([
        api<HrEmployee[]>("/hr/employees"),
        api<CaseRow[]>("/hr/cases"),
      ]);
      setEmployees(emp);
      setCases(cs);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function open(e: React.FormEvent) {
    e.preventDefault();
    try {
      setError(null);
      await api("/hr/cases", {
        method: "POST",
        body: JSON.stringify({ ...form, employeeId: Number(form.employeeId) }),
      });
      setForm({ ...form, title: "", description: "" });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function move(id: number, status: string) {
    try {
      setError(null);
      await api(`/hr/cases/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function finish(id: number) {
    const d = decide[id];
    if (!d) return;
    try {
      setError(null);
      await api(`/hr/cases/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "decided",
          penaltyType: d.penaltyType || null,
          penaltyAmount: d.penaltyAmount || null,
          decision: d.decision,
        }),
      });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const input = "border rounded px-2 py-1.5 bg-background text-sm";
  const name = (id: number) => employees.find((e) => e.id === id)?.fullName ?? "—";

  return (
    <div className="space-y-6">
      <form onSubmit={open} className="flex flex-wrap gap-2 items-end">
        <select
          className={input}
          value={form.employeeId}
          onChange={(e) => setForm({ ...form, employeeId: e.target.value })}
          required
        >
          <option value="">{t("hr.leave.pickEmployee")}</option>
          {employees
            .filter((e) => e.status === "active")
            .map((e) => (
              <option key={e.id} value={e.id}>
                {e.fullName}
              </option>
            ))}
        </select>
        <input
          className={input}
          placeholder={t("hr.case.title")}
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          required
        />
        <input
          type="date"
          className={input}
          value={form.incidentDate}
          onChange={(e) => setForm({ ...form, incidentDate: e.target.value })}
          required
        />
        <input
          className={input}
          placeholder={t("hr.case.description")}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <Button type="submit">{t("hr.case.open")}</Button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="p-2 text-start">{t("hr.col.name")}</th>
                <th className="p-2 text-start">{t("hr.case.title")}</th>
                <th className="p-2 text-start">{t("hr.leave.from")}</th>
                <th className="p-2 text-start">{t("hr.col.status")}</th>
                <th className="p-2 text-start">{t("hr.case.outcome")}</th>
                <th className="p-2 text-start">{t("hr.case.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id} className="border-t align-top">
                  <td className="p-2">{name(c.employeeId)}</td>
                  <td className="p-2">{c.title}</td>
                  <td className="p-2">{c.incidentDate}</td>
                  <td className="p-2">{t(`hr.case.status.${c.status}`)}</td>
                  <td className="p-2">
                    {c.penaltyType
                      ? `${t(`hr.case.penalty.${c.penaltyType}`)}${c.penaltyAmount ? ` (${c.penaltyAmount})` : ""}`
                      : "—"}
                  </td>
                  <td className="p-2 space-y-1">
                    {c.status === "open" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => move(c.id, "investigation")}
                      >
                        {t("hr.case.startInvestigation")}
                      </Button>
                    )}
                    {(c.status === "open" || c.status === "investigation") && (
                      <div className="flex flex-wrap gap-1">
                        <select
                          className={input}
                          value={decide[c.id]?.penaltyType ?? ""}
                          onChange={(e) =>
                            setDecide({
                              ...decide,
                              [c.id]: {
                                ...(decide[c.id] ?? { penaltyAmount: "", decision: "" }),
                                penaltyType: e.target.value,
                              },
                            })
                          }
                        >
                          <option value="">{t("hr.case.noPenalty")}</option>
                          <option value="warning">{t("hr.case.penalty.warning")}</option>
                          <option value="fine">{t("hr.case.penalty.fine")}</option>
                          <option value="suspension">{t("hr.case.penalty.suspension")}</option>
                          <option value="dismissal">{t("hr.case.penalty.dismissal")}</option>
                        </select>
                        {decide[c.id]?.penaltyType === "fine" && (
                          <input
                            className={`${input} w-24`}
                            placeholder={t("hr.case.amount")}
                            value={decide[c.id]?.penaltyAmount ?? ""}
                            onChange={(e) =>
                              setDecide({
                                ...decide,
                                [c.id]: { ...decide[c.id], penaltyAmount: e.target.value },
                              })
                            }
                          />
                        )}
                        <input
                          className={input}
                          placeholder={t("hr.case.decision")}
                          value={decide[c.id]?.decision ?? ""}
                          onChange={(e) =>
                            setDecide({
                              ...decide,
                              [c.id]: {
                                ...(decide[c.id] ?? { penaltyType: "", penaltyAmount: "" }),
                                decision: e.target.value,
                              },
                            })
                          }
                        />
                        <Button size="sm" onClick={() => finish(c.id)}>
                          {t("hr.case.decide")}
                        </Button>
                      </div>
                    )}
                    {c.status === "decided" && (
                      <Button size="sm" variant="outline" onClick={() => move(c.id, "closed")}>
                        {t("hr.case.close")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {cases.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-muted-foreground">
                    {t("hr.case.empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function OnboardTab() {
  const { t } = useLanguage();
  const empty = {
    fullName: "",
    fullNameEn: "",
    jobTitle: "",
    department: "",
    hireDate: todayStr(),
    phone: "",
    biometricPin: "",
    nationalId: "",
    dateOfBirth: "",
    gender: "",
    address: "",
    emergencyContactName: "",
    emergencyContactPhone: "",
    socialInsuranceNo: "",
    healthInsuranceNo: "",
    contractType: "indefinite",
    startDate: todayStr(),
    endDate: "",
    probationEndDate: "",
    basicSalary: "",
    allowances: "0",
    bankName: "",
    accountHolder: "",
    accountNo: "",
    iban: "",
  };
  const [f, setF] = useState(empty);
  const [photo, setPhoto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const set =
    (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(null);
    if (!findBankByName(f.bankName)) {
      setError(t("hr.onb.bankPick"));
      return;
    }
    try {
      const body = {
        photo,
        employee: {
          fullName: f.fullName,
          fullNameEn: f.fullNameEn,
          jobTitle: f.jobTitle,
          department: f.department,
          hireDate: f.hireDate,
          phone: f.phone,
          biometricPin: f.biometricPin,
        },
        profile: {
          nationalId: f.nationalId,
          gender: f.gender || null,
          address: f.address,
          emergencyContactName: f.emergencyContactName,
          emergencyContactPhone: f.emergencyContactPhone,
          socialInsuranceNo: f.socialInsuranceNo,
          healthInsuranceNo: f.healthInsuranceNo,
        },
        contract: {
          contractType: f.contractType,
          startDate: f.startDate,
          endDate: f.endDate || null,
          probationEndDate: f.probationEndDate || null,
          basicSalary: Number(f.basicSalary),
          allowances: Number(f.allowances || 0),
        },
        bank: {
          bankName: f.bankName,
          accountHolder: f.accountHolder,
          accountNo: f.accountNo,
          iban: f.iban || null,
        },
      };
      const res = await api<{ employeeNo: string }>("/hr/onboard", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setSaved(res.employeeNo);
      setF(empty);
      setPhoto(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const input = "border rounded px-2 py-1.5 bg-background text-sm w-full";
  const label = "text-xs text-muted-foreground block mb-1";
  const field = (k: keyof typeof empty, text: string, type = "text", required = false) => (
    <label className="block">
      <span className={label}>{text}</span>
      <input className={input} type={type} value={f[k]} onChange={set(k)} required={required} />
    </label>
  );

  return (
    <form onSubmit={submit} className="space-y-6">
      <p className="text-sm text-muted-foreground">{t("hr.onb.help")}</p>

      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">{t("hr.onb.sec.job")}</h2>
          <p className="text-xs text-muted-foreground">{t("hr.onb.empNoAuto")}</p>
          <PhotoPicker value={photo} onChange={setPhoto} />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {field("fullName", t("hr.col.nameAr"), "text", true)}
            {field("fullNameEn", t("hr.col.nameEn"), "text", true)}
            {field("hireDate", t("hr.onb.hireDate"), "date", true)}
            {field("jobTitle", t("hr.col.job"))}
            {field("department", t("hr.col.dept"))}
            {field("phone", t("hr.onb.phone"))}
            {field("biometricPin", t("hr.col.pin"))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">{t("hr.onb.sec.personal")}</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {field("nationalId", t("hr.onb.nationalId"), "text", true)}
            <div className="block">
              <span className={label}>{t("hr.onb.dob")}</span>
              <div className={input + " text-muted-foreground"}>
                {birthDateFromNationalIdClient(f.nationalId) ?? t("hr.onb.dobAuto")}
              </div>
            </div>
            <label className="block">
              <span className={label}>{t("hr.onb.gender")}</span>
              <select className={input} value={f.gender} onChange={set("gender")}>
                <option value="">—</option>
                <option value="male">{t("hr.onb.male")}</option>
                <option value="female">{t("hr.onb.female")}</option>
              </select>
            </label>
            {field("address", t("hr.onb.address"))}
            {field("emergencyContactName", t("hr.onb.emergencyName"))}
            {field("emergencyContactPhone", t("hr.onb.emergencyPhone"))}
            {field("socialInsuranceNo", t("hr.onb.socialIns"))}
            {field("healthInsuranceNo", t("hr.onb.healthIns"))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">{t("hr.onb.sec.contract")}</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="block">
              <span className={label}>{t("hr.onb.contractType")}</span>
              <select className={input} value={f.contractType} onChange={set("contractType")}>
                <option value="indefinite">{t("hr.onb.ct.indefinite")}</option>
                <option value="fixed">{t("hr.onb.ct.fixed")}</option>
                <option value="probation">{t("hr.onb.ct.probation")}</option>
                <option value="part_time">{t("hr.onb.ct.partTime")}</option>
              </select>
            </label>
            {field("startDate", t("hr.onb.startDate"), "date", true)}
            {field("endDate", t("hr.onb.endDate"), "date")}
            {field("probationEndDate", t("hr.onb.probationEnd"), "date")}
            {field("basicSalary", t("hr.onb.basic"), "number", true)}
            {field("allowances", t("hr.onb.allowances"), "number")}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">{t("hr.onb.sec.bank")}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <span className={label}>{t("hr.onb.bankName")}</span>
              <BankCombobox value={f.bankName} onChange={(v) => setF({ ...f, bankName: v })} />
            </div>
            {field("accountHolder", t("hr.onb.accountHolder"), "text", true)}
            {field("accountNo", t("hr.onb.accountNo"), "text", true)}
            {field("iban", t("hr.onb.iban"))}
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {saved && (
        <p className="text-sm text-green-700">
          {t("hr.onb.saved")} ({saved})
        </p>
      )}
      <Button type="submit">{t("hr.onb.submit")}</Button>
    </form>
  );
}

// ---------- الإعدادات: التأمينات والضرايب والغياب والجزاءات والبدلات والبنك ----------
// كل قيمة تتعدل في أي وقت. "غير مضبوط" معناه إن الرقم لسه ما اتدخلش، ومفيش قيمة افتراضية.

type SettingsData = Record<string, unknown>;

const numText = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const toNum = (s: string): number | null => (s.trim() === "" ? null : Number(s));

function SettingsTab() {
  const { t } = useLanguage();
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ settings: SettingsData }>("/hr/settings");
      setData(r.settings);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">{t("hr.set.loading")}</p>;

  const ins = (k: string) =>
    data[k] as {
      employeeRatePct: number | null;
      employerRatePct: number | null;
      capAmount: number | null;
    } | null;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("hr.set.help")}</p>
      <InsuranceCard
        settingKey="social_insurance"
        title={t("hr.set.social")}
        value={ins("social_insurance")}
        onSaved={load}
      />
      <InsuranceCard
        settingKey="health_insurance"
        title={t("hr.set.health")}
        value={ins("health_insurance")}
        onSaved={load}
      />
      <TaxCard
        value={data.income_tax as { brackets: { upTo: number | null; ratePct: number }[] } | null}
        onSaved={load}
      />
      <AbsenceCard
        value={data.absence as { dailyDivisor: number; weeklyOffDays: number[] } | null}
        onSaved={load}
      />
      <HolidaysCard
        value={(data as { holidays?: { date: string; name: string }[] | null }).holidays ?? null}
        onSaved={load}
      />
      <WorkShiftCard
        value={
          data.work_shift as {
            start: string;
            end: string;
            lateGraceMinutes: number;
          } | null
        }
        onSaved={load}
      />
      <FinesCard value={data.fines as { monthlyCapDays: number | null } | null} onSaved={load} />
      <AllowancesCard value={data.allowance_types as { items: string[] } | null} onSaved={load} />
      <EndOfServiceCard value={data.end_of_service as EosRule | null} onSaved={load} />
      <CardDesignCard front={data.card_front} back={data.card_back} onSaved={load} />
      <CardManagerCard
        value={data.card_manager as { name: string; signature: string | null } | null}
        onSaved={load}
      />
      <CompanyDocumentsCard
        value={data.document_company as Record<string, string> | null}
        onSaved={load}
      />
      <BankCard
        value={data.bank_export as { format: string | null; notes: string | null } | null}
        onSaved={load}
      />
    </div>
  );
}

/** Shell shared by every setting: title, configured badge, save button and result. */
function SettingCard({
  title,
  configured,
  onSave,
  onSaved,
  children,
}: {
  title: string;
  configured: boolean;
  onSave: () => Promise<void>;
  onSaved: () => void;
  children: React.ReactNode;
}) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  async function run() {
    setBusy(true);
    setErr(null);
    setOk(false);
    try {
      await onSave();
      setOk(true);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">{title}</h2>
          <span
            className={`text-xs px-2 py-0.5 rounded ${
              configured ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"
            }`}
          >
            {configured ? t("hr.set.configured") : t("hr.set.notConfigured")}
          </span>
        </div>
        {children}
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={run} disabled={busy}>
            {t("hr.set.save")}
          </Button>
          {ok && <span className="text-xs text-green-700">{t("hr.set.saved")}</span>}
          {err && <span className="text-xs text-red-600">{err}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

async function saveSetting(key: string, value: unknown) {
  await api(`/hr/settings/${key}`, { method: "PUT", body: JSON.stringify({ value }) });
}

const setInput = "border rounded px-2 py-1.5 bg-background text-sm w-full";
const setLabel = "text-xs text-muted-foreground block mb-1";

function InsuranceCard({
  settingKey,
  title,
  value,
  onSaved,
}: {
  settingKey: "social_insurance" | "health_insurance";
  title: string;
  value: {
    employeeRatePct: number | null;
    employerRatePct: number | null;
    capAmount: number | null;
  } | null;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const [emp, setEmp] = useState(numText(value?.employeeRatePct));
  const [er, setEr] = useState(numText(value?.employerRatePct));
  const [cap, setCap] = useState(numText(value?.capAmount));
  return (
    <SettingCard
      title={title}
      configured={!!value}
      onSaved={onSaved}
      onSave={() =>
        saveSetting(
          settingKey,
          toNum(emp) === null && toNum(er) === null && toNum(cap) === null
            ? null
            : { employeeRatePct: toNum(emp), employerRatePct: toNum(er), capAmount: toNum(cap) },
        )
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="block">
          <span className={setLabel}>{t("hr.set.employeeRate")}</span>
          <input
            className={setInput}
            type="number"
            step="0.01"
            value={emp}
            onChange={(e) => setEmp(e.target.value)}
          />
        </label>
        <label className="block">
          <span className={setLabel}>{t("hr.set.employerRate")}</span>
          <input
            className={setInput}
            type="number"
            step="0.01"
            value={er}
            onChange={(e) => setEr(e.target.value)}
          />
        </label>
        <label className="block">
          <span className={setLabel}>{t("hr.set.cap")}</span>
          <input
            className={setInput}
            type="number"
            step="0.01"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </label>
      </div>
    </SettingCard>
  );
}

type Bracket = { upTo: string; ratePct: string };

function TaxCard({
  value,
  onSaved,
}: {
  value: { brackets: { upTo: number | null; ratePct: number }[] } | null;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<Bracket[]>(
    value?.brackets?.length
      ? value.brackets.map((b) => ({ upTo: numText(b.upTo), ratePct: numText(b.ratePct) }))
      : [{ upTo: "", ratePct: "" }],
  );
  const update = (i: number, k: keyof Bracket, v: string) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <SettingCard
      title={t("hr.set.tax")}
      configured={!!value}
      onSaved={onSaved}
      onSave={() => {
        const filled = rows.filter((r) => r.upTo !== "" || r.ratePct !== "");
        if (filled.length === 0) return saveSetting("income_tax", null);
        return saveSetting("income_tax", {
          brackets: rows.map((r) => ({ upTo: toNum(r.upTo), ratePct: toNum(r.ratePct) })),
        });
      }}
    >
      <p className="text-xs text-muted-foreground">{t("hr.set.taxHint")}</p>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
            <label className="block">
              <span className={setLabel}>{t("hr.set.upTo")}</span>
              <input
                className={setInput}
                type="number"
                step="0.01"
                value={r.upTo}
                onChange={(e) => update(i, "upTo", e.target.value)}
              />
            </label>
            <label className="block">
              <span className={setLabel}>{t("hr.set.rate")}</span>
              <input
                className={setInput}
                type="number"
                step="0.01"
                value={r.ratePct}
                onChange={(e) => update(i, "ratePct", e.target.value)}
              />
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
              disabled={rows.length === 1}
            >
              {t("hr.set.remove")}
            </Button>
          </div>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setRows([...rows, { upTo: "", ratePct: "" }])}
      >
        {t("hr.set.addBracket")}
      </Button>
    </SettingCard>
  );
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

function HolidaysCard({
  value,
  onSaved,
}: {
  value: { date: string; name: string }[] | null;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const [rows, setRows] = useState<{ date: string; name: string }[]>(value ?? []);
  const [draft, setDraft] = useState({ date: "", name: "" });
  function add() {
    if (!draft.date || !draft.name.trim()) return;
    setRows(
      [
        ...rows.filter((x) => x.date !== draft.date),
        { date: draft.date, name: draft.name.trim() },
      ].sort((a, b) => a.date.localeCompare(b.date)),
    );
    setDraft({ date: "", name: "" });
  }
  return (
    <SettingCard
      title={t("hr.set.holidays")}
      configured={value !== null}
      onSaved={onSaved}
      onSave={() => saveSetting("holidays", rows)}
    >
      <div className="space-y-2">
        {rows.map((h) => (
          <div key={h.date} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono">{h.date}</span>
            <span>{h.name}</span>
            <Button
              size="sm"
              variant="outline"
              type="button"
              onClick={() => setRows(rows.filter((x) => x.date !== h.date))}
            >
              {t("hr.set.holidayRemove")}
            </Button>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("hr.set.holidaysNone")}</p>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <input
            type="date"
            className={setInput}
            value={draft.date}
            onChange={(e) => setDraft({ ...draft, date: e.target.value })}
          />
          <input
            className={setInput}
            placeholder={t("hr.set.holidayName")}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <Button size="sm" type="button" onClick={add}>
            {t("hr.set.holidayAdd")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("hr.set.holidaysHint")}</p>
      </div>
    </SettingCard>
  );
}

function AbsenceCard({
  value,
  onSaved,
}: {
  value: { dailyDivisor: number; weeklyOffDays: number[] } | null;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const [div, setDiv] = useState(numText(value?.dailyDivisor));
  const [offDays, setOffDays] = useState<number[]>(value?.weeklyOffDays ?? []);
  return (
    <SettingCard
      title={t("hr.set.absence")}
      configured={!!value && Array.isArray(value.weeklyOffDays)}
      onSaved={onSaved}
      onSave={() =>
        saveSetting(
          "absence",
          toNum(div) === null ? null : { dailyDivisor: toNum(div), weeklyOffDays: offDays },
        )
      }
    >
      <div className="space-y-1">
        <span className={setLabel}>{t("hr.set.weeklyOff")}</span>
        <div className="flex flex-wrap gap-3">
          {WEEKDAYS.map((d) => (
            <label key={d} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={offDays.includes(d)}
                onChange={(e) =>
                  setOffDays(
                    e.target.checked
                      ? [...offDays, d].sort((a, b) => a - b)
                      : offDays.filter((x) => x !== d),
                  )
                }
              />
              {t(`hr.day.${d}`)}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("hr.set.weeklyOffHint")}</p>
      </div>
      <label className="block max-w-xs">
        <span className={setLabel}>{t("hr.set.divisor")}</span>
        <input
          className={setInput}
          type="number"
          min="1"
          max="31"
          value={div}
          onChange={(e) => setDiv(e.target.value)}
        />
      </label>
      <p className="text-xs text-muted-foreground">{t("hr.set.divisorHint")}</p>
    </SettingCard>
  );
}

function WorkShiftCard({
  value,
  onSaved,
}: {
  value: { start: string; end: string; lateGraceMinutes: number } | null;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const [start, setStart] = useState(value?.start ?? "09:00");
  const [end, setEnd] = useState(value?.end ?? "17:00");
  const [grace, setGrace] = useState(numText(value?.lateGraceMinutes ?? 0));
  return (
    <SettingCard
      title={t("hr.set.workShift")}
      configured={!!value}
      onSaved={onSaved}
      onSave={() =>
        saveSetting("work_shift", {
          start,
          end,
          lateGraceMinutes: toNum(grace) ?? 0,
        })
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="block">
          <span className={setLabel}>{t("hr.set.shiftStart")}</span>
          <input
            className={setInput}
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label className="block">
          <span className={setLabel}>{t("hr.set.shiftEnd")}</span>
          <input
            className={setInput}
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <label className="block">
          <span className={setLabel}>{t("hr.set.shiftGrace")}</span>
          <input
            className={setInput}
            type="number"
            min="0"
            max="240"
            value={grace}
            onChange={(e) => setGrace(e.target.value)}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t("hr.set.shiftHint")}</p>
    </SettingCard>
  );
}

function FinesCard({
  value,
  onSaved,
}: {
  value: { monthlyCapDays: number | null } | null;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const [cap, setCap] = useState(numText(value?.monthlyCapDays));
  return (
    <SettingCard
      title={t("hr.set.fines")}
      configured={!!value}
      onSaved={onSaved}
      onSave={() =>
        saveSetting("fines", toNum(cap) === null ? null : { monthlyCapDays: toNum(cap) })
      }
    >
      <label className="block max-w-xs">
        <span className={setLabel}>{t("hr.set.finesCap")}</span>
        <input
          className={setInput}
          type="number"
          min="0"
          max="60"
          value={cap}
          onChange={(e) => setCap(e.target.value)}
        />
      </label>
    </SettingCard>
  );
}

function AllowancesCard({
  value,
  onSaved,
}: {
  value: { items: string[] } | null;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const [text, setText] = useState((value?.items ?? []).join("، "));
  return (
    <SettingCard
      title={t("hr.set.allowances")}
      configured={!!value}
      onSaved={onSaved}
      onSave={() =>
        saveSetting(
          "allowance_types",
          text.trim() === ""
            ? null
            : {
                items: text
                  .split(/[,،]/)
                  .map((x) => x.trim())
                  .filter(Boolean),
              },
        )
      }
    >
      <label className="block">
        <span className={setLabel}>{t("hr.set.allowList")}</span>
        <input className={setInput} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <p className="text-xs text-muted-foreground">{t("hr.set.allowHint")}</p>
    </SettingCard>
  );
}

function BankCard({
  value,
  onSaved,
}: {
  value: { format: string | null; notes: string | null } | null;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const [format, setFormat] = useState(value?.format ?? "");
  const [notes, setNotes] = useState(value?.notes ?? "");
  return (
    <SettingCard
      title={t("hr.set.bank")}
      configured={!!value}
      onSaved={onSaved}
      onSave={() =>
        saveSetting(
          "bank_export",
          format.trim() === "" && notes.trim() === "" ? null : { format, notes },
        )
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className={setLabel}>{t("hr.set.bankFormat")}</span>
          <input className={setInput} value={format} onChange={(e) => setFormat(e.target.value)} />
        </label>
        <label className="block">
          <span className={setLabel}>{t("hr.set.bankNotes")}</span>
          <input className={setInput} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
    </SettingCard>
  );
}

// ---------- الرواتب: مسير شهري بالحساب والاعتماد ----------

type PayslipRow = {
  id: number;
  employeeId: number;
  employeeNo: string;
  name: string;
  basic: number;
  allowances: number;
  bonuses: number;
  incentives: number;
  deductions: number;
  absenceDays: number;
  absenceAmount: number;
  finesApplied: number;
  finesDeferred: number;
  socialEmployee: number;
  healthEmployee: number;
  incomeTax: number;
  gross: number;
  net: number;
  deliveryStatus: string;
  deliveredAt: string | null;
  deliveryError: string | null;
  hasPhone: boolean;
};

type SendPayslipsResult = {
  sent: number;
  failed: number;
  skippedNoPhone: number;
};

/** Label + colour for a payslip's WhatsApp delivery state. */
function deliveryLabel(s: PayslipRow, t: (k: string) => string): string {
  if (s.deliveryStatus === "sent") return t("hr.pay.deliverySent");
  if (s.deliveryStatus === "failed") {
    return s.hasPhone ? t("hr.pay.deliveryFailed") : t("hr.pay.deliveryNoPhone");
  }
  return t("hr.pay.deliveryPending");
}

function deliveryClass(s: PayslipRow): string {
  if (s.deliveryStatus === "sent") return "text-green-700";
  if (s.deliveryStatus === "failed") return "text-red-600";
  return "text-muted-foreground";
}

const MISSING_SETTING_KEYS: Record<string, string> = {
  social_insurance: "hr.pay.missing.social",
  health_insurance: "hr.pay.missing.health",
  income_tax: "hr.pay.missing.tax",
  absence: "hr.pay.missing.absence",
};

function PayrollTab() {
  const { t } = useLanguage();
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [run, setRun] = useState<{ id: number; status: string } | null>(null);
  const [slips, setSlips] = useState<PayslipRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [missingNote, setMissingNote] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState<number | "all" | null>(null);
  const [sendNote, setSendNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [emps, runs] = await Promise.all([
        api<HrEmployee[]>("/hr/employees"),
        api<{ id: number; period: string; status: string }[]>(`/hr/payroll/runs?period=${period}`),
      ]);
      setEmployees(emps.filter((e) => e.status === "active"));
      if (runs.length) {
        const detail = await api<{ run: { id: number; status: string }; payslips: PayslipRow[] }>(
          `/hr/payroll/runs/${runs[0].id}`,
        );
        setRun(detail.run);
        setSlips(detail.payslips);
      } else {
        setRun(null);
        setSlips([]);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  async function calculate() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ missingSettings?: string[] }>("/hr/payroll/runs", {
        method: "POST",
        body: JSON.stringify({ period }),
      });
      setMissingNote(res.missingSettings ?? []);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!run) return;
    if (!window.confirm(t("hr.pay.confirmApprove"))) return;
    try {
      await api(`/hr/payroll/runs/${run.id}/approve`, { method: "POST" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * Send payslips over WhatsApp. `target` is "all" for the whole run, or one
   * employee id for the per-row resend. Nothing here writes to the shared
   * WhatsApp inbox — the server sends each employee their own PDF only.
   */
  async function sendPayslips(target: number | "all") {
    if (!run) return;
    if (target === "all" && !window.confirm(t("hr.pay.sendAllConfirm"))) return;
    setSending(target);
    setError(null);
    setSendNote(null);
    try {
      const res = await api<SendPayslipsResult>(`/hr/payroll/runs/${run.id}/send-payslips`, {
        method: "POST",
        body: JSON.stringify(target === "all" ? {} : { employeeIds: [target], force: true }),
      });
      setSendNote(
        t("hr.pay.sendResult", {
          sent: res.sent,
          failed: res.failed,
          noPhone: res.skippedNoPhone,
        }),
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(null);
    }
  }

  async function removeDraft() {
    if (!run) return;
    try {
      await api(`/hr/payroll/runs/${run.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const money = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const totals = slips.reduce((a, s) => ({ gross: a.gross + s.gross, net: a.net + s.net }), {
    gross: 0,
    net: 0,
  });
  const input = "border rounded px-2 py-1.5 bg-background text-sm";

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("hr.pay.help")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-xs text-muted-foreground block mb-1">{t("hr.pay.period")}</span>
          <input
            className={input}
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
        </label>
        {run && (
          <span className="text-xs px-2 py-1 rounded bg-muted">
            {run.status === "approved" ? t("hr.pay.approved") : t("hr.pay.draft")}
          </span>
        )}
        {run?.status === "approved" && (
          <a
            className="text-sm underline text-primary"
            href={`/api/hr/payroll/runs/${run.id}/bank-file`}
          >
            {t("hr.pay.bankFile")}
          </a>
        )}
      </div>

      {run?.status !== "approved" && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <h2 className="font-semibold">{t("hr.pay.absenceTitle")}</h2>
            <p className="text-xs text-muted-foreground">{t("hr.pay.absenceAuto")}</p>
            <div className="flex gap-2">
              <Button onClick={calculate} disabled={busy}>
                {run ? t("hr.pay.recalc") : t("hr.pay.calc")}
              </Button>
              {run?.status === "draft" && (
                <>
                  <Button variant="outline" onClick={approve}>
                    {t("hr.pay.approve")}
                  </Button>
                  <Button variant="outline" onClick={removeDraft}>
                    {t("hr.pay.deleteDraft")}
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {run?.status === "approved" && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <h2 className="font-semibold">{t("hr.pay.payslipsTitle")}</h2>
            <p className="text-xs text-muted-foreground">{t("hr.pay.payslipsHint")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => sendPayslips("all")} disabled={sending !== null}>
                {sending === "all" ? t("hr.pay.sending") : t("hr.pay.sendAll")}
              </Button>
              {sendNote && <span className="text-xs text-muted-foreground">{sendNote}</span>}
            </div>
          </CardContent>
        </Card>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {missingNote.length > 0 && (
        <p className="text-sm text-amber-700">
          {t("hr.pay.missingNote")}:{" "}
          {missingNote.map((k) => t(MISSING_SETTING_KEYS[k] ?? "hr.pay.missing.other")).join("، ")}
        </p>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="p-2 text-start">{t("hr.col.name")}</th>
                <th className="p-2 text-end">{t("hr.pay.basic")}</th>
                <th className="p-2 text-end">{t("hr.pay.gross")}</th>
                <th className="p-2 text-end">{t("hr.pay.absence")}</th>
                <th className="p-2 text-end">{t("hr.pay.fines")}</th>
                <th className="p-2 text-end">{t("hr.pay.insurance")}</th>
                <th className="p-2 text-end">{t("hr.pay.tax")}</th>
                <th className="p-2 text-end">{t("hr.pay.net")}</th>
                {run?.status === "approved" && (
                  <th className="p-2 text-start">{t("hr.pay.colDelivery")}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {slips.map((s) => (
                <tr key={s.id} className="border-t">
                  <td className="p-2">{s.name}</td>
                  <td className="p-2 text-end">{money(s.basic)}</td>
                  <td className="p-2 text-end">{money(s.gross)}</td>
                  <td className="p-2 text-end">
                    {s.absenceDays ? `${s.absenceDays} · ${money(s.absenceAmount)}` : "—"}
                  </td>
                  <td className="p-2 text-end">
                    {s.finesApplied ? money(s.finesApplied) : "—"}
                    {s.finesDeferred > 0 && (
                      <span className="block text-xs text-amber-600">
                        {t("hr.pay.deferred")}: {money(s.finesDeferred)}
                      </span>
                    )}
                  </td>
                  <td className="p-2 text-end">{money(s.socialEmployee + s.healthEmployee)}</td>
                  <td className="p-2 text-end">{money(s.incomeTax)}</td>
                  <td className="p-2 text-end font-semibold">{money(s.net)}</td>
                  {run?.status === "approved" && (
                    <td className="p-2 text-start">
                      <div className="flex items-center gap-2">
                        <span className={cn("text-xs", deliveryClass(s))}>
                          {deliveryLabel(s, t)}
                        </span>
                        <Button
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          onClick={() => sendPayslips(s.employeeId)}
                          disabled={sending !== null}
                        >
                          {sending === s.employeeId
                            ? t("hr.pay.sending")
                            : s.deliveryStatus === "sent"
                              ? t("hr.pay.resend")
                              : t("hr.pay.send")}
                        </Button>
                      </div>
                      {s.deliveryError && (
                        <span className="block text-xs text-red-600" title={s.deliveryError}>
                          {s.deliveryError}
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {slips.length === 0 && (
                <tr>
                  <td
                    colSpan={run?.status === "approved" ? 9 : 8}
                    className="p-6 text-center text-muted-foreground"
                  >
                    {t("hr.pay.empty")}
                  </td>
                </tr>
              )}
              {slips.length > 0 && (
                <tr className="border-t font-semibold">
                  <td className="p-2">{t("hr.pay.total")}</td>
                  <td colSpan={1} />
                  <td className="p-2 text-end">{money(totals.gross)}</td>
                  <td colSpan={4} />
                  <td className="p-2 text-end">{money(totals.net)}</td>
                  {run?.status === "approved" && <td />}
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

/** End-of-service rule as stored in Settings. */
type EosBand = { fromYears: number; pct: number };
type EosRule = {
  firstYearsDays: number;
  firstYearsLimit: number;
  laterMonthsPerYear: number;
  eligibilityByReason: Record<"resignation" | "termination" | "end_of_contract", EosBand[]>;
};
type EosBandRow = { fromYears: string; pct: string };
type EosReason = "resignation" | "termination" | "end_of_contract";
const EOS_REASONS: EosReason[] = ["resignation", "termination", "end_of_contract"];

function bandRowsFrom(bands: EosBand[] | undefined): EosBandRow[] {
  if (!bands || bands.length === 0) return [{ fromYears: "0", pct: "" }];
  return bands.map((b) => ({ fromYears: numText(b.fromYears), pct: numText(b.pct) }));
}

function EndOfServiceCard({ value, onSaved }: { value: EosRule | null; onSaved: () => void }) {
  const { t } = useLanguage();
  const [days, setDays] = useState(numText(value?.firstYearsDays));
  const [limit, setLimit] = useState(numText(value?.firstYearsLimit));
  const [months, setMonths] = useState(numText(value?.laterMonthsPerYear));
  const [bands, setBands] = useState<Record<EosReason, EosBandRow[]>>({
    resignation: bandRowsFrom(value?.eligibilityByReason?.resignation),
    termination: bandRowsFrom(value?.eligibilityByReason?.termination),
    end_of_contract: bandRowsFrom(value?.eligibilityByReason?.end_of_contract),
  });
  const setReasonRows = (k: EosReason, rows: EosBandRow[]) =>
    setBands((prev) => ({ ...prev, [k]: rows }));

  // A reason is complete when every band has numbers and one band starts at 0 years.
  const reasonComplete = (rows: EosBandRow[]) =>
    rows.every((r) => r.fromYears.trim() !== "" && r.pct.trim() !== "") &&
    rows.some((r) => toNum(r.fromYears) === 0);

  return (
    <SettingCard
      title={t("hr.set.eos")}
      configured={!!value}
      onSaved={onSaved}
      onSave={() => {
        const all =
          [days, limit, months].every((x) => x.trim() !== "") &&
          EOS_REASONS.every((k) => reasonComplete(bands[k]));
        if (!all) return saveSetting("end_of_service", null);
        const toBands = (rows: EosBandRow[]) =>
          rows
            .map((r) => ({ fromYears: Number(r.fromYears), pct: Number(r.pct) }))
            .sort((a, b) => a.fromYears - b.fromYears);
        return saveSetting("end_of_service", {
          firstYearsDays: toNum(days),
          firstYearsLimit: toNum(limit),
          laterMonthsPerYear: toNum(months),
          eligibilityByReason: {
            resignation: toBands(bands.resignation),
            termination: toBands(bands.termination),
            end_of_contract: toBands(bands.end_of_contract),
          },
        });
      }}
    >
      <p className="text-xs text-muted-foreground">{t("hr.set.eosHint")}</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label className="block">
          <span className={setLabel}>{t("hr.set.eosDays")}</span>
          <input
            className={setInput}
            type="number"
            step="0.5"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </label>
        <label className="block">
          <span className={setLabel}>{t("hr.set.eosYears")}</span>
          <input
            className={setInput}
            type="number"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
        </label>
        <label className="block">
          <span className={setLabel}>{t("hr.set.eosMonths")}</span>
          <input
            className={setInput}
            type="number"
            step="0.5"
            value={months}
            onChange={(e) => setMonths(e.target.value)}
          />
        </label>
      </div>
      <div className="space-y-4 pt-2">
        <span className={setLabel}>{t("hr.set.eosByReason")}</span>
        <p className="text-xs text-muted-foreground">{t("hr.set.eosBandsHint")}</p>
        {(
          [
            ["resignation", t("hr.set.eosResignation")],
            ["termination", t("hr.set.eosTermination")],
            ["end_of_contract", t("hr.set.eosContract")],
          ] as const
        ).map(([k, label]) => (
          <div key={k} className="rounded-md border p-3 space-y-2">
            <div className="text-sm font-medium">{label}</div>
            {bands[k].map((row, i) => (
              <div key={i} className="flex items-end gap-2">
                <label className="block flex-1">
                  <span className="text-xs text-muted-foreground block mb-1">
                    {t("hr.set.eosFromYears")}
                  </span>
                  <input
                    className={setInput}
                    type="number"
                    min={0}
                    value={row.fromYears}
                    onChange={(e) =>
                      setReasonRows(
                        k,
                        bands[k].map((r, j) => (j === i ? { ...r, fromYears: e.target.value } : r)),
                      )
                    }
                  />
                </label>
                <label className="block flex-1">
                  <span className="text-xs text-muted-foreground block mb-1">
                    {t("hr.set.eosPct")}
                  </span>
                  <input
                    className={setInput}
                    type="number"
                    min={0}
                    max={100}
                    value={row.pct}
                    onChange={(e) =>
                      setReasonRows(
                        k,
                        bands[k].map((r, j) => (j === i ? { ...r, pct: e.target.value } : r)),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="text-xs text-destructive px-2 py-2"
                  disabled={bands[k].length === 1}
                  onClick={() =>
                    setReasonRows(
                      k,
                      bands[k].filter((_, j) => j !== i),
                    )
                  }
                >
                  {t("hr.set.eosRemoveBand")}
                </button>
              </div>
            ))}
            <button
              type="button"
              className="text-xs text-primary"
              onClick={() => setReasonRows(k, [...bands[k], { fromYears: "", pct: "" }])}
            >
              + {t("hr.set.eosAddBand")}
            </button>
          </div>
        ))}
      </div>
    </SettingCard>
  );
}

// ---------- التسويات: خروج الموظف بالحساب النهائي ----------

type SettlementRow = {
  id: number;
  employeeId: number;
  name: string;
  exitDate: string;
  reason: string;
  status: string;
  total: number;
  details: {
    result: {
      years: number;
      monthlyWage: number;
      finalSalary: number;
      endOfService: number;
      unusedLeaveDays: number;
      leavePayout: number;
      deductions: number;
      total: number;
    };
  };
};

function SettlementTab() {
  const { t } = useLanguage();
  const [employees, setEmployees] = useState<HrEmployee[]>([]);
  const [rows, setRows] = useState<SettlementRow[]>([]);
  const [employeeId, setEmployeeId] = useState("");
  const [exitDate, setExitDate] = useState(todayStr());
  const [reason, setReason] = useState("resignation");
  const [eligibility, setEligibility] = useState("");
  const [deductions, setDeductions] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [emps, list] = await Promise.all([
        api<HrEmployee[]>("/hr/employees"),
        api<SettlementRow[]>("/hr/settlements"),
      ]);
      setEmployees(emps.filter((e) => e.status === "active"));
      setRows(list);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function calculate() {
    setBusy(true);
    setError(null);
    try {
      await api(`/hr/employees/${employeeId}/settlements`, {
        method: "POST",
        body: JSON.stringify({
          exitDate,
          reason,
          ...(eligibility.trim() === "" ? {} : { eligibilityPct: Number(eligibility) }),
          deductions: Number(deductions),
        }),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function approve(id: number) {
    if (!window.confirm(t("hr.set.confirmSettle"))) return;
    try {
      await api(`/hr/settlements/${id}/approve`, { method: "POST" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const money = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const input = "border rounded px-2 py-1.5 bg-background text-sm w-full";
  const draft = rows.find((r) => r.employeeId === Number(employeeId) && r.status === "draft");

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("hr.set.settleHelp")}</p>
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <label className="block md:col-span-2">
              <span className={setLabel}>{t("hr.col.name")}</span>
              <select
                className={input}
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
              >
                <option value="">—</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={setLabel}>{t("hr.set.exitDate")}</span>
              <input
                className={input}
                type="date"
                value={exitDate}
                onChange={(e) => setExitDate(e.target.value)}
              />
            </label>
            <label className="block">
              <span className={setLabel}>{t("hr.set.reason")}</span>
              <select className={input} value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="resignation">{t("hr.set.r.resignation")}</option>
                <option value="termination">{t("hr.set.r.termination")}</option>
                <option value="end_of_contract">{t("hr.set.r.end")}</option>
              </select>
            </label>
            <label className="block">
              <span className={setLabel}>{t("hr.set.eligibility")}</span>
              <input
                className={input}
                type="number"
                min={0}
                max={100}
                value={eligibility}
                placeholder={t("hr.set.eligibilityFromSettings")}
                onChange={(e) => setEligibility(e.target.value)}
              />
            </label>
          </div>
          <label className="block max-w-xs">
            <span className={setLabel}>{t("hr.set.deductions")}</span>
            <input
              className={input}
              type="number"
              min={0}
              step="0.01"
              value={deductions}
              onChange={(e) => setDeductions(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <Button onClick={calculate} disabled={busy || !employeeId}>
              {t("hr.set.calcSettle")}
            </Button>
            {draft && (
              <Button variant="outline" onClick={() => approve(draft.id)}>
                {t("hr.set.approveSettle")}
              </Button>
            )}
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="p-2 text-start">{t("hr.col.name")}</th>
                <th className="p-2 text-start">{t("hr.set.exitDate")}</th>
                <th className="p-2 text-end">{t("hr.set.years")}</th>
                <th className="p-2 text-end">{t("hr.set.finalSalary")}</th>
                <th className="p-2 text-end">{t("hr.set.eosAmount")}</th>
                <th className="p-2 text-end">{t("hr.set.leave")}</th>
                <th className="p-2 text-end">{t("hr.set.total")}</th>
                <th className="p-2 text-start">{t("hr.col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2">{r.name}</td>
                  <td className="p-2">{r.exitDate}</td>
                  <td className="p-2 text-end">{r.details.result.years}</td>
                  <td className="p-2 text-end">{money(r.details.result.finalSalary)}</td>
                  <td className="p-2 text-end">{money(r.details.result.endOfService)}</td>
                  <td className="p-2 text-end">
                    {r.details.result.unusedLeaveDays} · {money(r.details.result.leavePayout)}
                  </td>
                  <td className="p-2 text-end font-semibold">{money(r.total)}</td>
                  <td className="p-2">
                    {r.status === "approved" ? t("hr.set.approvedTag") : t("hr.pay.draft")}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-muted-foreground">
                    {t("hr.set.noSettle")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- التقارير الشهرية ----------

function ReportsTab() {
  const { t } = useLanguage();
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [year, setYear] = useState(new Date().getFullYear());
  const [head, setHead] = useState<{
    total: number;
    byStatus: Record<string, number>;
    byDepartment: { department: string; count: number }[];
  } | null>(null);
  const [pay, setPay] = useState<{
    status: string;
    employees: number;
    totals: {
      gross: number;
      net: number;
      absence: number;
      fines: number;
      finesDeferred: number;
      insurance: number;
      incomeTax: number;
    };
    byDepartment: { department: string; count: number; gross: number; net: number }[];
  } | null>(null);
  const [payMsg, setPayMsg] = useState<string | null>(null);
  const [leave, setLeave] = useState<{
    annualDays: number;
    rows: { employeeId: number; name: string; used: number; remaining: number }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<typeof head>("/hr/reports/headcount")
      .then(setHead)
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    setPayMsg(null);
    api<typeof pay>(`/hr/reports/payroll?period=${period}`)
      .then(setPay)
      .catch((e) => {
        setPay(null);
        setPayMsg((e as Error).message);
      });
  }, [period]);

  useEffect(() => {
    api<typeof leave>(`/hr/reports/leave?year=${year}`)
      .then(setLeave)
      .catch((e) => setError((e as Error).message));
  }, [year]);

  const money = (n: number) =>
    n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const input = "border rounded px-2 py-1.5 bg-background text-sm";

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("hr.rep.help")}</p>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold">{t("hr.rep.headcount")}</h2>
          {head && (
            <>
              <div className="flex flex-wrap gap-3 text-sm">
                <span>
                  {t("hr.rep.total")}: <b>{head.total}</b>
                </span>
                <span>
                  {t("hr.status.active")}: <b>{head.byStatus.active ?? 0}</b>
                </span>
                <span>
                  {t("hr.status.resigned")}: <b>{head.byStatus.resigned ?? 0}</b>
                </span>
                <span>
                  {t("hr.status.terminated")}: <b>{head.byStatus.terminated ?? 0}</b>
                </span>
              </div>
              <div className="text-sm text-muted-foreground">
                {head.byDepartment.map((d) => `${d.department}: ${d.count}`).join(" · ") || "—"}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="font-semibold">{t("hr.rep.payroll")}</h2>
            <div className="flex items-end gap-2">
              <input
                className={input}
                type="month"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
              />
              <a
                className="text-sm underline text-primary"
                href={`/api/hr/reports/payroll.csv?period=${period}`}
              >
                {t("hr.rep.csv")}
              </a>
            </div>
          </div>
          {pay ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div>
                  {t("hr.pay.gross")}: <b>{money(pay.totals.gross)}</b>
                </div>
                <div>
                  {t("hr.pay.net")}: <b>{money(pay.totals.net)}</b>
                </div>
                <div>
                  {t("hr.pay.insurance")}: <b>{money(pay.totals.insurance)}</b>
                </div>
                <div>
                  {t("hr.pay.tax")}: <b>{money(pay.totals.incomeTax)}</b>
                </div>
                <div>
                  {t("hr.pay.absence")}: <b>{money(pay.totals.absence)}</b>
                </div>
                <div>
                  {t("hr.pay.fines")}: <b>{money(pay.totals.fines)}</b>
                </div>
                <div>
                  {t("hr.pay.deferred")}: <b>{money(pay.totals.finesDeferred)}</b>
                </div>
                <div>
                  {t("hr.rep.employees")}: <b>{pay.employees}</b>
                </div>
              </div>
              <table className="w-full text-sm">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="p-2 text-start">{t("hr.col.dept")}</th>
                    <th className="p-2 text-end">{t("hr.rep.employees")}</th>
                    <th className="p-2 text-end">{t("hr.pay.gross")}</th>
                    <th className="p-2 text-end">{t("hr.pay.net")}</th>
                  </tr>
                </thead>
                <tbody>
                  {pay.byDepartment.map((d) => (
                    <tr key={d.department} className="border-t">
                      <td className="p-2">{d.department}</td>
                      <td className="p-2 text-end">{d.count}</td>
                      <td className="p-2 text-end">{money(d.gross)}</td>
                      <td className="p-2 text-end">{money(d.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{payMsg ?? t("hr.pay.empty")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-end justify-between gap-3">
            <h2 className="font-semibold">{t("hr.rep.leave")}</h2>
            <input
              className={input}
              type="number"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            />
          </div>
          {leave && (
            <table className="w-full text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="p-2 text-start">{t("hr.col.name")}</th>
                  <th className="p-2 text-end">{t("hr.rep.used")}</th>
                  <th className="p-2 text-end">{t("hr.rep.remaining")}</th>
                </tr>
              </thead>
              <tbody>
                {leave.rows.map((r) => (
                  <tr key={r.employeeId} className="border-t">
                    <td className="p-2">{r.name}</td>
                    <td className="p-2 text-end">{r.used}</td>
                    <td className="p-2 text-end">
                      {r.remaining} / {leave.annualDays}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
