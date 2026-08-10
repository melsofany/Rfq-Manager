import { Layout } from "@/components/Layout";
import { Users } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function CustomersPage() {
  const { t } = useLanguage();

  return (
    <Layout>
      <div className="p-4 sm:p-6 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Users size={20} className="text-primary" />
            {t("customers.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">{t("customers.subtitle")}</p>
        </div>

        <div className="bg-card border border-border rounded-lg py-16 text-center text-muted-foreground">
          <Users size={36} className="mx-auto mb-3 opacity-20" />
          <p className="text-sm font-medium">{t("customers.comingSoon")}</p>
        </div>
      </div>
    </Layout>
  );
}
