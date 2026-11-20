import { useState, type ReactNode } from "react";
import { Users, Upload, Tag, Inbox } from "lucide-react";
import { Layout } from "@/components/Layout";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { filterTabs } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import ImportSuppliersTab from "./import-tab";
import { CategoriesTab } from "./CategoriesTab";
import { SuppliersListTab } from "./list/SuppliersListTab";
import { SupplierReviewCenter } from "./review-center";

type Tab = "list" | "review" | "import" | "categories";

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "-mb-px flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export default function SuppliersPage() {
  const { t } = useLanguage();
  const { employee } = useAuth();
  const allowedTabs = filterTabs(employee?.role, employee?.permissions, "suppliers", [
    "list",
    "import",
  ] as const);
  const [activeTab, setActiveTab] = useState<Tab>(allowedTabs[0] ?? "list");
  // The API gates the writes on admin/manager. The categories tab is visible to
  // everyone; its manager-only controls are hidden for a plain viewer.
  const canManage = employee?.role === "admin" || employee?.role === "manager";
  // Reviewing ends in CREATING a supplier, so it follows the same gate as the
  // supplier write actions rather than being visible to every viewer.
  const canReview = canManage;

  return (
    <Layout>
      <nav className="border-b border-border px-4 pt-4 sm:px-6 sm:pt-6" aria-label={t("sup.title")}>
        <div className="flex gap-0">
          {allowedTabs.includes("list") && (
            <TabButton
              active={activeTab === "list"}
              onClick={() => setActiveTab("list")}
              icon={<Users size={14} />}
            >
              {t("sup.tab.list")}
            </TabButton>
          )}
          {canReview && (
            <TabButton
              active={activeTab === "review"}
              onClick={() => setActiveTab("review")}
              icon={<Inbox size={14} />}
            >
              {t("sup.tab.review")}
            </TabButton>
          )}
          {allowedTabs.includes("import") && (
            <TabButton
              active={activeTab === "import"}
              onClick={() => setActiveTab("import")}
              icon={<Upload size={14} />}
            >
              {t("sup.tab.import")}
            </TabButton>
          )}
          <TabButton
            active={activeTab === "categories"}
            onClick={() => setActiveTab("categories")}
            icon={<Tag size={14} />}
          >
            {t("sup.tab.categories")}
          </TabButton>
        </div>
      </nav>

      {activeTab === "list" && (
        <SuppliersListTab onOpenCategories={() => setActiveTab("categories")} />
      )}
      {activeTab === "review" && <SupplierReviewCenter />}
      {activeTab === "import" && <ImportSuppliersTab />}
      {activeTab === "categories" && <CategoriesTab canManage={canManage} />}
    </Layout>
  );
}
