import { cn } from "@/lib/utils";

const statusConfig: Record<string, { label: string; className: string }> = {
  // New unified status workflow
  DRAFT: { label: "مسودة", className: "bg-gray-100 text-gray-600 border border-gray-200" },
  SENT: { label: "تم الإرسال", className: "bg-blue-50 text-blue-700 border border-blue-200" },
  QUOTED: { label: "عروض واردة", className: "bg-orange-50 text-orange-700 border border-orange-200" },
  FAILED: { label: "فشل", className: "bg-red-50 text-red-700 border border-red-200" },
  SUCCESS: { label: "ناجح", className: "bg-green-50 text-green-700 border border-green-200" },
  // Legacy fallbacks
  draft: { label: "مسودة", className: "bg-gray-100 text-gray-600 border border-gray-200" },
  sent: { label: "تم الإرسال", className: "bg-blue-50 text-blue-700 border border-blue-200" },
  partial: { label: "عروض جزئية", className: "bg-orange-50 text-orange-700 border border-orange-200" },
  completed: { label: "مكتمل", className: "bg-green-50 text-green-700 border border-green-200" },
  closed: { label: "مغلق", className: "bg-slate-100 text-slate-600 border border-slate-200" },
  cancelled: { label: "ملغي", className: "bg-red-50 text-red-700 border border-red-200" },
};

export function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] ?? { label: status, className: "bg-gray-100 text-gray-600" };
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-xs font-medium", config.className)}>
      {config.label}
    </span>
  );
}
