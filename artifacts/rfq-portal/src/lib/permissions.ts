/**
 * Flexible per-employee permission system.
 *
 * The permission catalog is a tree: each top-level node is a sidebar page
 * (matching Layout navItems hrefs); a page may expose child nodes for its
 * tabs/sub-views so an admin can grant/revoke at the tab level too.
 *
 * Storage: a JSON map { "<key>": true } on the employee row (column
 * `employees.permissions`). When `permissions` is null, the role default
 * (ROLE_DEFAULTS) is used. `admin` always has full access.
 */

export type Role = "admin" | "manager" | "purchasing" | "data_entry";

/** A single permission node (page, or a tab within a page). */
export interface PermissionNode {
  /** Stable key, unique across the whole tree. */
  key: string;
  /** Sidebar href for page-level nodes (undefined for tab nodes). */
  href?: string;
  /** i18n key resolving to the localized label. */
  labelKey: string;
  /** Child nodes (tabs within the page). */
  children?: PermissionNode[];
}

/**
 * The full permission catalog — the single source of truth.
 * Page keys mirror the sidebar hrefs (without the leading slash).
 * Tab keys are `${pageKey}:${tabId}`.
 *
 * Keep this in sync with the tabs rendered in each page module.
 */
export const PERMISSION_CATALOG: PermissionNode[] = [
  { key: "dashboard", href: "/dashboard", labelKey: "nav.dashboard" },
  { key: "customers", href: "/customers", labelKey: "nav.customers" },
  { key: "customer-rfq", href: "/customer-rfq", labelKey: "nav.customerRfq" },
  { key: "customer-po", href: "/customer-po", labelKey: "nav.customerPo", children: [
    { key: "customer-po:orders", labelKey: "perm.customerPo.orders" },
    { key: "customer-po:deliveries", labelKey: "perm.customerPo.deliveries" },
  ] },
  { key: "rfq", href: "/rfq", labelKey: "nav.rfq" },
  { key: "suppliers", href: "/suppliers", labelKey: "nav.suppliers", children: [
    { key: "suppliers:list", labelKey: "perm.suppliers.list" },
    { key: "suppliers:import", labelKey: "perm.suppliers.import" },
  ] },
  { key: "items", href: "/items", labelKey: "nav.items", children: [
    { key: "items:search", labelKey: "perm.items.search" },
    { key: "items:sheet", labelKey: "perm.items.sheet" },
  ] },
  { key: "purchase-orders", href: "/purchase-orders", labelKey: "nav.purchaseOrders", children: [
    { key: "purchase-orders:orders", labelKey: "perm.po.orders" },
    { key: "purchase-orders:receipts", labelKey: "perm.po.receipts" },
  ] },
  { key: "accounts", href: "/accounts", labelKey: "nav.accounts", children: [
    { key: "accounts:journal", labelKey: "perm.accounts.journal" },
    { key: "accounts:sales", labelKey: "perm.accounts.sales" },
    { key: "accounts:suppliers", labelKey: "perm.accounts.suppliers" },
    { key: "accounts:coa", labelKey: "perm.accounts.coa" },
    { key: "accounts:reports", labelKey: "perm.accounts.reports" },
    { key: "accounts:taxes", labelKey: "perm.accounts.taxes" },
  ] },
  { key: "analytics", href: "/analytics", labelKey: "nav.analytics" },
  { key: "whatsapp", href: "/whatsapp", labelKey: "nav.whatsapp", children: [
    { key: "whatsapp:chats", labelKey: "perm.whatsapp.chats" },
    { key: "whatsapp:templates", labelKey: "perm.whatsapp.templates" },
    { key: "whatsapp:broadcast", labelKey: "perm.whatsapp.broadcast" },
    { key: "whatsapp:settings", labelKey: "perm.whatsapp.settings" },
  ] },
  { key: "employees", href: "/employees", labelKey: "nav.employees", children: [
    { key: "employees:employees", labelKey: "perm.employees.employees" },
    { key: "employees:representatives", labelKey: "perm.employees.representatives" },
  ] },
  { key: "audit", href: "/audit", labelKey: "nav.auditLog" },
  { key: "integrations", href: "/integrations", labelKey: "nav.integrations" },
];

