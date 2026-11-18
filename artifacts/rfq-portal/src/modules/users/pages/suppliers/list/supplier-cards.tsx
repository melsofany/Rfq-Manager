import {
  ItemTags,
  StatusBadge,
  SupplierAvatar,
  TradeTags,
  tradeCategoriesOf,
} from "./supplier-display";
import type { SupplierRow, Translate } from "./supplier-display";

/** Phone/tablet list: a stacked card per supplier, so nothing needs horizontal scrolling. */
export function SupplierCardList({
  t,
  suppliers,
  onOpen,
}: {
  t: Translate;
  suppliers: SupplierRow[];
  onOpen: (id: number) => void;
}) {
  return (
    <ul className="divide-y divide-border">
      {suppliers.map((s) => (
        <li key={s.id}>
          <button
            type="button"
            onClick={() => onOpen(s.id)}
            className="flex w-full flex-col gap-2.5 px-4 py-3 text-right transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none"
          >
            <span className="flex items-start justify-between gap-3">
              <span className="flex min-w-0 items-center gap-3">
                <SupplierAvatar name={s.name} />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-foreground">{s.name}</span>
                  {s.supplierId && (
                    <span dir="ltr" className="block font-mono text-[11px] text-muted-foreground">
                      {s.supplierId}
                    </span>
                  )}
                </span>
              </span>
              <StatusBadge supplier={s} t={t} />
            </span>
            {(s.contactPerson || s.phone) && (
              <span className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                {s.contactPerson && <span>{s.contactPerson}</span>}
                {s.phone && (
                  <span dir="ltr" className="font-mono">
                    {s.phone}
                  </span>
                )}
              </span>
            )}
            <TradeTags names={tradeCategoriesOf(s)} paths={s.categoryPaths} />
            <ItemTags cats={s.itemCategories ?? []} t={t} />
          </button>
        </li>
      ))}
    </ul>
  );
}
