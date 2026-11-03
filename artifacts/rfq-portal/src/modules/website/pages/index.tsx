/**
 * Website management page — إدارة الموقع الإلكتروني.
 *
 * Lives under the sidebar's «IT & Systems» group next to Integrations and
 * Backup. It is the operator's control room for the public company site:
 *
 *   • المحتوى   — edit the copy the site renders (hero, about, services, …)
 *   • الإعدادات — the site on/off switch, maintenance notice, announcement bar
 *   • النشر     — trigger a rebuild on Render and watch its status
 *   • معاينة    — a live preview of the public site
 *
 * The content itself is stored by this app and read by the site from
 * `GET /api/public/website`, so a save is live immediately; only a change to the
 * site's code needs the rebuild on the Publish tab.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Layout } from "@/components/Layout";
import { useAuth } from "@/contexts/AuthContext";
import { hasPermission } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Globe, Save, Loader2, RefreshCw, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-error";
import {
  apiGet,
  apiSend,
  fmtDate,
  type WebsiteContent,
  type WebsiteSettingsView,
} from "../lib/api";
import ContentTab from "./ContentTab";
import SettingsTab from "./SettingsTab";
import PublishTab from "./PublishTab";

type TabId = "content" | "settings" | "publish" | "preview";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "content", label: "المحتوى" },
  { id: "settings", label: "الإعدادات" },
  { id: "publish", label: "النشر" },
  { id: "preview", label: "معاينة" },
];

export default function WebsitePage() {
  const { employee } = useAuth();
  const canEdit = hasPermission(employee?.role, employee?.permissions, "website:edit");

  const [tab, setTab] = useState<TabId>("content");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<WebsiteSettingsView | null>(null);
  const [draft, setDraft] = useState<WebsiteSettingsView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await apiGet<WebsiteSettingsView>("/api/website/settings");
      setSettings(s);
      setDraft(s);
    } catch (err) {
      toast.error(getApiErrorMessage(err, "فشل تحميل إعدادات الموقع"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = useMemo(
    () => Boolean(settings && draft && JSON.stringify(settings) !== JSON.stringify(draft)),
    [settings, draft],
  );

  const setContent = (content: WebsiteContent) => {
    setDraft((d) => (d ? { ...d, content } : d));
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await apiSend<WebsiteSettingsView>("/api/website/settings", "PUT", {
        enabled: draft.enabled,
        maintenanceMode: draft.maintenanceMode,
        maintenanceMessage: draft.maintenanceMessage,
        content: draft.content,
      });
      setSettings(saved);
      setDraft(saved);
      toast.success("تم حفظ محتوى الموقع — التغييرات ظاهرة الآن على الموقع");
    } catch (err) {
      toast.error(getApiErrorMessage(err, "فشل حفظ الإعدادات"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Layout>
      <div className="space-y-6 px-4 sm:px-6 pt-4 sm:pt-6 pb-10" dir="rtl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Globe className="h-7 w-7 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">الموقع الإلكتروني</h1>
              <p className="text-sm text-muted-foreground">
                التحكم في محتوى الموقع العام للشركة ونشره
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {draft && (
              <Badge variant={draft.enabled ? "default" : "destructive"}>
                {draft.enabled ? "الموقع مُفعَّل" : "الموقع متوقف"}
              </Badge>
            )}
            {draft && draft.maintenanceMode && <Badge variant="secondary">وضع الصيانة</Badge>}
            <Button variant="ghost" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            <Button onClick={handleSave} disabled={!canEdit || !dirty || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              حفظ
            </Button>
          </div>
        </div>

        {!canEdit && (
          <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            لديك صلاحية العرض فقط. للتعديل يلزم منحك صلاحية «تعديل» على صفحة الموقع الإلكتروني.
          </div>
        )}

        {draft && (
          <p className="text-xs text-muted-foreground">
            آخر تحديث: {fmtDate(draft.updatedAt)}
            {dirty && " — لديك تغييرات غير محفوظة"}
          </p>
        )}

        {loading && !draft ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            جاري التحميل...
          </div>
        ) : draft ? (
          <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
            <TabsList className="flex-wrap h-auto">
              {TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent value="content" className="mt-4">
              <ContentTab content={draft.content} disabled={!canEdit} onChange={setContent} />
            </TabsContent>

            <TabsContent value="settings" className="mt-4">
              <SettingsTab
                enabled={draft.enabled}
                maintenanceMode={draft.maintenanceMode}
                maintenanceMessage={draft.maintenanceMessage}
                content={draft.content}
                disabled={!canEdit}
                onEnabled={(v) => setDraft((d) => (d ? { ...d, enabled: v } : d))}
                onMaintenanceMode={(v) => setDraft((d) => (d ? { ...d, maintenanceMode: v } : d))}
                onMaintenanceMessage={(v) =>
                  setDraft((d) => (d ? { ...d, maintenanceMessage: v } : d))
                }
                onContent={setContent}
              />
            </TabsContent>

            <TabsContent value="publish" className="mt-4">
              <PublishTab
                canEdit={canEdit}
                deployConfigured={draft.deployConfigured}
                configProblems={draft.deployConfigProblems}
              />
            </TabsContent>

            <TabsContent value="preview" className="mt-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    معاينة الموقع العام الحالي. تُحدَّث بعد الحفظ.
                  </p>
                  <Button variant="outline" size="sm" asChild>
                    <a href="/api/public/website" target="_blank" rel="noreferrer">
                      عرض بيانات المحتوى
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                </div>
                <div className="rounded-md border border-border overflow-hidden bg-background">
                  <iframe
                    title="Website preview"
                    src="https://cortoba-supplies-website.onrender.com"
                    className="w-full h-[70vh]"
                  />
                </div>
              </div>
            </TabsContent>
          </Tabs>
        ) : null}
      </div>
    </Layout>
  );
}
