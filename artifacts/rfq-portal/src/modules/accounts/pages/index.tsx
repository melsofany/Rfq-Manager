import { useState, useEffect } from "react";
import { Layout } from "@/components/Layout";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAuth } from "@/contexts/AuthContext";
import { hasPermission } from "@/lib/permissions";
import DashboardTab from "./DashboardTab";
import FinancialStatementsTab from "./FinancialStatementsTab";
import JournalsTab from "./JournalsTab";
import AgingTab from "./AgingTab";
import TaxesTab from "./TaxesTab";
import InvoicesTab from "./InvoicesTab";
import MonthlyClosingTab from "./MonthlyClosingTab";
import ChartOfAccountsTab from "./ChartOfAccountsTab";
import SyncStatusTab from "./SyncStatusTab";

/**
 * نظام الحسابات — the accounts section.
 *
 * Every page reads from Odoo through the accounts bridge; the old RFQ ledger is
 * not consulted. The tab set mirrors the requested pages:
 *
 *   لوحة الحسابات · القوائم المالية · القيود والدفاتر · أعمار الديون ·
 *   الضرائب · الفواتير والمدفوعات · الإقفال الشهري والهوامش · دليل الحسابات ·
 *   حالة المزامنة
 *
 * Tabs are gated by the three semantic `accounts:*` permissions (records /
 * expenses / posting), NOT by the page-level `accounts` key — a manager holds
 * only the page key, so gating on the page key would hide every tab from them.
 * The selected tab is mirrored to `?tab=` so a link can deep-link into a page.
 */
const TABS = [
  { id: "dashboard", label: "لوحة الحسابات", perm: "accounts:records", Component: DashboardTab },
  {
    id: "statements",
    label: "القوائم المالية",
    perm: "accounts:posting",
    Component: FinancialStatementsTab,
  },
  { id: "journals", label: "القيود والدفاتر", perm: "accounts:posting", Component: JournalsTab },
  { id: "aging", label: "أعمار الديون", perm: "accounts:records", Component: AgingTab },
  { id: "taxes", label: "الضرائب", perm: "accounts:posting", Component: TaxesTab },
  {
    id: "invoices",
    label: "الفواتير والمدفوعات",
    perm: "accounts:records",
    Component: InvoicesTab,
  },
  {
    id: "closing",
    label: "الإقفال الشهري والهوامش",
    perm: "accounts:expenses",
    Component: MonthlyClosingTab,
  },
  { id: "coa", label: "دليل الحسابات", perm: "accounts:posting", Component: ChartOfAccountsTab },
  { id: "sync", label: "حالة المزامنة", perm: "accounts:records", Component: SyncStatusTab },
];

function tabFromUrl(): string {
  const t = new URLSearchParams(window.location.search).get("tab");
  return t ?? "dashboard";
}

export default function AccountsPage() {
  const { employee } = useAuth();
  const [tab, setTab] = useState(tabFromUrl);

  // A manager is granted the PAGE key (`accounts`) but none of its children, so
  // gating purely on the child keys would blank the page for them. A tab is
  // visible when the page itself is granted, OR the specific child key is.
  const pageGranted = hasPermission(employee?.role, employee?.permissions, "accounts");
  const visible = TABS.filter(
    (t) => pageGranted || hasPermission(employee?.role, employee?.permissions, t.perm),
  );
  const activeId = visible.some((t) => t.id === tab) ? tab : (visible[0]?.id ?? "");
  const Active = visible.find((t) => t.id === activeId)?.Component;

  useEffect(() => {
    // Keep the URL in sync so a refresh (or a shared link) reopens the same tab.
    const url = new URL(window.location.href);
    if (activeId && url.searchParams.get("tab") !== activeId) {
      url.searchParams.set("tab", activeId);
      window.history.replaceState(null, "", url.toString());
    }
  }, [activeId]);

  return (
    <Layout>
      <div className="space-y-4 px-4 sm:px-6 py-4 sm:py-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">نظام الحسابات</h1>
          <p className="text-muted-foreground text-sm">
            المصدر: Odoo — الفواتير والقيود والقوائم المالية
          </p>
        </div>

        <Tabs value={activeId} onValueChange={setTab}>
          <TabsList className="flex-wrap h-auto">
            {visible.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={activeId} className="mt-4">
            {Active ? <Active /> : null}
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
}
