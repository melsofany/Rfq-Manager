import { Layout } from "@/components/Layout";
import { useLanguage } from "@/contexts/LanguageContext";
import { RfqKpiSection } from "@/modules/reports/pages/analytics-sections/rfq-kpi-section";

export default function DashboardPage() {
  const { t } = useLanguage();

  return (
    <Layout>
      <div className="space-y-6 p-4 sm:p-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">{t("dashboard.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("dashboard.subtitle")}</p>
        </div>
        <RfqKpiSection />
      </div>
    </Layout>
  );
}
