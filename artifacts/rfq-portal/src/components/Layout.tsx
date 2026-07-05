import { Link, useLocation } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
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
  ChevronRight,
  MessageSquare,
  Package,
} from "lucide-react";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/rfq", label: "RFQ Management", icon: FileText },
  { href: "/suppliers", label: "Suppliers", icon: Users },
  { href: "/items", label: "Items", icon: Package },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/whatsapp", label: "WhatsApp", icon: MessageSquare },
];

const adminItems = [
  { href: "/employees", label: "Employees", icon: UserCog },
  { href: "/audit", label: "Audit Log", icon: ClipboardList },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { employee, logout } = useAuth();
  const [location] = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [waUnread, setWaUnread] = useState(0);

  useEffect(() => {
    const fetchUnread = async () => {
      try {
        const r = await fetch("/api/whatsapp/chats", { credentials: "include" });
        if (r.ok) {
          const chats: { unread: number }[] = await r.json();
          const total = chats.reduce((sum, c) => sum + Number(c.unread ?? 0), 0);
          setWaUnread(total);
        }
      } catch { /* ignore */ }
    };
    fetchUnread();
    const interval = setInterval(fetchUnread, 12000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar */}
      <aside
        className={cn(
          "flex flex-col bg-sidebar border-r border-sidebar-border transition-all duration-200 flex-shrink-0",
          sidebarOpen ? "w-60" : "w-16"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-sidebar-border min-h-[57px]">
          {sidebarOpen && (
            <div className="flex items-center gap-2.5 overflow-hidden">
              <img src="/logo.png" alt="Cortoba Supplies" className="h-9 w-9 object-contain flex-shrink-0" />
              <div className="overflow-hidden">
                <p className="text-sidebar-foreground font-bold text-sm leading-tight truncate">Cortoba Supplies</p>
                <p className="text-sidebar-foreground/50 text-xs leading-tight truncate">قرطبة للتوريدات</p>
              </div>
            </div>
          )}
          {!sidebarOpen && (
            <img src="/logo.png" alt="logo" className="h-8 w-8 object-contain mx-auto" />
          )}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="text-sidebar-foreground/60 hover:text-sidebar-foreground p-1 rounded flex-shrink-0"
          >
            {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => {
            const active = location === item.href || location.startsWith(item.href + "/");
            return (
              <Link key={item.href} href={item.href}>
                <a
                  className={cn(
                    "flex items-center gap-3 px-2 py-2 rounded text-sm font-medium transition-colors",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                  )}
                >
                  <div className="relative flex-shrink-0">
                    <item.icon size={18} />
                    {item.href === "/whatsapp" && waUnread > 0 && !sidebarOpen && (
                      <span className="absolute -top-1.5 -right-1.5 bg-green-500 text-white text-[9px] rounded-full min-w-[14px] h-[14px] flex items-center justify-center font-bold px-0.5 leading-none">
                        {waUnread > 99 ? "99+" : waUnread}
                      </span>
                    )}
                  </div>
                  {sidebarOpen && <span className="truncate flex-1">{item.label}</span>}
                  {sidebarOpen && item.href === "/whatsapp" && waUnread > 0 && (
                    <span className="bg-green-500 text-white text-xs rounded-full min-w-[20px] h-5 flex items-center justify-center font-bold px-1 flex-shrink-0">
                      {waUnread > 99 ? "99+" : waUnread}
                    </span>
                  )}
                </a>
              </Link>
            );
          })}

          {employee?.role === "admin" && (
            <>
              {sidebarOpen && (
                <p className="text-sidebar-foreground/30 text-xs px-2 pt-3 pb-1 uppercase tracking-wider">Admin</p>
              )}
              {adminItems.map((item) => {
                const active = location === item.href || location.startsWith(item.href + "/");
                return (
                  <Link key={item.href} href={item.href}>
                    <a
                      className={cn(
                        "flex items-center gap-3 px-2 py-2 rounded text-sm font-medium transition-colors",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                      )}
                    >
                      <item.icon size={18} className="flex-shrink-0" />
                      {sidebarOpen && <span className="truncate">{item.label}</span>}
                    </a>
                  </Link>
                );
              })}
            </>
          )}
        </nav>

        {/* User */}
        <div className="border-t border-sidebar-border px-3 py-3">
          <div className={cn("flex items-center", sidebarOpen ? "gap-2" : "justify-center")}>
            <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-primary text-xs font-bold flex-shrink-0">
              {employee?.name?.[0]?.toUpperCase() ?? "?"}
            </div>
            {sidebarOpen && (
              <div className="flex-1 min-w-0">
                <p className="text-sidebar-foreground text-xs font-medium truncate">{employee?.name}</p>
                <p className="text-sidebar-foreground/40 text-xs truncate capitalize">{employee?.role}</p>
              </div>
            )}
            {sidebarOpen && (
              <button onClick={logout} className="text-sidebar-foreground/40 hover:text-sidebar-foreground p-1">
                <LogOut size={15} />
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
