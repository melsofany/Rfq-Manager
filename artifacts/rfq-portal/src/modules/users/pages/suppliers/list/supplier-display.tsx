import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The translation accessor, as the rest of the suppliers module types it. */
export type Translate = (k: string) => string;

/** Item-category reference the API attaches to each supplier. */
export interface ItemCategoryRef {
  id: number;
  name: string;
  /** The supplier quoted a price for an item in this category. */
  quoted?: boolean;
  /** A purchase order was issued to the supplier for an item in this category. */
  ordered?: boolean;
  /** A human linked the pair explicitly. */
  manual?: boolean;
}

/** One supplier as returned by `GET /api/suppliers`. */
export interface SupplierRow {
  id: number;
  name: string;
  supplierId?: string | null;
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  category?: string | null;
  categories?: string[];
  isActive?: boolean;
  invoiceHasVat?: boolean | null;
  itemCategories?: ItemCategoryRef[];
}

export interface CategoryNodeLite {
  id: number;
  name: string;
  parentId?: number | null;
}

export type Evidence = "ordered" | "quoted" | "manual";

/** Strongest first: a purchase order outweighs a quote, a quote outweighs a manual link. */
const EVIDENCE_ORDER: Evidence[] = ["ordered", "quoted", "manual"];

const EVIDENCE_LABEL_KEY: Record<Evidence, string> = {
  ordered: "sup.evidence.ordered",
  quoted: "sup.evidence.quoted",
  manual: "sup.evidence.manual",
};

const EVIDENCE_TITLE_KEY: Record<Evidence, string> = {
  ordered: "sup.evidence.orderedTitle",
  quoted: "sup.evidence.quotedTitle",
  manual: "sup.evidence.manualTitle",
};

const EVIDENCE_DOT: Record<Evidence, string> = {
  ordered: "bg-emerald-600",
  quoted: "bg-sky-500",
  manual: "bg-slate-400",
};

/** The single strongest reason a supplier has an item category, or null if none is recorded. */
export function strongestEvidence(c: ItemCategoryRef): Evidence | null {
  return EVIDENCE_ORDER.find((e) => c[e]) ?? null;
}

export function parseCategories(cat: string | null | undefined): string[] {
  if (!cat) return [];
  return cat
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function tradeCategoriesOf(s: SupplierRow): string[] {
  return s.categories ?? parseCategories(s.category);
}

/** Shows the first `max` items and folds the rest into a «+N» counter whose tooltip lists them. */
function ChipList<T>({
  items,
  max = 2,
  getKey,
  getLabel,
  render,
}: {
  items: T[];
  max?: number;
  getKey: (item: T) => string | number;
  getLabel: (item: T) => string;
  render: (item: T) => ReactNode;
}) {
  const shown = items.slice(0, max);
  const hidden = items.slice(max);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((item) => (
        <Fragment key={getKey(item)}>{render(item)}</Fragment>
      ))}
      {hidden.length > 0 && (
        <span
          title={hidden.map(getLabel).join("، ")}
          className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
        >
          +{hidden.length}
        </span>
      )}
    </div>
  );
}

/** Trade categories: one neutral style, because they describe the supplier rather than evidence. */
export function TradeTags({ names }: { names: string[] }) {
  if (names.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <ChipList
      items={names}
      getKey={(n) => n}
      getLabel={(n) => n}
      render={(name) => (
        <span className="inline-flex items-center rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium text-foreground">
          {name}
        </span>
      )}
    />
  );
}

/**
 * Item categories the supplier can supply. A coloured dot shows the strongest
 * evidence (hover for the reason); the strongest evidence sorts first.
 */
export function ItemTags({ cats, t }: { cats: ItemCategoryRef[]; t: Translate }) {
  if (cats.length === 0)
    return <span className="text-xs text-muted-foreground">{t("sup.notSet")}</span>;
  const rank = (c: ItemCategoryRef) => {
    const ev = strongestEvidence(c);
    return ev ? EVIDENCE_ORDER.indexOf(ev) : EVIDENCE_ORDER.length;
  };
  const sorted = [...cats].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return (
    <ChipList
      items={sorted}
      getKey={(c) => c.id}
      getLabel={(c) => c.name}
      render={(c) => {
        const ev = strongestEvidence(c);
        const title = ev ? `${c.name} — ${t(EVIDENCE_TITLE_KEY[ev])}` : c.name;
        return (
          <span
            title={title}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50/60 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
          >
            {ev && <span aria-hidden className={cn("size-1.5 rounded-full", EVIDENCE_DOT[ev])} />}
            {c.name}
          </span>
        );
      }}
    />
  );
}

/** Legend for the evidence dots, shown under the list. */
export function EvidenceLegend({ t }: { t: Translate }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {EVIDENCE_ORDER.map((e) => (
        <span key={e} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn("size-2 rounded-full", EVIDENCE_DOT[e])} />
          {t(EVIDENCE_LABEL_KEY[e])}
        </span>
      ))}
    </div>
  );
}

/** Active/inactive state, with a VAT note underneath when the supplier invoices without VAT. */
export function StatusBadge({ supplier, t }: { supplier: SupplierRow; t: Translate }) {
  const active = Boolean(supplier.isActive);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-xs font-medium",
          active ? "text-green-700 dark:text-green-400" : "text-muted-foreground",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            active ? "bg-green-500" : "bg-muted-foreground/50",
          )}
        />
        {active ? t("sup.active") : t("sup.inactive")}
      </span>
      {supplier.invoiceHasVat === false && (
        <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
          {t("sup.noVat")}
        </span>
      )}
    </span>
  );
}

export function SupplierAvatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-bold text-muted-foreground"
    >
      {name.charAt(0)}
    </span>
  );
}
