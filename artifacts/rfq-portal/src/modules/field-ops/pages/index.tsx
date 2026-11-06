/**
 * صفحة التحكم في التطبيق — the operator console for the field-operations app.
 *
 * Everything the mobile app exposes is driven from here: who the field
 * representatives are, what they are assigned, temporary delegations, and the
 * app's own settings. The page is a thin client over /api/hr/field-ops/* and
 * /api/hr/field-assignments/*; every rule (active-employee gate, "must be an
 * active representative", history preservation) is enforced by the server.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  BadgeCheck,
  KeyRound,
  PackageCheck,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Smartphone,
  Truck,
  UserPlus,
  UserX,
  X,
} from "lucide-react";

// ── Types ───────────────────────────────────────────────────────────────────

type Tab = "overview" | "tasks" | "reps" | "delegations" | "settings";

interface TaskAssignee {
  id: number;
  employeeNo: string;
  fullName: string;
  eligible: boolean;
}

interface Task {
  id: number;
  kind: "receipt" | "delivery";
  status: string;
  representativeName: string;
  representativePhone: string;
  createdAt: string;
  po: { id: number; internalPoNo: string; status: string } | null;
  customerPo: {
    id: number;
    internalPoNo: string;
    customerPoNo: string;
    customerName: string | null;
  } | null;
  item: { lineItem: string | null; description: string } | null;
  supplierName: string | null;
  assignee: TaskAssignee | null;
}

interface Rep {
  id: number;
  employeeId: number;
  employeeNo: string;
  fullName: string;
  jobTitle: string | null;
  department: string | null;
  phone: string | null;
  employeeStatus: string;
  status: string;
  assignedAt: string;
  assignedByName: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  mobileAccessEnabled: boolean;
  hasPassword: boolean;
}

interface Candidate {
  id: number;
  employeeNo: string;
  fullName: string;
  jobTitle: string | null;
  department: string | null;
  phone: string | null;
  status: string;
  mobileAccessEnabled: boolean;
  isFieldRepresentative: boolean;
}

interface Delegation {
  id: number;
  assignmentId: number;
  fromHrEmployeeId: number | null;
  toHrEmployeeId: number;
  scope: string;
  issuedByName: string | null;
  reason: string | null;
  startsAt: string;
  endsAt: string | null;
  status: string;
  revokedAt: string | null;
}

interface AppSettings {
  appNameAr: string;
  appNameEn: string;
  welcomeMessageAr: string;
  supportPhone: string;
  sessionDays: number;
  autoAssignOnDispatch: boolean;
  notifyOnAssignment: boolean;
  notifyOnDeliveryAvailable: boolean;
  maintenanceMode: boolean;
}

interface Overview {
  tasks: {
    total: number;
    receipt: number;
    delivery: number;
    open: number;
    unassigned: number;
    completed: number;
  };
  representatives: { total: number; active: number; withAppAccess: number; blocked: number };
  activeSessions: number;
  settings: AppSettings;
}

// ── API helper ──────────────────────────────────────────────────────────────

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

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const STATUS_TONE: Record<string, string> = {
  sent: "bg-amber-100 text-amber-800 border-amber-200",
  assigned: "bg-amber-100 text-amber-800 border-amber-200",
  in_progress: "bg-blue-100 text-blue-800 border-blue-200",
  in_transit: "bg-blue-100 text-blue-800 border-blue-200",
  partial: "bg-orange-100 text-orange-800 border-orange-200",
  received: "bg-emerald-100 text-emerald-800 border-emerald-200",
  delivered: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected: "bg-rose-100 text-rose-800 border-rose-200",
  cancelled: "bg-slate-100 text-slate-600 border-slate-200",
};

/** camelCase a status token so it maps onto the `fieldOps.status*` i18n keys. */
function statusKey(status: string): string {
  const camel = status.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return `fieldOps.status${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function FieldOpsPage() {
  const { t } = useLanguage();
  const [tab, setTab] = useState<Tab>("overview");

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: t("fieldOps.tab.overview") },
    { id: "tasks", label: t("fieldOps.tab.tasks") },
    { id: "reps", label: t("fieldOps.tab.reps") },
    { id: "delegations", label: t("fieldOps.tab.delegations") },
    { id: "settings", label: t("fieldOps.tab.settings") },
  ];

  return (
    <Layout>
      <div className="p-4 md:p-6 space-y-6">
        <div className="flex items-center gap-3">
          <Smartphone className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t("fieldOps.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("fieldOps.subtitle")}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 border-b">
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

        {tab === "overview" && <OverviewTab />}
        {tab === "tasks" && <TasksTab />}
        {tab === "reps" && <RepsTab />}
        {tab === "delegations" && <DelegationsTab />}
        {tab === "settings" && <SettingsTab />}
      </div>
    </Layout>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      {error}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className={cn("text-2xl font-bold", tone ?? "text-foreground")}>{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{label}</div>
    </div>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

function OverviewTab() {
  const { t } = useLanguage();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Overview>("/hr/field-ops/overview")
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <ErrorLine error={error} />;
  if (!data) return <div className="text-sm text-muted-foreground">{t("common.loading")}</div>;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">{t("fieldOps.tab.tasks")}</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label={t("fieldOps.taskTotal")} value={data.tasks.total} />
          <Stat label={t("fieldOps.taskOpen")} value={data.tasks.open} tone="text-amber-600" />
          <Stat
            label={t("fieldOps.taskUnassigned")}
            value={data.tasks.unassigned}
            tone={data.tasks.unassigned > 0 ? "text-rose-600" : undefined}
          />
          <Stat
            label={t("fieldOps.taskCompleted")}
            value={data.tasks.completed}
            tone="text-emerald-600"
          />
          <Stat label={t("fieldOps.taskReceipt")} value={data.tasks.receipt} />
          <Stat label={t("fieldOps.taskDelivery")} value={data.tasks.delivery} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">{t("fieldOps.reps")}</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label={t("fieldOps.repsActive")} value={data.representatives.active} />
          <Stat label={t("fieldOps.repsWithAccess")} value={data.representatives.withAppAccess} />
          <Stat
            label={t("fieldOps.repsBlocked")}
            value={data.representatives.blocked}
            tone={data.representatives.blocked > 0 ? "text-rose-600" : undefined}
          />
          <Stat label={t("fieldOps.activeSessions")} value={data.activeSessions} />
        </div>
      </section>

      <section className="rounded-lg border bg-card p-4 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <Settings2 className="h-4 w-4 text-primary" />
          {t("fieldOps.settingsTitle")}
        </div>
        <div className="mt-2 grid gap-1 text-muted-foreground">
          <div>
            {t("fieldOps.setAppNameAr")}:{" "}
            <span className="text-foreground">{data.settings.appNameAr}</span>
          </div>
          <div>
            {t("fieldOps.setSessionDays")}:{" "}
            <span className="text-foreground">{data.settings.sessionDays}</span>
          </div>
          <div>
            {t("fieldOps.setAutoAssign")}:{" "}
            <span className="text-foreground">
              {data.settings.autoAssignOnDispatch ? "✓" : "✗"}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

// ── Tasks ───────────────────────────────────────────────────────────────────

function TasksTab() {
  const { t } = useLanguage();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [reps, setReps] = useState<Rep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("open");
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [q, setQ] = useState("");
  const [assignTarget, setAssignTarget] = useState<Task | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Task | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (kind) params.set("kind", kind);
      if (status) params.set("status", status);
      if (unassignedOnly) params.set("unassigned", "true");
      const r = await api<{ tasks: Task[] }>(`/hr/field-ops/tasks?${params.toString()}`);
      setTasks(r.tasks);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [kind, status, unassignedOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api<Rep[]>("/hr/field-assignments?active=true")
      .then(setReps)
      .catch(() => setReps([]));
  }, []);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return tasks;
    return tasks.filter((x) =>
      [
        x.po?.internalPoNo,
        x.customerPo?.customerPoNo,
        x.customerPo?.customerName,
        x.supplierName,
        x.assignee?.fullName,
        x.assignee?.employeeNo,
        x.item?.description,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [tasks, q]);

  async function unassign(task: Task) {
    setError(null);
    try {
      await api(`/hr/field-ops/tasks/${task.id}/unassign`, { method: "POST" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <ErrorLine error={error} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("common.search")}
            className="w-56"
          />
        </div>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">{t("fieldOps.filterAll")}</option>
          <option value="receipt">{t("fieldOps.taskReceipt")}</option>
          <option value="delivery">{t("fieldOps.taskDelivery")}</option>
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="">{t("fieldOps.filterAll")}</option>
          <option value="open">{t("fieldOps.filterOpen")}</option>
          <option value="closed">{t("fieldOps.filterClosed")}</option>
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={unassignedOnly}
            onChange={(e) => setUnassignedOnly(e.target.checked)}
          />
          {t("fieldOps.filterUnassigned")}
        </label>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : visible.length === 0 ? (
        <div className="text-sm text-muted-foreground">{t("fieldOps.noTasks")}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.colKind")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.colRef")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.colItem")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.colRep")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.colStatus")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.colDate")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((task) => {
                const closed = ["received", "delivered", "rejected", "cancelled"].includes(
                  task.status,
                );
                return (
                  <tr key={task.id} className="border-t">
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1">
                        {task.kind === "receipt" ? (
                          <PackageCheck className="h-4 w-4 text-primary" />
                        ) : (
                          <Truck className="h-4 w-4 text-emerald-600" />
                        )}
                        {task.kind === "receipt"
                          ? t("fieldOps.kindReceipt")
                          : t("fieldOps.kindDelivery")}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">
                        {task.customerPo?.customerPoNo ?? task.po?.internalPoNo ?? "—"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {task.supplierName ??
                          task.customerPo?.customerName ??
                          task.po?.internalPoNo ??
                          ""}
                      </div>
                    </td>
                    <td className="px-3 py-2 max-w-[22rem] truncate">
                      {task.item?.description ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      {task.assignee ? (
                        <span className={cn(task.assignee.eligible ? "" : "text-rose-600")}>
                          {task.assignee.fullName}
                          <span className="block text-xs text-muted-foreground">
                            {task.assignee.employeeNo}
                            {!task.assignee.eligible ? " — غير مؤهل" : ""}
                          </span>
                        </span>
                      ) : (
                        <span className="text-rose-600">{t("fieldOps.taskUnassigned")}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        variant="outline"
                        className={cn("border", STATUS_TONE[task.status] ?? "")}
                      >
                        {t(statusKey(task.status))}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {fmtDate(task.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={closed}
                          onClick={() => setAssignTarget(task)}
                        >
                          <Send className="h-3.5 w-3.5" />
                          {task.assignee ? t("fieldOps.reassign") : t("fieldOps.assign")}
                        </Button>
                        {task.assignee && !closed && (
                          <Button variant="ghost" size="sm" onClick={() => void unassign(task)}>
                            <UserX className="h-3.5 w-3.5" />
                            {t("fieldOps.unassign")}
                          </Button>
                        )}
                        {!closed && (
                          <Button variant="ghost" size="sm" onClick={() => setCancelTarget(task)}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AssignDialog
        task={assignTarget}
        reps={reps}
        onClose={() => setAssignTarget(null)}
        onDone={() => {
          setAssignTarget(null);
          void load();
        }}
      />
      <CancelDialog
        task={cancelTarget}
        onClose={() => setCancelTarget(null)}
        onDone={() => {
          setCancelTarget(null);
          void load();
        }}
      />
    </div>
  );
}

function AssignDialog({
  task,
  reps,
  onClose,
  onDone,
}: {
  task: Task | null;
  reps: Rep[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLanguage();
  const [repId, setRepId] = useState("");
  const [reason, setReason] = useState("");
  const [cascade, setCascade] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRepId("");
    setReason("");
    setCascade(true);
    setError(null);
  }, [task?.id]);

  async function submit() {
    if (!task || !repId) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/hr/field-ops/tasks/${task.id}/assign`, {
        method: "POST",
        body: JSON.stringify({
          hrEmployeeId: Number(repId),
          reason: reason.trim() || undefined,
          cascadePo: cascade,
        }),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={task !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("fieldOps.assignTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ErrorLine error={error} />
          {task && (
            <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
              <div className="font-medium">
                {task.customerPo?.customerPoNo ?? task.po?.internalPoNo ?? `#${task.id}`}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {task.item?.description ?? ""}
              </div>
            </div>
          )}
          <div className="space-y-1">
            <Label>{t("fieldOps.assignTo")}</Label>
            <select
              value={repId}
              onChange={(e) => setRepId(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t("fieldOps.pickRep")}</option>
              {reps.map((r) => (
                <option key={r.employeeId} value={r.employeeId}>
                  {r.fullName} — {r.employeeNo}
                  {r.department ? ` (${r.department})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>{t("fieldOps.assignReason")}</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {task?.kind === "receipt" && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={cascade}
                onChange={(e) => setCascade(e.target.checked)}
              />
              {t("fieldOps.cascadePo")}
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={!repId || saving}>
            {t("fieldOps.assign")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelDialog({
  task,
  onClose,
  onDone,
}: {
  task: Task | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLanguage();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReason("");
    setError(null);
  }, [task?.id]);

  async function submit() {
    if (!task) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/hr/field-ops/tasks/${task.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={task !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("fieldOps.cancelTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ErrorLine error={error} />
          <div className="space-y-1">
            <Label>{t("fieldOps.cancelReason")}</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={() => void submit()} disabled={saving}>
            {t("fieldOps.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Representatives ─────────────────────────────────────────────────────────

function RepsTab() {
  const { t } = useLanguage();
  const [reps, setReps] = useState<Rep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Rep | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<Rep | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReps(await api<Rep[]>("/hr/field-assignments"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleAccess(rep: Rep) {
    setError(null);
    try {
      await api(`/hr/field-assignments/${rep.id}/mobile-access`, {
        method: "POST",
        body: JSON.stringify({ enabled: !rep.mobileAccessEnabled }),
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <ErrorLine error={error} />
      <div className="flex justify-end">
        <Button onClick={() => setAddOpen(true)}>
          <UserPlus className="h-4 w-4" />
          {t("fieldOps.addRep")}
        </Button>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : reps.length === 0 ? (
        <div className="text-sm text-muted-foreground">{t("fieldOps.noCandidates")}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.repNo")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.repName")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.repDept")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.repPhone")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.colStatus")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.repAccess")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {reps.map((rep) => {
                const active = rep.status === "active";
                return (
                  <tr key={rep.id} className={cn("border-t", !active && "opacity-60")}>
                    <td className="px-3 py-2 font-mono text-xs">{rep.employeeNo}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{rep.fullName}</div>
                      {rep.jobTitle && (
                        <div className="text-xs text-muted-foreground">{rep.jobTitle}</div>
                      )}
                    </td>
                    <td className="px-3 py-2">{rep.department ?? "—"}</td>
                    <td className="px-3 py-2" dir="ltr">
                      {rep.phone ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      {active ? (
                        <Badge
                          variant="outline"
                          className="border-emerald-200 bg-emerald-100 text-emerald-800"
                        >
                          {t("common.active")}
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-slate-200 bg-slate-100 text-slate-600"
                        >
                          {t("fieldOps.revokeRep")}
                        </Badge>
                      )}
                      {rep.employeeStatus !== "active" && (
                        <div className="mt-1 text-xs text-rose-600">{t("common.inactive")}</div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {rep.mobileAccessEnabled ? (
                        <BadgeCheck className="h-5 w-5 text-emerald-600" />
                      ) : (
                        <X className="h-5 w-5 text-rose-500" />
                      )}
                      {rep.hasPassword && (
                        <span
                          className="ms-1 text-xs text-muted-foreground"
                          title={t("fieldOps.repPassword")}
                        >
                          <KeyRound className="inline h-3.5 w-3.5" />
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {active && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void toggleAccess(rep)}
                            >
                              {rep.mobileAccessEnabled
                                ? t("fieldOps.disableAccess")
                                : t("fieldOps.enableAccess")}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setPasswordTarget(rep)}
                            >
                              <KeyRound className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(rep)}>
                              <UserX className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AddRepDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onDone={() => {
          setAddOpen(false);
          void load();
        }}
      />
      <RevokeDialog
        rep={revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onDone={() => {
          setRevokeTarget(null);
          void load();
        }}
      />
      <PasswordDialog
        rep={passwordTarget}
        onClose={() => setPasswordTarget(null)}
        onDone={() => {
          setPasswordTarget(null);
          void load();
        }}
      />
    </div>
  );
}

function AddRepDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLanguage();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSelected(null);
    setPassword("");
    setError(null);
    api<Candidate[]>("/hr/field-assignments/candidates")
      .then(setCandidates)
      .catch((e: Error) => setError(e.message));
  }, [open]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const base = candidates.filter((c) => !c.isFieldRepresentative);
    if (!needle) return base;
    return base.filter((c) =>
      `${c.fullName} ${c.employeeNo} ${c.department ?? ""}`.toLowerCase().includes(needle),
    );
  }, [candidates, q]);

  async function submit() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await api("/hr/field-assignments", {
        method: "POST",
        body: JSON.stringify({
          employeeId: selected.id,
          password: password.trim() || undefined,
        }),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("fieldOps.candidatesTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ErrorLine error={error} />
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("fieldOps.candidatesSearch")}
            />
          </div>
          <div className="max-h-64 overflow-y-auto rounded-md border divide-y">
            {visible.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground">{t("fieldOps.noCandidates")}</div>
            ) : (
              visible.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelected(c)}
                  className={cn(
                    "flex w-full items-center justify-between px-3 py-2 text-start text-sm hover:bg-muted/50",
                    selected?.id === c.id && "bg-muted",
                  )}
                >
                  <span>
                    <span className="font-medium">{c.fullName}</span>
                    <span className="block text-xs text-muted-foreground">
                      {c.employeeNo}
                      {c.department ? ` — ${c.department}` : ""}
                    </span>
                  </span>
                  {selected?.id === c.id && <BadgeCheck className="h-4 w-4 text-primary" />}
                </button>
              ))
            )}
          </div>
          {selected && (
            <div className="space-y-1">
              <Label>{t("fieldOps.newPassword")}</Label>
              <Input
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("fieldOps.passwordHint")}
              />
              <p className="text-xs text-muted-foreground">{t("fieldOps.passwordHint")}</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={!selected || saving}>
            {t("fieldOps.addRep")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({
  rep,
  onClose,
  onDone,
}: {
  rep: Rep | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLanguage();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReason("");
    setError(null);
  }, [rep?.id]);

  async function submit() {
    if (!rep) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/hr/field-assignments/${rep.id}/revoke`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={rep !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("fieldOps.revokeTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ErrorLine error={error} />
          <p className="text-sm text-muted-foreground">{t("fieldOps.revokeWarning")}</p>
          <div className="space-y-1">
            <Label>{t("fieldOps.revokeReason")}</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={() => void submit()} disabled={saving}>
            {t("fieldOps.revokeRep")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PasswordDialog({
  rep,
  onClose,
  onDone,
}: {
  rep: Rep | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLanguage();
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPassword("");
    setError(null);
  }, [rep?.id]);

  async function submit() {
    if (!rep) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/hr/field-assignments/${rep.id}/password`, {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={rep !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("fieldOps.setPassword")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <ErrorLine error={error} />
          {rep && (
            <div className="text-sm">
              <span className="font-medium">{rep.fullName}</span> — {rep.employeeNo}
            </div>
          )}
          <div className="space-y-1">
            <Label>{t("fieldOps.newPassword")}</Label>
            <Input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("fieldOps.passwordHint")}
            />
            <p className="text-xs text-muted-foreground">{t("fieldOps.passwordHint")}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={password.length < 6 || saving}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Delegations ─────────────────────────────────────────────────────────────

function DelegationsTab() {
  const { t } = useLanguage();
  const [items, setItems] = useState<Delegation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await api<Delegation[]>("/hr/delegations"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: number) {
    setError(null);
    try {
      await api(`/hr/delegations/${id}/revoke`, { method: "POST" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <ErrorLine error={error} />
      {loading ? (
        <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-muted-foreground">{t("fieldOps.noDelegations")}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-start font-medium">#</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.delegFrom")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.delegTo")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.delegScope")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.delegStatus")}</th>
                <th className="px-3 py-2 text-start font-medium">{t("fieldOps.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">#{d.assignmentId}</td>
                  <td className="px-3 py-2">{d.fromHrEmployeeId ?? "—"}</td>
                  <td className="px-3 py-2">{d.toHrEmployeeId}</td>
                  <td className="px-3 py-2">{d.scope}</td>
                  <td className="px-3 py-2">
                    <Badge
                      variant="outline"
                      className={
                        d.status === "active"
                          ? "border-emerald-200 bg-emerald-100 text-emerald-800"
                          : "border-slate-200 bg-slate-100 text-slate-600"
                      }
                    >
                      {d.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    {d.status === "active" && (
                      <Button variant="ghost" size="sm" onClick={() => void revoke(d.id)}>
                        {t("fieldOps.delegRevoke")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

function SettingsTab() {
  const { t } = useLanguage();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [defaults, setDefaults] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ settings: AppSettings; defaults: AppSettings }>("/hr/field-ops/settings")
      .then((r) => {
        setSettings(r.settings);
        setDefaults(r.defaults);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  function patch<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((s) => (s ? { ...s, [key]: value } : s));
    setSaved(false);
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ settings: AppSettings }>("/hr/field-ops/settings", {
        method: "PUT",
        body: JSON.stringify({ settings }),
      });
      setSettings(r.settings);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (error && !settings) return <ErrorLine error={error} />;
  if (!settings) return <div className="text-sm text-muted-foreground">{t("common.loading")}</div>;

  const toggles: { key: keyof AppSettings; label: string }[] = [
    { key: "autoAssignOnDispatch", label: t("fieldOps.setAutoAssign") },
    { key: "notifyOnAssignment", label: t("fieldOps.setNotifyAssign") },
    { key: "notifyOnDeliveryAvailable", label: t("fieldOps.setNotifyDelivery") },
    { key: "maintenanceMode", label: t("fieldOps.setMaintenance") },
  ];

  return (
    <div className="max-w-2xl space-y-6">
      <ErrorLine error={error} />
      <section className="space-y-4 rounded-lg border bg-card p-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1">
            <Label>{t("fieldOps.setAppNameAr")}</Label>
            <Input
              value={settings.appNameAr}
              onChange={(e) => patch("appNameAr", e.target.value)}
              dir="rtl"
            />
          </div>
          <div className="space-y-1">
            <Label>{t("fieldOps.setAppNameEn")}</Label>
            <Input
              value={settings.appNameEn}
              onChange={(e) => patch("appNameEn", e.target.value)}
              dir="ltr"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label>{t("fieldOps.setWelcome")}</Label>
          <Input
            value={settings.welcomeMessageAr}
            onChange={(e) => patch("welcomeMessageAr", e.target.value)}
            dir="rtl"
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1">
            <Label>{t("fieldOps.setSupport")}</Label>
            <Input
              value={settings.supportPhone}
              onChange={(e) => patch("supportPhone", e.target.value)}
              dir="ltr"
            />
          </div>
          <div className="space-y-1">
            <Label>{t("fieldOps.setSessionDays")}</Label>
            <Input
              type="number"
              min={1}
              max={365}
              value={settings.sessionDays}
              onChange={(e) => patch("sessionDays", Number(e.target.value))}
            />
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border bg-card p-4">
        {toggles.map((row) => (
          <label key={row.key} className="flex items-center justify-between gap-4 text-sm">
            <span>{row.label}</span>
            <input
              type="checkbox"
              checked={Boolean(settings[row.key])}
              onChange={(e) => patch(row.key, e.target.checked as never)}
            />
          </label>
        ))}
      </section>

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving}>
          {t("common.save")}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            if (defaults) {
              setSettings(defaults);
              setSaved(false);
            }
          }}
        >
          {t("fieldOps.resetDefaults")}
        </Button>
        {saved && <span className="text-sm text-emerald-600">{t("fieldOps.saved")}</span>}
      </div>
    </div>
  );
}
