import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  CheckSquare,
  Square,
  MinusSquare,
  Search,
  RefreshCw,
  Users,
  X,
} from "lucide-react";
import type { Supplier, SupplierCategory } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// ── أدوات مساعدة ─────────────────────────────────────────────────────────────

function parseCategories(cat: string | null | undefined): string[] {
  if (!cat) return [];
  return cat
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

type TriState = "all" | "some" | "none";

function TriBox({ state, size = 15 }: { state: TriState; size?: number }) {
  if (state === "all") return <CheckSquare size={size} className="text-primary shrink-0" />;
  if (state === "some") return <MinusSquare size={size} className="text-primary shrink-0" />;
  return <Square size={size} className="text-muted-foreground shrink-0" />;
}

function triOf(memberIds: number[], selected: Set<number>): TriState {
  if (memberIds.length === 0) return "none";
  const n = memberIds.filter((id) => selected.has(id)).length;
  if (n === 0) return "none";
  return n === memberIds.length ? "all" : "some";
}

// ── بناء شجرة التصنيفات ─────────────────────────────────────────────────────

const ALL_KEY = "__all__";
const NONE_KEY = "__none__";

type TreeNode = {
  key: string;
  label: string;
  depth: number;
  // كل الموردين في الفرع (التصنيف + أبناؤه): يُستخدم لتحديد الشجرة كلها
  members: number[];
  // الموردون المرتبطون بهذا التصنيف نفسه فقط: يُعرضون في القسم على اليمين
  direct: number[];
  children: TreeNode[];
};

function buildTree(
  categories: SupplierCategory[],
  suppliers: Supplier[],
): {
  roots: TreeNode[];
  all: TreeNode;
  unclassified: TreeNode;
  flat: Map<string, TreeNode>;
} {
  const active = suppliers.filter((s) => s.isActive !== false);
  const catsOf = new Map<number, string[]>();
  for (const s of active) catsOf.set(s.id, parseCategories(s.category));

  const knownIds = new Set(categories.map((c) => c.id));
  const childrenOf = new Map<number, SupplierCategory[]>();
  const topLevel: SupplierCategory[] = [];
  for (const c of categories) {
    if (c.parentId != null && knownIds.has(c.parentId)) {
      const list = childrenOf.get(c.parentId) ?? [];
      list.push(c);
      childrenOf.set(c.parentId, list);
    } else {
      topLevel.push(c);
    }
  }
  const byName = (a: SupplierCategory, b: SupplierCategory) => a.name.localeCompare(b.name, "ar");
  topLevel.sort(byName);
  for (const list of childrenOf.values()) list.sort(byName);

  const flat = new Map<string, TreeNode>();

  // يرجع الأسماء الموجودة في الفرع كله (التصنيف نفسه + أبناؤه)
  const build = (cat: SupplierCategory, depth: number): { node: TreeNode; names: Set<string> } => {
    const names = new Set<string>([cat.name]);
    const children: TreeNode[] = [];
    for (const child of childrenOf.get(cat.id) ?? []) {
      const res = build(child, depth + 1);
      children.push(res.node);
      res.names.forEach((n) => names.add(n));
    }
    const members = active
      .filter((s) => (catsOf.get(s.id) ?? []).some((n) => names.has(n)))
      .map((s) => s.id);
    const direct = active
      .filter((s) => (catsOf.get(s.id) ?? []).includes(cat.name))
      .map((s) => s.id);
    const node: TreeNode = {
      key: `c${cat.id}`,
      label: cat.name,
      depth,
      members,
      direct,
      children,
    };
    flat.set(node.key, node);
    return { node, names };
  };

  const roots = topLevel.map((c) => build(c, 0).node);

  const knownNames = new Set(categories.map((c) => c.name));
  const unclassifiedMembers = active
    .filter((s) => !(catsOf.get(s.id) ?? []).some((n) => knownNames.has(n)))
    .map((s) => s.id);
  const unclassified: TreeNode = {
    key: NONE_KEY,
    label: "بدون تصنيف",
    depth: 0,
    members: unclassifiedMembers,
    direct: unclassifiedMembers,
    children: [],
  };
  flat.set(NONE_KEY, unclassified);

  const all: TreeNode = {
    key: ALL_KEY,
    label: "كل الموردين",
    depth: 0,
    members: active.map((s) => s.id),
    direct: active.map((s) => s.id),
    children: [],
  };
  flat.set(ALL_KEY, all);

  return { roots, all, unclassified, flat };
}

// ── المكوّن ───────────────────────────────────────────────────────────────────
// اليمين: قائمة أقسام مفتوحة، كل قسم هو تصنيف مختار من الشجرة ويعرض موردين هذا
// التصنيف فقط. الأقسام تُضاف أسفل بعضها بالترتيب الذي فُتحت به، ويمكن طي كل قسم
// أو إغلاقه. الاختيار مرتبط بالمورد نفسه، فالمورد الذي يظهر في أكثر من قسم
// يكون محدداً أو غير محدد في كل الأقسام معاً.

type Props = {
  categories: SupplierCategory[];
  suppliers: Supplier[];
  selectedIds: Set<number>;
  onChange: (next: Set<number>) => void;
  alreadySentIds: Set<number>;
};

export function SupplierPicker({
  categories,
  suppliers,
  selectedIds,
  onChange,
  alreadySentIds,
}: Props) {
  const [sectionKeys, setSectionKeys] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const tree = useMemo(() => buildTree(categories, suppliers), [categories, suppliers]);
  const supplierById = useMemo(() => {
    const m = new Map<number, Supplier>();
    for (const s of suppliers) m.set(s.id, s);
    return m;
  }, [suppliers]);

  const q = search.trim().toLowerCase();
  const matches = (s: Supplier) => {
    if (!q) return true;
    return (
      s.name.toLowerCase().includes(q) ||
      (s.contactPerson ?? "").toLowerCase().includes(q) ||
      (s.email ?? "").toLowerCase().includes(q)
    );
  };

  const sections = sectionKeys
    .map((key) => tree.flat.get(key))
    .filter((node): node is TreeNode => !!node)
    .map((node) => {
      const all = node.direct.map((id) => supplierById.get(id)).filter((s): s is Supplier => !!s);
      return { node, all, shown: all.filter(matches) };
    })
    .filter((sec) => !q || sec.shown.length > 0);

  const toggleMembers = (memberIds: number[]) => {
    const next = new Set(selectedIds);
    const allIn = memberIds.length > 0 && memberIds.every((id) => next.has(id));
    for (const id of memberIds) {
      if (allIn) next.delete(id);
      else next.add(id);
    }
    onChange(next);
  };

  const toggleOne = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  const toggleCollapsed = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSectionCollapsed = (key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // الضغط على اسم تصنيف: يفتحه (ويضيفه أسفل الأقسام الأخرى) إن لم يكن مفتوحاً،
  // ويطويه إن كان مفتوحاً ومعروضاً، ويفتحه من جديد إن كان مطوياً.
  const activateNode = (key: string) => {
    const isOpen = sectionKeys.includes(key);
    if (isOpen && !collapsedSections.has(key)) {
      toggleSectionCollapsed(key);
      return;
    }
    setSectionKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setCollapsedSections((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const closeSection = (key: string) => {
    setSectionKeys((prev) => prev.filter((k) => k !== key));
    setCollapsedSections((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const selectedCount = Array.from(selectedIds).filter((id) => supplierById.has(id)).length;

  const renderNode = (node: TreeNode) => {
    const state = triOf(node.members, selectedIds);
    const isOpen = sectionKeys.includes(node.key);
    const hasChildren = node.children.length > 0;
    const isChildrenOpen = !collapsed.has(node.key);
    return (
      <div key={node.key}>
        <div
          className={`flex items-center gap-1.5 rounded-md pe-2 py-1.5 text-sm transition-colors ${
            isOpen ? "bg-primary/10" : "hover:bg-muted/50"
          }`}
          style={{ paddingInlineStart: `${node.depth * 16 + 4}px` }}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={() => toggleCollapsed(node.key)}
              className="text-muted-foreground hover:text-foreground p-0.5"
              aria-label={isChildrenOpen ? "طي التصنيفات الفرعية" : "توسيع التصنيفات الفرعية"}
            >
              {isChildrenOpen ? <ChevronDown size={14} /> : <ChevronLeft size={14} />}
            </button>
          ) : (
            <span className="w-[18px] shrink-0" />
          )}
          <button
            type="button"
            onClick={() => toggleMembers(node.members)}
            disabled={node.members.length === 0}
            className="p-0.5 disabled:opacity-40"
            aria-label={`تحديد ${node.label}`}
          >
            <TriBox state={state} />
          </button>
          <button
            type="button"
            onClick={() => activateNode(node.key)}
            className={`flex-1 min-w-0 text-start truncate ${
              node.depth === 0 ? "font-medium text-foreground" : "text-foreground/90"
            }`}
          >
            {node.label}
          </button>
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            {node.members.length}
          </span>
        </div>
        {hasChildren && isChildrenOpen && node.children.map(renderNode)}
      </div>
    );
  };

  const renderRow = (s: Supplier) => {
    const checked = selectedIds.has(s.id);
    const sentBefore = alreadySentIds.has(s.id);
    return (
      <button
        key={s.id}
        type="button"
        onClick={() => toggleOne(s.id)}
        className={`w-full flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-0 text-start transition-colors ${
          checked ? (sentBefore ? "bg-amber-50/60" : "bg-primary/5") : "hover:bg-muted/30"
        }`}
      >
        <TriBox state={checked ? "all" : "none"} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-foreground text-sm truncate">{s.name}</span>
            {sentBefore && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 border border-amber-200 whitespace-nowrap">
                <RefreshCw size={9} />
                أُرسل مسبقاً
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {[s.contactPerson, s.email ?? "بدون إيميل"].filter(Boolean).join(" · ")}
          </p>
        </div>
      </button>
    );
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,300px)_1fr]">
      {/* ── شجرة التصنيفات ── */}
      <div className="bg-card border border-border rounded-lg p-2 space-y-0.5 lg:max-h-[520px] lg:overflow-y-auto">
        <div className="px-2 pt-1 pb-2 text-xs text-muted-foreground">
          اضغط اسم تصنيف لإضافة موردييه أسفل القائمة، واضغط مرة أخرى لطيه
        </div>
        {renderNode(tree.all)}
        {tree.roots.map(renderNode)}
        {tree.unclassified.members.length > 0 && renderNode(tree.unclassified)}
      </div>

      {/* ── الأقسام المفتوحة ── */}
      <div className="bg-card border border-border rounded-lg overflow-hidden flex flex-col min-w-0">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <Users size={15} className="text-muted-foreground shrink-0" />
            <span className="font-medium text-sm">الموردون</span>
            <span className="text-xs text-muted-foreground">({sectionKeys.length} تصنيف)</span>
          </div>
          <div className="relative">
            <Search
              size={13}
              className="absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث..."
              className="ps-8 h-7 text-xs w-44"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto lg:max-h-[440px] p-3 space-y-3">
          {sectionKeys.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              اختر تصنيفاً من القائمة لعرض موردييه هنا
            </p>
          ) : sections.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">لا توجد نتائج</p>
          ) : (
            sections.map(({ node, all, shown }) => {
              const memberIds = shown.map((s) => s.id);
              const state = triOf(memberIds, selectedIds);
              const sectionCollapsed = collapsedSections.has(node.key);
              return (
                <div key={node.key} className="border border-border rounded-lg overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2.5 bg-muted/30 border-b border-border">
                    <button
                      type="button"
                      onClick={() => toggleSectionCollapsed(node.key)}
                      className="p-0.5 text-muted-foreground hover:text-foreground"
                      aria-label={sectionCollapsed ? `توسيع ${node.label}` : `طي ${node.label}`}
                    >
                      {sectionCollapsed ? <ChevronLeft size={15} /> : <ChevronDown size={15} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleMembers(memberIds)}
                      disabled={memberIds.length === 0}
                      className="p-0.5 disabled:opacity-40"
                      aria-label={`تحديد الكل في ${node.label}`}
                    >
                      <TriBox state={state} />
                    </button>
                    <span className="font-medium text-sm text-foreground truncate flex-1 min-w-0">
                      {node.label}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {q ? `${shown.length} / ${all.length}` : all.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => closeSection(node.key)}
                      className="p-0.5 text-muted-foreground hover:text-foreground"
                      aria-label={`إغلاق ${node.label}`}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {!sectionCollapsed &&
                    (all.length === 0 ? (
                      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                        {node.children.length > 0
                          ? "لا يوجد موردون مرتبطون بهذا التصنيف مباشرة، اختر تصنيفاً فرعياً من القائمة"
                          : "لا يوجد موردون في هذا التصنيف"}
                      </p>
                    ) : (
                      shown.map(renderRow)
                    ))}
                </div>
              );
            })
          )}
        </div>

        <div className="px-4 py-2.5 border-t border-border flex items-center justify-between gap-3 bg-muted/20">
          <span className="text-sm text-muted-foreground">{selectedCount} مورد محدد إجمالاً</span>
          {selectedCount > 0 && (
            <Button variant="ghost" size="sm" onClick={() => onChange(new Set())}>
              مسح التحديد
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
