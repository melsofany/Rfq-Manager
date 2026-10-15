import { useEffect, useState, useCallback } from "react";
import { Layout } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IdCard } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

type Tab = "attendance" | "employees" | "devices";

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

export default function HrPage() {
  const { t } = useLanguage();
  const [tab, setTab] = useState<Tab>("attendance");

  const tabs: { id: Tab; label: string }[] = [
    { id: "attendance", label: t("hr.tab.attendance") },
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
      setData(await api<AttendanceResponse>(`/hr/attendance?date=${date}&shiftStart=${shiftStart}`));
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
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border rounded px-2 py-1.5 bg-background" />
        </label>
        <label className="text-sm">
          <span className="block text-muted-foreground mb-1">{t("hr.att.shiftStart")}</span>
          <input type="time" value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} className="border rounded px-2 py-1.5 bg-background" />
        </label>
        <Button variant="outline" onClick={load}>{t("hr.att.refresh")}</Button>
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
                      <td className="p-2">{r.lateMinutes > 0 ? `${r.lateMinutes} ${t("hr.att.minutes")}` : "—"}</td>
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
                      <td colSpan={7} className="p-6 text-center text-muted-foreground">{t("hr.att.noEmployees")}</td>
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
  const color = tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-600" : "text-foreground";
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
  const [form, setForm] = useState({ employeeNo: "", fullName: "", department: "", jobTitle: "", biometricPin: "" });

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
        <input className={input} placeholder={t("hr.col.no")} value={form.employeeNo} onChange={(e) => setForm({ ...form, employeeNo: e.target.value })} required />
        <input className={input} placeholder={t("hr.col.name")} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} required />
        <input className={input} placeholder={t("hr.col.dept")} value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
        <input className={input} placeholder={t("hr.col.job")} value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} />
        <input className={input} placeholder={t("hr.col.pin")} value={form.biometricPin} onChange={(e) => setForm({ ...form, biometricPin: e.target.value })} />
        <Button type="submit">{t("hr.emp.add")}</Button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
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
                  <td className="p-2">{r.employeeNo}</td>
                  <td className="p-2">{r.fullName}</td>
                  <td className="p-2">{r.department ?? "—"}</td>
                  <td className="p-2">{r.jobTitle ?? "—"}</td>
                  <td className="p-2">{r.biometricPin ?? <span className="text-amber-600">{t("hr.emp.noPin")}</span>}</td>
                  <td className="p-2">{t(`hr.status.${r.status}`)}</td>
                  <td className="p-2 text-end">
                    {r.status === "active" && (
                      <Button variant="outline" size="sm" onClick={() => setStatus(r.id, "resigned")}>
                        {t("hr.emp.offboard")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-muted-foreground">{t("hr.emp.empty")}</td>
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
      await api(`/hr/devices/${encodeURIComponent(d.sn)}`, { method: "PATCH", body: JSON.stringify({ isActive: !d.isActive }) });
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
                  <td className="p-2">{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "—"}</td>
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
                  <td colSpan={4} className="p-6 text-center text-muted-foreground">{t("hr.dev.empty")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
