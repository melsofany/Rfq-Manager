import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";

const statusStyles: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-600 border border-gray-200",
  SENT: "bg-blue-50 text-blue-700 border border-blue-200",
  QUOTED: "bg-orange-50 text-orange-700 border border-orange-200",
  FAILED: "bg-red-50 text-red-700 border border-red-200",
  SUCCESS: "bg-green-50 text-green-700 border border-green-200",
  draft: "bg-gray-100 text-gray-600 border border-gray-200",
  sent: "bg-blue-50 text-blue-700 border border-blue-200",
  partial: "bg-orange-50 text-orange-700 border border-orange-200",
  completed: "bg-green-50 text-green-700 border border-green-200",
  closed: "bg-slate-100 text-slate-600 border border-slate-200",
  cancelled: "bg-red-50 text-red-700 border border-red-200",
};

export function StatusBadge({ status }: { status: string }) {
  const { t } = useLanguage();
  const className = statusStyles[status] ?? "bg-gray-100 text-gray-600";
  const label = t(`status.${status}`) === `status.${status}` ? status : t(`status.${status}`);
  return (
    <span
      className={cn("inline-flex items-center px-2 py-0.5 rounded text-xs font-medium", className)}
    >
      {label}
    </span>
  );
}
