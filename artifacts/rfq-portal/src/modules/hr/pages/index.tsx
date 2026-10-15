import { useEffect, useState, useCallback } from "react";
import { Layout } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IdCard } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

type Tab = "attendance" | "onboard" | "leave" | "discipline" | "employees" | "devices";

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
}
interface AttendanceResponse {
  date: string;
  shiftStart: string;
  totals: { employees: number; present: number; absent: number; late: number };
  rows: AttendanceRow[];
}
interface HrEmployee {
  id: number;
  employeeNo: string;
  fullName: string;
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

export default function HrPage() {
  const { t } = useLanguage();
  const [tab, setTab] = useState<Tab>("attendance");

  const tabs: { id: Tab; label: string }[] = [
    { id: "attendance", label: t("hr.tab.attendance") },
    { id: "onboard", label: t("hr.tab.onboard") },
    { id: "leave", label: t("hr.tab.leave") },
    { id: "discipline", label: t("hr.tab.discipline") },
    { id: "employees", label: t("hr.tab.employees") },
    { id: "devices", label: t("hr.tab.devices") },
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
        {tab === "discipline" && <DisciplineTab />}
        {tab === "employees" && <EmployeesTab />}
        {tab === "devices" && <DevicesTab />}
      </div>
    </Layout>
  );
}

function AttendanceTab() {
  const { t } = useLanguage();
  const [date, setDate] = useState(todayStr());
  const [shiftStart, setShiftStart] = useState("09:00");
  const [data, setData] = useState<AttendanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
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
            value={shiftStart}
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
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label={t("hr.att.total")} value={data.totals.employees} />
            <Stat label={t("hr.att.present")} value={data.totals.present} />
            <Stat label={t("hr.att.absent")} value={data.totals.absent} tone="red" />
            <Stat label={t("hr.att.late")} value={data.totals.late} tone="amber" />
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
                      <td className="p-2">{r.firstIn?.slice(0, 5) ?? "—"}</td>
                      <td className="p-2">{r.lastOut?.slice(0, 5) ?? "—"}</td>
                      <td className="p-2">
                        {r.lateMinutes > 0 ? `${r.lateMinutes} ${t("hr.att.minutes")}` : "—"}
                      </td>
                      <td className="p-2">
                        {r.absent ? (
                          <span className="text-red-600">{t("hr.att.absentLabel")}</span>
                        ) : (
                          <span className="text-green-700">{t("hr.att.presentLabel")}</span>
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

function Stat({ label, value, tone }: { label: string; value: number; tone?: "red" | "amber" }) {
  const color =
    tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : "text-foreground";
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
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    employeeNo: "",
    fullName: "",
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
      setForm({ employeeNo: "", fullName: "", department: "", jobTitle: "", biometricPin: "" });
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
          placeholder={t("hr.col.name")}
          value={form.fullName}
          onChange={(e) => setForm({ ...form, fullName: e.target.value })}
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
                <tr key={r.id} className="border-t">
                  <td className="p-2">
                    <EmployeePhoto id={r.id} />
                  </td>
                  <td className="p-2">{r.employeeNo}</td>
                  <td className="p-2">{r.fullName}</td>
                  <td className="p-2">{r.department ?? "—"}</td>
                  <td className="p-2">{r.jobTitle ?? "—"}</td>
                  <td className="p-2">
                    {r.biometricPin ?? <span className="text-amber-600">{t("hr.emp.noPin")}</span>}
                  </td>
                  <td className="p-2">{t(`hr.status.${r.status}`)}</td>
                  <td className="p-2 text-end">
                    {r.status === "active" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setStatus(r.id, "resigned")}
                      >
                        {t("hr.emp.offboard")}
                      </Button>
                    )}
                  </td>
                </tr>
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
    try {
      const body = {
        photo,
        employee: {
          fullName: f.fullName,
          jobTitle: f.jobTitle,
          department: f.department,
          hireDate: f.hireDate,
          phone: f.phone,
          biometricPin: f.biometricPin,
        },
        profile: {
          nationalId: f.nationalId,
          dateOfBirth: f.dateOfBirth || null,
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
            {field("fullName", t("hr.col.name"), "text", true)}
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
            {field("dateOfBirth", t("hr.onb.dob"), "date", true)}
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
            {field("bankName", t("hr.onb.bankName"), "text", true)}
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