/** All permission keys flattened (pages + tabs). */
export const ALL_PERMISSION_KEYS: string[] = (() => {
  const out: string[] = [];
  for (const node of PERMISSION_CATALOG) {
    out.push(node.key);
    for (const child of node.children ?? []) out.push(child.key);
  }
  return out;
})();

/** Page-level keys only (sidebar items). */
export const PAGE_KEYS: string[] = PERMISSION_CATALOG.map((n) => n.key);

/**
 * Role defaults used when an employee has no explicit `permissions` map.
 * `admin` is always granted everything (handled separately, not listed).
 */
export const ROLE_DEFAULTS: Record<Exclude<Role, "admin">, string[]> = {
  manager: PAGE_KEYS.slice(),
  purchasing: PAGE_KEYS.filter((k) => k !== "employees" && k !== "audit" && k !== "integrations"),
  data_entry: ["dashboard", "customers", "customer-rfq", "customer-po"],
};

export type PermissionMap = Record<string, boolean> | null | undefined;

/**
 * Resolve the effective granted-permission set for an employee.
 * - admin → every key granted.
 * - otherwise → explicit `permissions` map if present, else ROLE_DEFAULTS[role].
 */
export function resolvePermissions(
  role: string | undefined,
  permissions: PermissionMap,
): Set<string> {
  if (role === "admin") return new Set(ALL_PERMISSION_KEYS);
  const explicit = permissions && typeof permissions === "object" ? permissions : null;
  const keys = explicit && Object.keys(explicit).length
    ? Object.keys(explicit).filter((k) => explicit[k] === true)
    : (ROLE_DEFAULTS as Record<string, string[]>)[role ?? ""] ?? [];
  return new Set(keys);
}

/** Is a single permission key granted? */
export function hasPermission(
  role: string | undefined,
  permissions: PermissionMap,
  key: string,
): boolean {
  return resolvePermissions(role, permissions).has(key);
}

/** Is a page (sidebar item) visible/accessible? Accepts a path like "/customer-rfq". */
export function canAccessPath(
  role: string | undefined,
  permissions: PermissionMap,
  path: string,
): boolean {
  if (role === "admin") return true;
  // Match the catalog page whose href is a prefix of the path.
  const node = PERMISSION_CATALOG.find(
    (n) => n.href && (path === n.href || path.startsWith(n.href + "/")),
  );
  if (!node) return true; // unknown/shared paths (e.g. /login, /q/:token) are public
  return resolvePermissions(role, permissions).has(node.key);
}

/** List of sidebar page keys the employee may see. */
export function visiblePageKeys(role: string | undefined, permissions: PermissionMap): string[] {
  const granted = resolvePermissions(role, permissions);
  return PAGE_KEYS.filter((k) => granted.has(k));
}

/**
 * Given a page key and its full tab list (as rendered in the page),
 * return only the tabs the employee may see. Tabs without a catalog entry
 * (no `${pageKey}:${tabId}` permission defined) are always shown — only
 * explicitly-modelled tabs can be restricted.
 */
export function filterTabs<T extends string>(
  role: string | undefined,
  permissions: PermissionMap,
  pageKey: string,
  tabs: readonly T[],
): T[] {
  if (role === "admin") return tabs.slice();
  const granted = resolvePermissions(role, permissions);
  return tabs.filter((tabId) => {
    const key = `${pageKey}:${tabId}`;
    // If the catalog defines this tab as a permission node, honour it;
    // otherwise leave the tab visible (not every tab is permission-gated).
    const isModelled = ALL_PERMISSION_KEYS.includes(key);
    return !isModelled || granted.has(key);
  });
}

/** Build an explicit permissions map from a set of granted keys (for the editor). */
export function permissionsFromKeys(keys: Iterable<string>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of keys) out[k] = true;
  return out;
}

/** Whether an employee uses role defaults (no explicit map) vs a custom map. */
export function hasCustomPermissions(permissions: PermissionMap): boolean {
  return Boolean(permissions && typeof permissions === "object" && Object.keys(permissions).length);
}
