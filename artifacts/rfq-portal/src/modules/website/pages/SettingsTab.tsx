/**
 * Settings tab — إعدادات الموقع.
 *
 * The kill-switch (site on/off), maintenance notice and a live preview of the
 * announcement bar. These are the switches an operator flips when something is
 * wrong, so they live apart from the copy editor.
 */
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { WebsiteContent } from "../lib/api";

interface Props {
  enabled: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string | null;
  content: WebsiteContent;
  disabled: boolean;
  onEnabled: (v: boolean) => void;
  onMaintenanceMode: (v: boolean) => void;
  onMaintenanceMessage: (v: string) => void;
  onContent: (next: WebsiteContent) => void;
}

export default function SettingsTab({
  enabled,
  maintenanceMode,
  maintenanceMessage,
  content,
  disabled,
  onEnabled,
  onMaintenanceMode,
  onMaintenanceMessage,
  onContent,
}: Props) {
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">حالة الموقع</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>تشغيل الموقع</Label>
              <p className="text-xs text-muted-foreground">
                عند الإيقاف يظهر الموقع للزوار كغير متاح مؤقتًا.
              </p>
            </div>
            <Switch checked={enabled} disabled={disabled} onCheckedChange={onEnabled} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>وضع الصيانة</Label>
              <p className="text-xs text-muted-foreground">
                يعرض رسالة صيانة مع بقاء المحتوى متاحًا للقراءة.
              </p>
            </div>
            <Switch
              checked={maintenanceMode}
              disabled={disabled}
              onCheckedChange={onMaintenanceMode}
            />
          </div>
          {maintenanceMode && (
            <div className="space-y-1.5">
              <Label>رسالة الصيانة</Label>
              <Textarea
                rows={2}
                value={maintenanceMessage ?? ""}
                disabled={disabled}
                onChange={(e) => onMaintenanceMessage(e.target.value)}
                placeholder="الموقع تحت الصيانة حاليًا. سنعود قريبًا."
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">شريط الإعلان</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>تشغيل شريط الإعلان</Label>
              <p className="text-xs text-muted-foreground">
                شريط يظهر أعلى الموقع لإعلان أو عرض.
              </p>
            </div>
            <Switch
              checked={content.announcement.enabled}
              disabled={disabled}
              onCheckedChange={(v) =>
                onContent({ ...content, announcement: { ...content.announcement, enabled: v } })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>نص الإعلان</Label>
            <Input
              value={content.announcement.text}
              disabled={disabled || !content.announcement.enabled}
              onChange={(e) =>
                onContent({
                  ...content,
                  announcement: { ...content.announcement, text: e.target.value },
                })
              }
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>نص الرابط</Label>
              <Input
                value={content.announcement.linkLabel}
                disabled={disabled || !content.announcement.enabled}
                onChange={(e) =>
                  onContent({
                    ...content,
                    announcement: { ...content.announcement, linkLabel: e.target.value },
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>رابط الإعلان</Label>
              <Input
                dir="ltr"
                value={content.announcement.linkUrl}
                disabled={disabled || !content.announcement.enabled}
                onChange={(e) =>
                  onContent({
                    ...content,
                    announcement: { ...content.announcement, linkUrl: e.target.value },
                  })
                }
              />
            </div>
          </div>
          {content.announcement.enabled && content.announcement.text && (
            <div className="rounded-md bg-primary/10 border border-primary/20 px-3 py-2 text-sm">
              معاينة: {content.announcement.text}
              {content.announcement.linkLabel && (
                <span className="text-primary underline ms-2">{content.announcement.linkLabel}</span>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
