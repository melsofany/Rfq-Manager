import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import NotFound from "@/pages/not-found";
import LoginPage from "@/pages/login";
import DashboardPage from "@/pages/dashboard";
import RfqListPage from "@/pages/rfq/index";
import NewRfqPage from "@/pages/rfq/new";
import RfqDetailPage from "@/pages/rfq/detail";
import SendRfqPage from "@/pages/rfq/send";
import SuppliersPage from "@/pages/suppliers/index";
import NewSupplierPage from "@/pages/suppliers/new";
import SupplierDetailPage from "@/pages/suppliers/detail";
import AnalyticsPage from "@/pages/analytics";
import EmployeesPage from "@/pages/employees";
import AuditPage from "@/pages/audit";
import PricingPage from "@/pages/pricing";
import WhatsAppPage from "@/pages/whatsapp";
import ItemsPage from "@/pages/items";
import PurchaseOrdersPage from "@/pages/purchase-orders/index";
import NewPurchaseOrderPage from "@/pages/purchase-orders/new";

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
      <Route path="/login">
        {!isLoading && employee ? <Redirect to="/dashboard" /> : <LoginPage />}
      </Route>

      <Route path="/q/:token" component={PricingPage} />

      <Route path="/">
        <Redirect to="/dashboard" />
      </Route>

      <Route path="/dashboard">
        <ProtectedRoute component={DashboardPage} />
      </Route>

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

      <Route path="/suppliers/new">
        <ProtectedRoute component={NewSupplierPage} />
      </Route>

      <Route path="/suppliers/:id">
        <ProtectedRoute component={SupplierDetailPage} />
      </Route>

      <Route path="/suppliers">
        <ProtectedRoute component={SuppliersPage} />
      </Route>

      <Route path="/analytics">
        <ProtectedRoute component={AnalyticsPage} />
      </Route>

      <Route path="/employees">
        <ProtectedRoute component={EmployeesPage} />
      </Route>

      <Route path="/audit">
        <ProtectedRoute component={AuditPage} />
      </Route>

      <Route path="/whatsapp">
        <ProtectedRoute component={WhatsAppPage} />
      </Route>

      <Route path="/items">
        <ProtectedRoute component={ItemsPage} />
      </Route>

      <Route path="/purchase-orders/new">
        <ProtectedRoute component={NewPurchaseOrderPage} />
      </Route>

      <Route path="/purchase-orders">
        <ProtectedRoute component={PurchaseOrdersPage} />
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
      <TooltipProvider>
        <AppInner />
        <Toaster />
        <Sonner richColors position="top-center" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
