import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  LayoutDashboard,
  FileText,
  Users,
  BarChart3,
  UserCog,
  ClipboardList,
  Menu,
  X,
  LogOut,
  MessageSquare,
  Package,
  ShoppingCart,
  Languages,
  Plug,
  UserRound,
  Calculator,
} from "lucide-react";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { canAccessPath } from "@/lib/permissions";

export function Layout({ children }: { children: React.ReactNode }) {
  const { employee, logout } = useAuth();
  const [location] = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [waUnread, setWaUnread] = useState(0);
  const { t, lang, setLang } = useLanguage();

  const role = employee?.role;
  const perms = employee?.permissions;

  const mainNavItems = [
    { href: "/dashboard", label: t("nav.dashboard"), icon: LayoutDashboard },
    { href: "/customers", label: t("nav.customers"), icon: UserRound },
    { href: "/customer-rfq", label: t("nav.customerRfq"), icon: FileText },
    { href: "/customer-po", label: t("nav.customerPo"), icon: ShoppingCart },
    { href: "/rfq", label: t("nav.rfq"), icon: FileText },
    { href: "/suppliers", label: t("nav.suppliers"), icon: Users },
    { href: "/items", label: t("nav.items"), icon: Package },
    { href: "/purchase-orders", label: t("nav.purchaseOrders"), icon: ShoppingCart },
    { href: "/accounts", label: t("nav.accounts"), icon: Calculator },
    { href: "/analytics", label: t("nav.analytics"), icon: BarChart3 },
    { href: "/whatsapp", label: t("nav.whatsapp"), icon: MessageSquare },
  ];

  const adminNavItems = [
    { href: "/employees", label: t("nav.employees"), icon: UserCog },
    { href: "/audit", label: t("nav.auditLog"), icon: ClipboardList },
    { href: "/integrations", label: t("nav.integrations"), icon: Plug },
  ];

  // Filter both groups by the employee's effective permissions.
  const visibleMain = mainNavItems.filter((i) => canAccessPath(role, perms, i.href));
  const visibleAdmin = adminNavItems.filter((i) => canAccessPath(role, perms, i.href));

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [location]);

  // Close mobile drawer on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Prevent body scroll when mobile drawer is open
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  useEffect(() => {
    const fetchUnread = async () => {
      try {
        const r = await fetch("/api/whatsapp/chats", { credentials: "include" });
        if (r.ok) {
          const chats: { unread: number }[] = await r.json();
          const total = chats.reduce((sum, c) => sum + Number(c.unread ?? 0), 0);
          setWaUnread(total);
        }
      } catch {
        /* ignore */
      }
    };
    fetchUnread();
    const interval = setInterval(fetchUnread, 12000);
    return () => clearInterval(interval);
  }, []);

  function SidebarContent({ mobile = false }: { mobile?: boolean }) {
    return (
      <>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-sidebar-border min-h-[57px]">
          {(sidebarOpen || mobile) && (
            <div className="flex items-center gap-2.5 overflow-hidden">
              <img
                src="/logo.png"
                alt="Cortoba Supplies"
                className="h-9 w-9 object-contain flex-shrink-0"
              />
              <div className="overflow-hidden">
                <p className="text-sidebar-foreground font-bold text-sm leading-tight truncate">
                  Cortoba Supplies
                </p>
                <p className="text-sidebar-foreground/50 text-xs leading-tight truncate">
                  {t("app.subtitle")}
                </p>
              </div>
            </div>
          )}
          {!sidebarOpen && !mobile && (
            <img src="/logo.png" alt="logo" className="h-8 w-8 object-contain mx-auto" />
          )}
          {mobile ? (
            <button
              onClick={() => setMobileOpen(false)}
              className="text-sidebar-foreground/60 hover:text-sidebar-foreground p-1 rounded flex-shrink-0 ml-auto"
            >
              <X size={20} />
            </button>
          ) : (
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="text-sidebar-foreground/60 hover:text-sidebar-foreground p-1 rounded flex-shrink-0"
            >
              {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {visibleMain.map((item) => {
            const active = location === item.href || location.startsWith(item.href + "/");
            return (
              <Link key={item.href} href={item.href}>
                <a
                  className={cn(
                    "flex items-center gap-3 px-2 py-2.5 rounded text-sm font-medium transition-colors",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50",
                  )}
                >
                  <div className="relative flex-shrink-0">
                    <item.icon size={18} />
                    {item.href === "/whatsapp" && waUnread > 0 && !sidebarOpen && !mobile && (
                      <span className="absolute -top-1.5 -right-1.5 bg-green-500 text-white text-[9px] rounded-full min-w-[14px] h-[14px] flex items-center justify-center font-bold px-0.5 leading-none">
                        {waUnread > 99 ? "99+" : waUnread}
                      </span>
                    )}
                  </div>
                  {(sidebarOpen || mobile) && <span className="truncate flex-1">{item.label}</span>}
                  {(sidebarOpen || mobile) && item.href === "/whatsapp" && waUnread > 0 && (
                    <span className="bg-green-500 text-white text-xs rounded-full min-w-[20px] h-5 flex items-center justify-center font-bold px-1 flex-shrink-0">
                      {waUnread > 99 ? "99+" : waUnread}
                    </span>
                  )}
                </a>
              </Link>
            );
          })}

          {visibleAdmin.length > 0 && (
            <>
              {(sidebarOpen || mobile) && (
                <p className="text-sidebar-foreground/30 text-xs px-2 pt-3 pb-1 uppercase tracking-wider">
                  {t("nav.admin")}
                </p>
              )}
              {visibleAdmin.map((item) => {
                const active = location === item.href || location.startsWith(item.href + "/");
                return (
                  <Link key={item.href} href={item.href}>
                    <a
                      className={cn(
                        "flex items-center gap-3 px-2 py-2.5 rounded text-sm font-medium transition-colors",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50",
                      )}
                    >
                      <item.icon size={18} className="flex-shrink-0" />
                      {(sidebarOpen || mobile) && <span className="truncate">{item.label}</span>}
                    </a>
                  </Link>
                );
              })}
            </>
          )}
        </nav>

        {/* User + Language Toggle */}
        <div className="border-t border-sidebar-border px-3 py-3 space-y-2">
          {/* Language toggle */}
          {(sidebarOpen || mobile) && (
            <button
              onClick={() => setLang(lang === "en" ? "ar" : "en")}
              className="flex items-center gap-1.5 w-full px-2 py-1.5 rounded text-xs font-medium text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
              title={t("lang.toggle")}
            >
              <Languages size={14} className="flex-shrink-0" />
              <span>{t("lang.toggle")}</span>
            </button>
          )}
          {!sidebarOpen && !mobile && (
            <button
              onClick={() => setLang(lang === "en" ? "ar" : "en")}
              className="flex items-center justify-center w-full py-1 rounded text-xs font-medium text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
              title={t("lang.toggle")}
            >
              <Languages size={14} />
            </button>
          )}
          {/* User info */}
          <div
            className={cn("flex items-center", sidebarOpen || mobile ? "gap-2" : "justify-center")}
          >
            <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-primary text-xs font-bold flex-shrink-0">
              {employee?.name?.[0]?.toUpperCase() ?? "?"}
            </div>
            {(sidebarOpen || mobile) && (
              <div className="flex-1 min-w-0">
                <p className="text-sidebar-foreground text-xs font-medium truncate">
                  {employee?.name}
                </p>
                <p className="text-sidebar-foreground/40 text-xs truncate capitalize">
                  {employee?.role ? t(`role.${employee.role}`) ?? employee.role : ""}
                </p>
              </div>
            )}
            {(sidebarOpen || mobile) && (
              <button
                onClick={logout}
                className="text-sidebar-foreground/40 hover:text-sidebar-foreground p-1"
              >
                <LogOut size={15} />
              </button>
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* ── Mobile top header bar ──────────────────────────────────────── */}
      <header className="md:hidden fixed top-0 inset-x-0 z-30 h-14 bg-sidebar border-b border-sidebar-border flex items-center px-4 gap-3 flex-shrink-0">
        <button
          onClick={() => setMobileOpen(true)}
          className="text-sidebar-foreground/70 hover:text-sidebar-foreground p-1 rounded"
        >
          <Menu size={22} />
        </button>
        <div className="flex items-center gap-2 overflow-hidden">
          <img src="/logo.png" alt="logo" className="h-7 w-7 object-contain flex-shrink-0" />
          <p className="text-sidebar-foreground font-bold text-sm truncate">Cortoba Supplies</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setLang(lang === "en" ? "ar" : "en")}
            className="text-sidebar-foreground/60 hover:text-sidebar-foreground text-xs font-medium px-2 py-1 rounded border border-sidebar-border hover:bg-sidebar-accent/50 transition-colors"
          >
            {t("lang.toggle")}
          </button>
          {waUnread > 0 && (
            <Link href="/whatsapp">
              <a className="flex items-center gap-1 bg-green-500 text-white text-xs rounded-full px-2.5 py-1 font-bold">
                <MessageSquare size={12} />
                {waUnread > 99 ? "99+" : waUnread}
              </a>
            </Link>
          )}
        </div>
      </header>

      {/* ── Mobile drawer overlay backdrop ────────────────────────────── */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/50"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ── Mobile drawer sidebar ─────────────────────────────────────── */}
      <aside
        className={cn(
          "md:hidden fixed inset-y-0 left-0 z-50 w-72 flex flex-col bg-sidebar border-r border-sidebar-border transition-transform duration-250",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <SidebarContent mobile />
      </aside>

      {/* ── Desktop sidebar ───────────────────────────────────────────── */}
      <aside
        className={cn(
          "hidden md:flex flex-col bg-sidebar border-r border-sidebar-border transition-all duration-200 flex-shrink-0",
          sidebarOpen ? "w-60" : "w-16",
        )}
      >
        <SidebarContent />
      </aside>

      {/* ── Main content ──────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto pt-14 md:pt-0">{children}</main>
    </div>
  );
}
