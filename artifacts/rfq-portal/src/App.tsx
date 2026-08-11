import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { LanguageProvider } from "@/contexts/LanguageContext";

// ── Shared pages (no module home) ─────────────────────────────────────────
import NotFound from "@/pages/not-found";
import DashboardPage from "@/pages/dashboard";

// ── Module: RFQ — طلبات عروض الأسعار ──────────────────────────────────────
import RfqListPage from "@/modules/rfq/pages/index";
import NewRfqPage from "@/modules/rfq/pages/new";
import RfqDetailPage from "@/modules/rfq/pages/detail";
import SendRfqPage from "@/modules/rfq/pages/send";

// ── Module: PO — أوامر الشراء ──────────────────────────────────────────────
import PurchaseOrdersPage from "@/modules/po/pages/index";
import NewPurchaseOrderPage from "@/modules/po/pages/new";
import PurchaseOrderDetailPage from "@/modules/po/pages/detail";

// ── Module: Users — المستخدمون والموردون ──────────────────────────────────
import LoginPage from "@/modules/users/pages/login";
import EmployeesPage from "@/modules/users/pages/employees";
import PricingPage from "@/modules/users/pages/pricing";
import SuppliersPage from "@/modules/users/pages/suppliers/index";
import NewSupplierPage from "@/modules/users/pages/suppliers/new";
import SupplierDetailPage from "@/modules/users/pages/suppliers/detail";

// ── Module: Reports — التقارير والتحليلات ─────────────────────────────────
import AnalyticsPage from "@/modules/reports/pages/analytics";
import AuditPage from "@/modules/reports/pages/audit";
import ItemsPage from "@/modules/reports/pages/items";

// ── Module: Communications — التواصل ──────────────────────────────────────
import WhatsAppPage from "@/modules/communications/pages/index";

// ── Module: Integrations — تكاملات ERP ────────────────────────────────────
import IntegrationsPage from "@/modules/integrations/pages/index";
import ConnectPopupPage from "@/modules/integrations/pages/connect";

// ── Module: Customers — العملاء ────────────────────────────────────────────
import CustomersPage from "@/modules/customers/pages/index";
import NewCustomerPage from "@/modules/customers/pages/new";
import CustomerDetailPage from "@/modules/customers/pages/detail";
import CustomerRfqPage from "@/modules/customer-rfq/pages/index";
import NewCustomerRfqPage from "@/modules/customer-rfq/pages/new";
import CustomerRfqDetailPage from "@/modules/customer-rfq/pages/detail";
import CustomerPoPage from "@/modules/customer-po/pages/index";
import NewCustomerPoPage from "@/modules/customer-po/pages/new";
import CustomerPoDetailPage from "@/modules/customer-po/pages/detail";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error: unknown) => {
        const status = (error as { status?: number })?.status;
        if (status === 401 || status === 403 || status === 404) return false;
        return failureCount < 2;
      },
      staleTime: 30_000,
    },
  },
});

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { employee, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }
  if (!employee) return <Redirect to="/login" />;
  return <Component />;
}

function Router() {
  const { employee, isLoading } = useAuth();

  return (
    <Switch>
      {/* ── Public ─────────────────────────────────────────────────────── */}
      <Route path="/login">
        {!isLoading && employee ? <Redirect to="/dashboard" /> : <LoginPage />}
      </Route>

      {/* Supplier token-based pricing page — no auth required */}
      <Route path="/q/:token" component={PricingPage} />

      <Route path="/">
        <Redirect to="/dashboard" />
      </Route>

      {/* ── Protected — Dashboard ──────────────────────────────────────── */}
      <Route path="/dashboard">
        <ProtectedRoute component={DashboardPage} />
      </Route>

      {/* ── Module: RFQ ────────────────────────────────────────────────── */}
      <Route path="/rfq/new">
        <ProtectedRoute component={NewRfqPage} />
      </Route>
      <Route path="/rfq/:id/send">
        <ProtectedRoute component={SendRfqPage} />
      </Route>
      <Route path="/rfq/:id">
        <ProtectedRoute component={RfqDetailPage} />
      </Route>
      <Route path="/rfq">
        <ProtectedRoute component={RfqListPage} />
      </Route>

      {/* ── Module: PO ─────────────────────────────────────────────────── */}
      <Route path="/purchase-orders/new">
        <ProtectedRoute component={NewPurchaseOrderPage} />
      </Route>
      <Route path="/purchase-orders/:id">
        <ProtectedRoute component={PurchaseOrderDetailPage} />
      </Route>
      <Route path="/purchase-orders">
        <ProtectedRoute component={PurchaseOrdersPage} />
      </Route>

      {/* ── Module: Users ──────────────────────────────────────────────── */}
      <Route path="/suppliers/new">
        <ProtectedRoute component={NewSupplierPage} />
      </Route>
      <Route path="/suppliers/:id">
        <ProtectedRoute component={SupplierDetailPage} />
      </Route>
      <Route path="/suppliers">
        <ProtectedRoute component={SuppliersPage} />
      </Route>
      <Route path="/employees">
        <ProtectedRoute component={EmployeesPage} />
      </Route>

      {/* ── Module: Reports ────────────────────────────────────────────── */}
      <Route path="/analytics">
        <ProtectedRoute component={AnalyticsPage} />
      </Route>
      <Route path="/audit">
        <ProtectedRoute component={AuditPage} />
      </Route>
      <Route path="/items">
        <ProtectedRoute component={ItemsPage} />
      </Route>

      {/* ── Module: Communications ─────────────────────────────────────── */}
      <Route path="/whatsapp">
        <ProtectedRoute component={WhatsAppPage} />
      </Route>

      {/* ── Module: Integrations ────────────────────────────────────────── */}
      <Route path="/integrations">
        <ProtectedRoute component={IntegrationsPage} />
      </Route>

      {/* Popup page — standalone, no Layout, no auth guard (auth via API) */}
      <Route path="/integrations/connect" component={ConnectPopupPage} />

      {/* ── Module: Customers ──────────────────────────────────────────── */}
      <Route path="/customers/new">
        <ProtectedRoute component={NewCustomerPage} />
      </Route>
      <Route path="/customers/:id">
        <ProtectedRoute component={CustomerDetailPage} />
      </Route>
      <Route path="/customers">
        <ProtectedRoute component={CustomersPage} />
      </Route>
      <Route path="/customer-rfq/new">
        <ProtectedRoute component={NewCustomerRfqPage} />
      </Route>
      <Route path="/customer-rfq/:id">
        <ProtectedRoute component={CustomerRfqDetailPage} />
      </Route>
      <Route path="/customer-rfq">
        <ProtectedRoute component={CustomerRfqPage} />
      </Route>
      <Route path="/customer-po/new">
        <ProtectedRoute component={NewCustomerPoPage} />
      </Route>
      <Route path="/customer-po/:id">
        <ProtectedRoute component={CustomerPoDetailPage} />
      </Route>
      <Route path="/customer-po">
        <ProtectedRoute component={CustomerPoPage} />
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function AppInner() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <AuthProvider>
        <Router />
      </AuthProvider>
    </WouterRouter>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <TooltipProvider>
          <AppInner />
          <Toaster />
          <Sonner richColors position="top-center" />
        </TooltipProvider>
      </LanguageProvider>
    </QueryClientProvider>
  );
}

export default App;
