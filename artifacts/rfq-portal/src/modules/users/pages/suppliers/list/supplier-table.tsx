import { ChevronLeft } from "lucide-react";
import {
  ItemTags,
  StatusBadge,
  SupplierAvatar,
  TradeTags,
  tradeCategoriesOf,
} from "./supplier-display";
import type { SupplierRow, Translate } from "./supplier-display";

/** Desktop list: one line per supplier. The whole row opens the supplier. */
export function SupplierTable({
  t,
  suppliers,
  onOpen,
}: {
  t: Translate;
  suppliers: SupplierRow[];
  onOpen: (id: number) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
          <th className="px-4 py-2.5 font-medium">{t("sup.col.supplier")}</th>
          <th className="px-4 py-2.5 font-medium">{t("sup.col.contact")}</th>
          <th className="px-4 py-2.5 font-medium">{t("sup.col.tradeCategory")}</th>
          <th className="px-4 py-2.5 font-medium">{t("sup.col.itemCategories")}</th>
          <th className="px-4 py-2.5 font-medium">{t("sup.col.status")}</th>
          <th className="w-8" aria-hidden />
        </tr>
      </thead>
      <tbody>
        {suppliers.map((s) => (
          <tr
            key={s.id}
            tabIndex={0}
            role="link"
            aria-label={s.name}
            onClick={() => onOpen(s.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onOpen(s.id);
            }}
            className="group cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none"
          >
            <td className="px-4 py-3 align-middle">
              <div className="flex items-center gap-3">
                <SupplierAvatar name={s.name} />
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{s.name}</p>
                  {s.supplierId && (
                    <p dir="ltr" className="font-mono text-[11px] text-muted-foreground">
                      {s.supplierId}
                    </p>
                  )}
                </div>
              </div>
            </td>
            <td className="px-4 py-3 align-middle">
              {s.contactPerson || s.phone || s.email ? (
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm text-foreground">{s.contactPerson ?? "—"}</p>
                  {s.phone && (
                    <p dir="ltr" className="font-mono text-xs text-muted-foreground">
                      {s.phone}
                    </p>
                  )}
                  {s.email && (
                    <p
                      dir="ltr"
                      title={s.email}
                      className="max-w-[220px] truncate text-xs text-muted-foreground"
                    >
                      {s.email}
                    </p>
                  )}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </td>
            <td className="px-4 py-3 align-middle">
              <TradeTags names={tradeCategoriesOf(s)} />
            </td>
            <td className="px-4 py-3 align-middle">
              <ItemTags cats={s.itemCategories ?? []} t={t} />
            </td>
            <td className="px-4 py-3 align-middle">
              <StatusBadge supplier={s} t={t} />
            </td>
            <td className="px-2 align-middle">
              <ChevronLeft
                size={16}
                aria-hidden
                className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
