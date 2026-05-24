import { cn } from "@/lib/utils";

const statusConfig: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-gray-100 text-gray-600 border border-gray-200" },
  sent: { label: "Sent", className: "bg-blue-50 text-blue-700 border border-blue-200" },
  partial: { label: "Partial", className: "bg-amber-50 text-amber-700 border border-amber-200" },
  completed: { label: "Completed", className: "bg-green-50 text-green-700 border border-green-200" },
  closed: { label: "Closed", className: "bg-slate-100 text-slate-600 border border-slate-200" },
};

export function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] ?? { label: status, className: "bg-gray-100 text-gray-600" };
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-xs font-medium", config.className)}>
      {config.label}
    </span>
  );
}
