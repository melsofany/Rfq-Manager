import { useState } from "react";
import { ChevronRight, ChevronDown, ShieldCheck, Check } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  PERMISSION_CATALOG,
  ALL_PERMISSION_KEYS,
  PAGE_KEYS,
  ROLE_DEFAULTS,
  permissionsFromKeys,
  resolvePermissions,
  type Role,
} from "@/lib/permissions";

export type PermissionsValue = Record<string, boolean> | null;

interface Props {
  role: string;
  value: PermissionsValue;
  onChange: (value: PermissionsValue) => void;
}

/**
 * Permission tree editor: every page (sidebar item) + every tab is a row with a
 * checkbox. Expanding a page reveals its tabs. Admin cannot be restricted.
 */
export default function PermissionsEditor({ role, value, onChange }: Props) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState<Set<string>>(new Set(PERMISSION_CATALOG.map((n) => n.key)));

  const isAdmin = role === "admin";
  // Effective granted set derived from role + current value (mirrors runtime).
  const granted = isAdmin ? new Set(ALL_PERMISSION_KEYS) : resolvePermissions(role, value);

  function toggleKey(key: string, checked: boolean) {
    if (isAdmin) return; // admin is always full-access
    const next = new Set(granted);
    if (checked) next.add(key);
    else next.delete(key);
    // Persist as an explicit map only when it differs from the role default.
    const defaults = (ROLE_DEFAULTS as Record<string, string[]>)[role as Exclude<Role, "admin">];
    const isDefault = defaults && defaults.length === next.size && defaults.every((k) => next.has(k));
    onChange(isDefault ? null : permissionsFromKeys(next));
  }

  function togglePage(pageKey: string, checked: boolean) {
    if (isAdmin) return;
    const node = PERMISSION_CATALOG.find((n) => n.key === pageKey);
    if (!node) return;
    const next = new Set(granted);
    const related = [pageKey, ...(node.children ?? []).map((c) => c.key)];
    for (const k of related) {
      if (checked) next.add(k);
      else next.delete(k);
    }
    const defaults = (ROLE_DEFAULTS as Record<string, string[]>)[role as Exclude<Role, "admin">];
    const isDefault = defaults && defaults.length === next.size && defaults.every((k) => next.has(k));
    onChange(isDefault ? null : permissionsFromKeys(next));
  }

  function selectAll() {
    onChange(permissionsFromKeys(ALL_PERMISSION_KEYS));
  }

  function clearAll() {
    if (isAdmin) return;
    onChange(permissionsFromKeys([]));
  }

  function resetToDefault() {
    onChange(null);
  }

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <ShieldCheck size={15} className="text-primary" />
          {t("perm.editorTitle")}
        </div>
        <div className="flex gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={selectAll} disabled={isAdmin}>
            <Check size={13} className="ml-1" /> {t("perm.selectAll")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={clearAll} disabled={isAdmin}>
            {t("perm.clearAll")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={resetToDefault} disabled={isAdmin}>
            {t("perm.resetDefault")}
          </Button>
        </div>
      </div>

      {isAdmin && (
        <div className="rounded-md bg-purple-50 border border-purple-200 px-3 py-2 text-xs text-purple-700">
          {t("perm.adminNote")}
        </div>
      )}

      {!isAdmin && value === null && (
        <div className="rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-700">
          {t("perm.usingDefault")}
        </div>
      )}

      <div className="rounded-lg border border-border max-h-[420px] overflow-y-auto">
        {PERMISSION_CATALOG.map((node) => {
          const pageGranted = granted.has(node.key);
          const children = node.children ?? [];
          const childKeys = children.map((c) => c.key);
          const grantedChildren = childKeys.filter((k) => granted.has(k));
          // indeterminate when some (but not all) children are granted
          const indeterminate =
            children.length > 0 && grantedChildren.length > 0 && grantedChildren.length < childKeys.length;
          const isOpen = expanded.has(node.key);
          const checkboxId = `perm-${node.key}`;

          return (
            <div key={node.key} className="border-b border-border last:border-0">
              <div className="flex items-center gap-2 px-3 py-2.5 hover:bg-muted/30">
                {children.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => toggleExpand(node.key)}
                    className="text-muted-foreground hover:text-foreground flex-shrink-0"
                  >
                    {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                ) : (
                  <span className="w-[15px] flex-shrink-0" />
                )}
                <Checkbox
                  id={checkboxId}
                  checked={indeterminate ? "indeterminate" : pageGranted}
                  disabled={isAdmin}
                  onCheckedChange={(c) => togglePage(node.key, c === true)}
                />
                <label htmlFor={checkboxId} className="text-sm text-foreground cursor-pointer flex-1">
                  {t(node.labelKey)}
                </label>
                {children.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    {grantedChildren.length}/{childKeys.length}
                  </span>
                )}
              </div>

              {children.length > 0 && isOpen && (
                <div className="bg-muted/20">
                  {children.map((child) => {
                    const childGranted = granted.has(child.key);
                    const childId = `perm-${child.key}`;
                    return (
                      <div key={child.key} className="flex items-center gap-2 px-3 py-2 pl-9">
                        <Checkbox
                          id={childId}
                          checked={childGranted}
                          disabled={isAdmin}
                          onCheckedChange={(c) => toggleKey(child.key, c === true)}
                        />
                        <label htmlFor={childId} className="text-sm text-muted-foreground cursor-pointer">
                          {t(child.labelKey)}
                        </label>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {t("perm.hint")}
      </p>
    </div>
  );
}

export { PAGE_KEYS };
