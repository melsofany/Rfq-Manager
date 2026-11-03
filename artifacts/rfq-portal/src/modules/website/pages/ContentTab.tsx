/**
 * Content tab — تحرير محتوى الموقع.
 *
 * Edits the copy the public site renders: hero, about, services, contact,
 * social links and SEO. The parent owns the draft; this tab is a controlled
 * form that mutates it in place via `onChange`.
 */
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2 } from "lucide-react";
import type { WebsiteContent } from "../lib/api";

interface Props {
  content: WebsiteContent;
  disabled: boolean;
  onChange: (next: WebsiteContent) => void;
}

export default function ContentTab({ content, disabled, onChange }: Props) {
  const set = <K extends keyof WebsiteContent>(key: K, value: WebsiteContent[K]) =>
    onChange({ ...content, [key]: value });

  return (
    <div className="space-y-5">
      {/* Hero */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">القسم الرئيسي (Hero)</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2 space-y-1.5">
            <Label>العنوان الرئيسي</Label>
            <Input
              value={content.hero.headline}
              disabled={disabled}
              onChange={(e) => set("hero", { ...content.hero, headline: e.target.value })}
            />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label>العنوان الفرعي</Label>
            <Input
              value={content.hero.subheadline}
              disabled={disabled}
              onChange={(e) => set("hero", { ...content.hero, subheadline: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>نص زر الطلب</Label>
            <Input
              value={content.hero.ctaLabel}
              disabled={disabled}
              onChange={(e) => set("hero", { ...content.hero, ctaLabel: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>رابط زر الطلب</Label>
            <Input
              dir="ltr"
              value={content.hero.ctaUrl}
              disabled={disabled}
              onChange={(e) => set("hero", { ...content.hero, ctaUrl: e.target.value })}
            />
          </div>
        </CardContent>
      </Card>

      {/* About */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">من نحن</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>العنوان (عربي)</Label>
              <Input
                value={content.about.heading}
                disabled={disabled}
                onChange={(e) => set("about", { ...content.about, heading: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>العنوان (إنجليزي)</Label>
              <Input
                dir="ltr"
                value={content.about.headingEn}
                disabled={disabled}
                onChange={(e) => set("about", { ...content.about, headingEn: e.target.value })}
              />
            </div>
          </div>
          {content.about.paragraphs.map((p, i) => (
            <div key={i} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>فقرة {i + 1}</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled || content.about.paragraphs.length <= 1}
                  onClick={() =>
                    set("about", {
                      ...content.about,
                      paragraphs: content.about.paragraphs.filter((_, j) => j !== i),
                    })
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <Textarea
                rows={3}
                value={p}
                disabled={disabled}
                onChange={(e) =>
                  set("about", {
                    ...content.about,
                    paragraphs: content.about.paragraphs.map((x, j) =>
                      j === i ? e.target.value : x,
                    ),
                  })
                }
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() =>
              set("about", { ...content.about, paragraphs: [...content.about.paragraphs, ""] })
            }
          >
            <Plus className="h-4 w-4" />
            إضافة فقرة
          </Button>
        </CardContent>
      </Card>

      {/* Services */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">الخدمات</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>العنوان (عربي)</Label>
              <Input
                value={content.services.heading}
                disabled={disabled}
                onChange={(e) => set("services", { ...content.services, heading: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>العنوان (إنجليزي)</Label>
              <Input
                dir="ltr"
                value={content.services.headingEn}
                disabled={disabled}
                onChange={(e) =>
                  set("services", { ...content.services, headingEn: e.target.value })
                }
              />
            </div>
          </div>
          <div className="space-y-2">
            {content.services.items.map((item, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  placeholder="الخدمة بالعربية"
                  value={item.ar}
                  disabled={disabled}
                  onChange={(e) =>
                    set("services", {
                      ...content.services,
                      items: content.services.items.map((x, j) =>
                        j === i ? { ...x, ar: e.target.value } : x,
                      ),
                    })
                  }
                />
                <Input
                  dir="ltr"
                  placeholder="Service in English"
                  value={item.en}
                  disabled={disabled}
                  onChange={(e) =>
                    set("services", {
                      ...content.services,
                      items: content.services.items.map((x, j) =>
                        j === i ? { ...x, en: e.target.value } : x,
                      ),
                    })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    set("services", {
                      ...content.services,
                      items: content.services.items.filter((_, j) => j !== i),
                    })
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() =>
              set("services", {
                ...content.services,
                items: [...content.services.items, { ar: "", en: "" }],
              })
            }
          >
            <Plus className="h-4 w-4" />
            إضافة خدمة
          </Button>
        </CardContent>
      </Card>

      {/* Contact */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">بيانات التواصل</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>الهاتف 1</Label>
            <Input
              dir="ltr"
              value={content.contact.phone1}
              disabled={disabled}
              onChange={(e) => set("contact", { ...content.contact, phone1: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>الهاتف 2</Label>
            <Input
              dir="ltr"
              value={content.contact.phone2}
              disabled={disabled}
              onChange={(e) => set("contact", { ...content.contact, phone2: e.target.value })}
            />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label>البريد الإلكتروني</Label>
            <Input
              dir="ltr"
              value={content.contact.email}
              disabled={disabled}
              onChange={(e) => set("contact", { ...content.contact, email: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>العنوان (عربي)</Label>
            <Input
              value={content.contact.addressAr}
              disabled={disabled}
              onChange={(e) => set("contact", { ...content.contact, addressAr: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>العنوان (إنجليزي)</Label>
            <Input
              dir="ltr"
              value={content.contact.addressEn}
              disabled={disabled}
              onChange={(e) => set("contact", { ...content.contact, addressEn: e.target.value })}
            />
          </div>
          <div className="sm:col-span-2 space-y-1.5">
            <Label>رابط خريطة Google (Embed)</Label>
            <Input
              dir="ltr"
              value={content.contact.mapEmbedUrl}
              disabled={disabled}
              onChange={(e) => set("contact", { ...content.contact, mapEmbedUrl: e.target.value })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Social */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">روابط التواصل الاجتماعي</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {(
            [
              ["facebook", "فيسبوك"],
              ["linkedin", "لينكدإن"],
              ["whatsapp", "واتساب"],
              ["instagram", "إنستجرام"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="space-y-1.5">
              <Label>{label}</Label>
              <Input
                dir="ltr"
                placeholder="https://"
                value={content.social[key]}
                disabled={disabled}
                onChange={(e) => set("social", { ...content.social, [key]: e.target.value })}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* SEO */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">محركات البحث (SEO)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>عنوان الصفحة</Label>
            <Input
              value={content.seo.title}
              disabled={disabled}
              onChange={(e) => set("seo", { ...content.seo, title: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>الوصف</Label>
            <Textarea
              rows={2}
              value={content.seo.description}
              disabled={disabled}
              onChange={(e) => set("seo", { ...content.seo, description: e.target.value })}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
