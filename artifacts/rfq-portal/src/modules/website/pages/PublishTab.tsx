/**
 * Publish tab — نشر الموقع.
 *
 * The site's content is live as soon as it is saved, but a change to the site's
 * CODE needs a rebuild. This tab shows the latest Render deploy and lets an
 * admin trigger one, plus the log of deploys requested from the portal.
 */
import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RefreshCw, Rocket, Loader2, AlertTriangle, ExternalLink, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";
import { apiGet, apiSend, fmtDate, type WebsiteDeployRow, type WebsiteDeployStatus } from "../lib/api";

const STATUS_LABEL: Record<string, string> = {
  requested: "مطلوب",
  building: "قيد البناء",
  live: "منشور",
  failed: "فشل",
  canceled: "ملغي",
  created: "قيد الانتظار",
  queued: "في الانتظار",
  deactivated: "متوقف",
  pre_deploy_in_progress: "قيد التجهيز",
  build_in_progress: "قيد البناء",
  update_in_progress: "قيد التحديث",
};

function statusVariant(status: string | null): "default" | "secondary" | "destructive" | "outline" {
  if (!status) return "outline";
  if (status === "live") return "default";
  if (status === "failed" || status === "canceled") return "destructive";
  if (status.includes("progress") || status === "created" || status === "queued") return "secondary";
  return "outline";
}

interface Props {
  canEdit: boolean;
  deployConfigured: boolean;
  configProblems: string[];
}

export default function PublishTab({ canEdit, deployConfigured, configProblems }: Props) {
  const [status, setStatus] = useState<WebsiteDeployStatus | null>(null);
  const [history, setHistory] = useState<WebsiteDeployRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [st, hist] = await Promise.all([
        apiGet<WebsiteDeployStatus>("/api/website/deploy-status"),
        apiGet<WebsiteDeployRow[]>("/api/website/deploy-history"),
      ]);
      setStatus(st);
      setHistory(hist);
    } catch (err) {
      toast.error(getApiErrorMessage(err, "فشل تحميل حالة النشر"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleDeploy = async (clearCache: boolean) => {
    setBusy(true);
    try {
      await apiSend("/api/website/deploy", "POST", { clearCache });
      toast.success("تم تشغيل النشر — قد يستغرق دقائق حتى ينتهي");
      await load();
    } catch (err) {
      toast.error(getApiErrorMessage(err, "فشل تشغيل النشر"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {!deployConfigured && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold">نشر الموقع غير مُهيّأ</div>
            <ul className="mt-1 list-inside list-disc">
              {configProblems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p className="mt-1 text-xs">
              المحتوى يُحفظ ويظهر على الموقع فورًا، لكن إعادة بناء الموقع تتطلب مفتاح Render ومعرّف
              الخدمة.
            </p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">آخر نشر على Render</CardTitle>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!canEdit || !deployConfigured || busy}
              onClick={() => handleDeploy(true)}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
              نشر مع مسح الكاش
            </Button>
            <Button
              size="sm"
              disabled={!canEdit || !deployConfigured || busy}
              onClick={() => handleDeploy(false)}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
              نشر الآن
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {status?.error && (
            <div className="flex items-center gap-2 text-destructive">
              <XCircle className="h-4 w-4" />
              تعذّر الاتصال بـ Render: {status.error}
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">الحالة: </span>
              {status?.status ? (
                <Badge variant={statusVariant(status.status)}>
                  {STATUS_LABEL[status.status] ?? status.status}
                </Badge>
              ) : (
                <span className="text-muted-foreground">لا يوجد</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">معرّف الخدمة: </span>
              <span className="font-mono text-xs">{status?.serviceId ?? "غير مضبوط"}</span>
            </div>
            <div className="sm:col-span-2">
              <span className="text-muted-foreground">آخر التزام: </span>
              <span className="font-mono text-xs">{status?.commitSha?.slice(0, 10) ?? "—"}</span>
              {status?.commitMessage && (
                <span className="text-muted-foreground"> — {status.commitMessage}</span>
              )}
            </div>
            <div>
              <span className="text-muted-foreground">بدأ: </span>
              {fmtDate(status?.createdAt)}
            </div>
            <div>
              <span className="text-muted-foreground">انتهى: </span>
              {fmtDate(status?.finishedAt)}
            </div>
          </div>
          {status?.url && (
            <a
              href={status.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              لوحة Render <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">سجل النشر من لوحة التحكم</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">لا يوجد سجل نشر بعد.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>التاريخ</TableHead>
                  <TableHead>الحالة</TableHead>
                  <TableHead>معرّف النشر</TableHead>
                  <TableHead>ملاحظات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap">{fmtDate(row.createdAt)}</TableCell>
                    <TableCell>
                      {row.status === "building" ? (
                        <span className="inline-flex items-center gap-1 text-amber-700">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {STATUS_LABEL[row.status] ?? row.status}
                        </span>
                      ) : row.status === "failed" ? (
                        <span className="inline-flex items-center gap-1 text-destructive">
                          <XCircle className="h-3.5 w-3.5" />
                          {STATUS_LABEL[row.status] ?? row.status}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-emerald-700">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {STATUS_LABEL[row.status] ?? row.status}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.renderDeployId?.slice(0, 12) ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.error ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
