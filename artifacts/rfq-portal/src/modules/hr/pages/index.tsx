import { Layout } from "@/components/Layout";
import { Card, CardContent } from "@/components/ui/card";
import { IdCard } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function HrPage() {
  const { t } = useLanguage();

  return (
    <Layout>
      <div className="p-4 md:p-6 space-y-6">
        <div className="flex items-center gap-3">
          <IdCard className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t("hr.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("hr.subtitle")}</p>
          </div>
        </div>

        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t("hr.empty")}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
