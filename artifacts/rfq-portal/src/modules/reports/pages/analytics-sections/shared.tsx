import { ResponsiveContainer, PieChart, Pie, Cell } from "recharts";

// ────────────────── overview types ──────────────────

export function fmtMoney(v: number | null | undefined): string {
  if (v == null) return "—";
  return Number(v).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtMonth(m: string | undefined): string {
  if (!m) return "";
  const [y, mo] = m.split("-");
  const months = [
    "يناير",
    "فبراير",
    "مارس",
    "أبريل",
    "مايو",
    "يونيو",
    "يوليو",
    "أغسطس",
    "سبتمبر",
    "أكتوبر",
    "نوفمبر",
    "ديسمبر",
  ];
  return `${months[parseInt(mo, 10) - 1]} ${y}`;
}
export function timeAgo(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "الآن";
  if (mins < 60) return `منذ ${mins} دقيقة`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `منذ ${hrs} ساعة`;
  const days = Math.floor(hrs / 24);
  return `منذ ${days} يوم`;
}

// ────────────────── helpers ──────────────────
export function RateRing({ value, label, color }: { value: number; label: string; color: string }) {
  const r = 42;
  const circ = 2 * Math.PI * r;
  const offset = circ - (value / 100) * circ;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={104} height={104} viewBox="0 0 104 104">
        <circle cx={52} cy={52} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={10} />
        <circle
          cx={52}
          cy={52}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={10}
          strokeDasharray={circ}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transform: "rotate(-90deg)", transformOrigin: "52px 52px" }}
        />
        <text
          x={52}
          y={56}
          textAnchor="middle"
          fontSize={18}
          fontWeight={700}
          fill="hsl(var(--foreground))"
        >
          {value}%
        </text>
      </svg>
      <p className="text-xs text-muted-foreground text-center leading-tight">{label}</p>
    </div>
  );
}

export function KpiChip({
  label,
  value,
  icon: Icon,
  accent,
}: {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  accent: string;
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex items-center gap-3">
      <div className={`p-2 rounded-lg ${accent}`}>
        <Icon size={18} />
      </div>
      <div>
        <p className="text-xl font-bold text-foreground leading-tight">{value}</p>
        <p className="text-muted-foreground text-xs">{label}</p>
      </div>
    </div>
  );
}

export const STATUS_COLORS: Record<string, string> = {
  DRAFT: "#6b7280",
  SENT: "#3b82f6",
  QUOTED: "#f97316",
  FAILED: "#ef4444",
  SUCCESS: "#22c55e",
  draft: "#6b7280",
  sent: "#3b82f6",
  partial: "#f97316",
  completed: "#22c55e",
  closed: "#64748b",
};

export const STATUS_LABELS: Record<string, string> = {
  DRAFT: "مسودة",
  SENT: "مرسل",
  QUOTED: "مسعّر",
  FAILED: "فشل",
  SUCCESS: "ناجح",
};

export const DEEP_COLORS = [
  "#1e3a5f",
  "#0ea5e9",
  "#f59e0b",
  "#10b981",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#14b8a6",
];

// ────────────────── status distribution card ──────────────────
export function StatusDistCard({
  title,
  data,
}: {
  title: string;
  data: { status: string; count: number }[];
}) {
  const total = data.reduce((s, d) => s + d.count, 0);
  const palette = [
    "#1e3a5f",
    "#0ea5e9",
    "#f59e0b",
    "#10b981",
    "#8b5cf6",
    "#ec4899",
    "#f97316",
    "#14b8a6",
    "#6366f1",
    "#64748b",
  ];
  return (
    <div className="bg-card border border-border rounded-lg p-5">
      <h2 className="font-semibold text-sm text-foreground mb-3">{title}</h2>
      {data.length > 0 ? (
        <div className="flex items-center gap-4">
          <ResponsiveContainer width="50%" height={160}>
            <PieChart>
              <Pie
                data={data.map((d) => ({ name: d.status, value: d.count }))}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={55}
                innerRadius={28}
                paddingAngle={2}
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={palette[i % palette.length]} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="flex-1 space-y-1.5 text-xs">
            {data.map((d, i) => (
              <div key={d.status} className="flex justify-between items-center">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span
                    className="w-2.5 h-2.5 rounded-sm"
                    style={{ background: palette[i % palette.length] }}
                  />
                  {d.status}
                </span>
                <span className="font-medium text-foreground">
                  {d.count}
                  <span className="text-muted-foreground/60 mr-1">
                    {" "}
                    ({total > 0 ? Math.round((d.count / total) * 100) : 0}%)
                  </span>
                </span>
              </div>
            ))}
            <div className="flex justify-between border-t border-border pt-1.5 mt-1.5 font-medium">
              <span className="text-muted-foreground">الإجمالي</span>
              <span className="text-foreground">{total}</span>
            </div>
          </div>
        </div>
      ) : (
        <p className="text-center text-muted-foreground text-sm py-6">لا توجد بيانات</p>
      )}
    </div>
  );
}

// ────────────────── print report ──────────────────
export function printReport(html: string) {
  const win = window.open("", "_blank", "width=1100,height=800,scrollbars=yes");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.document.fonts.ready.then(() => {
    setTimeout(() => win.print(), 600);
  });
}

// ────────────────── page ──────────────────
