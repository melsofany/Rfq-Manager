/**
 * عناصر واجهة الحسابات المشتركة — shared presentational pieces.
 *
 * Small, dumb components the accounts pages compose: a stat card, a data table,
 * the loading / error / not-configured states, and the date-range filter bar.
 * Keeping them here means every page reports Odoo's state the same way, instead
 * of each page inventing its own spinner and error banner.
 */

import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2, RefreshCw, ServerOff } from "lucide-react";

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "positive" | "negative" | "warning";
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-600"
      : tone === "negative"
        ? "text-red-600"
        : tone === "warning"
          ? "text-amber-600"
          : "text-foreground";
  return (
    <Card className="p-4">
      <div className="text-muted-foreground text-xs mb-1">{label}</div>
      <div className={`text-xl font-bold ${toneClass}`}>{value}</div>
      {hint ? <div className="text-muted-foreground text-[11px] mt-1">{hint}</div> : null}
    </Card>
  );
}

export function Loading({ label = "جارٍ التحميل…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground text-sm">
      <Loader2 className="animate-spin" size={16} /> {label}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <AlertCircle className="text-red-500" size={24} />
      <div className="text-sm text-red-600 max-w-md">{message}</div>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry} className="gap-1.5">
          <RefreshCw size={14} /> إعادة المحاولة
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Odoo is a private service and may not be wired up yet. That is an expected
 * state, not a failure — it gets its own explanation instead of an error banner.
 */
export function NotConfigured({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <ServerOff className="text-amber-500" size={24} />
      <div className="text-sm font-medium">لم يتم ربط Odoo بعد</div>
      <p className="text-muted-foreground text-xs max-w-md leading-relaxed">
        شاشات الحسابات تقرأ من خدمة Odoo الخاصة. يجب ضبط متغيرات البيئة على خدمة الـ API:{" "}
        <code className="bg-muted px-1 rounded">ODOO_URL</code>،{" "}
        <code className="bg-muted px-1 rounded">ODOO_DB</code>،{" "}
        <code className="bg-muted px-1 rounded">ODOO_USER</code>،{" "}
        <code className="bg-muted px-1 rounded">ODOO_API_KEY</code>.
      </p>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry} className="gap-1.5">
          <RefreshCw size={14} /> إعادة المحاولة
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ message = "لا توجد بيانات" }: { message?: string }) {
  return <div className="py-10 text-center text-muted-foreground text-sm">{message}</div>;
}

/** A simple, RTL-friendly data table. */
export function DataTable({
  columns,
  rows,
  empty,
}: {
  columns: { key: string; label: string; align?: "start" | "end"; width?: string }[];
  rows: ReactNode[][];
  empty?: string;
}) {
  if (!rows.length) return <EmptyState message={empty} />;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                className={`px-3 py-2 font-medium text-muted-foreground whitespace-nowrap ${
                  c.align === "end" ? "text-end" : "text-start"
                }`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t hover:bg-muted/30">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`px-3 py-2 whitespace-nowrap ${columns[j]?.align === "end" ? "text-end" : "text-start"}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** From/To date filter shared by the statement and journal pages. */
export function DateRangeBar({
  from,
  to,
  onChange,
  onApply,
  loading,
}: {
  from: string;
  to: string;
  onChange: (next: { from: string; to: string }) => void;
  onApply: () => void;
  loading?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label className="text-muted-foreground text-xs block mb-1">من</label>
        <Input
          type="date"
          value={from}
          onChange={(e) => onChange({ from: e.target.value, to })}
          className="h-8 w-40"
        />
      </div>
      <div>
        <label className="text-muted-foreground text-xs block mb-1">إلى</label>
        <Input
          type="date"
          value={to}
          onChange={(e) => onChange({ from, to: e.target.value })}
          className="h-8 w-40"
        />
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={onApply}
        disabled={loading}
        className="gap-1.5 h-8"
      >
        {loading ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />} تطبيق
      </Button>
    </div>
  );
}

/** A page-level header with a title, subtitle and optional actions. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold text-foreground">{title}</h2>
        {subtitle ? <p className="text-muted-foreground text-xs mt-0.5">{subtitle}</p> : null}
      </div>
      {actions}
    </div>
  );
}

/** A statement section: a labelled table of accounts plus its total. */
export function StatementSectionView({
  section,
  totalLabel,
}: {
  section: {
    label: string;
    rows: { code: string; name: string; balance: number }[];
    total: number;
  };
  totalLabel: string;
}) {
  return (
    <div className="space-y-2">
      <div className="font-medium text-sm">{section.label}</div>
      <DataTable
        columns={[
          { key: "code", label: "الكود", width: "90px" },
          { key: "name", label: "الحساب" },
          { key: "amount", label: "المبلغ", align: "end" },
        ]}
        rows={section.rows.map((r) => [r.code, r.name, formatNum(r.balance)])}
        empty="لا توجد حركات في هذه الفترة"
      />
      <div className="flex justify-between text-sm font-medium border-t pt-2">
        <span>{totalLabel}</span>
        <span>{formatNum(section.total)}</span>
      </div>
    </div>
  );
}

function formatNum(n: number): string {
  return (isFinite(n) ? n : 0).toLocaleString("en-EG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
