/**
 * بطاقات KPI لكل موظف — لكل موظف: البنود المسندة، البنود اللي اتسعرت، والبنود اللي
 * أمر الشراء بتاعها اتسلّم. البيانات بتيجي من /analytics/procurement/by-item
 * (صفوف موظف × تصنيف)، والبطاقة بتجمعها لكل موظف.
 */
import { UserCog } from "lucide-react";

export interface ItemKpiEmployee {
  employeeId: number;
  employeeName: string;
  categoryId: number | null;
  categoryName: string | null;
  items: number;
  itemsWithOffers: number;
  offersReceived: number;
  convertedItems: number;
  deliveredItems: number;
  manualItems: number;
  conversionRate: number;
  responseRate: number;
  deliveryRate: number;
}

interface PersonTotals {
  employeeId: number;
  name: string;
  items: number;
  priced: number;
  offers: number;
  converted: number;
  delivered: number;
  categories: string[];
}

/** Sum the per-category rows into one row per employee. */
export function rollupByEmployee(rows: ItemKpiEmployee[]): PersonTotals[] {
  const map = new Map<number, PersonTotals>();
  for (const r of rows) {
    let p = map.get(r.employeeId);
    if (!p) {
      p = {
        employeeId: r.employeeId,
        name: r.employeeName,
        items: 0,
        priced: 0,
        offers: 0,
        converted: 0,
        delivered: 0,
        categories: [],
      };
      map.set(r.employeeId, p);
    }
    p.items += r.items;
    p.priced += r.itemsWithOffers;
    p.offers += r.offersReceived;
    p.converted += r.convertedItems;
    p.delivered += r.deliveredItems;
    if (r.categoryName && !p.categories.includes(r.categoryName)) p.categories.push(r.categoryName);
  }
  return [...map.values()].sort((a, b) => b.items - a.items);
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

function Bar({ value, className }: { value: number; className: string }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div className={`h-full rounded-full ${className}`} style={{ width: `${value}%` }} />
    </div>
  );
}

export function EmployeeKpiBoard({ rows }: { rows: ItemKpiEmployee[] }) {
  const people = rollupByEmployee(rows);
  if (people.length === 0) {
    return (
      <div className="bg-card border border-border rounded-lg p-6 text-center text-sm text-muted-foreground">
        لا توجد بنود مسندة لموظفين بعد
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <UserCog size={16} className="text-teal-500" /> أداء كل موظف
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {people.map((p) => {
          const pricedPct = pct(p.priced, p.items);
          const deliveredPct = pct(p.delivered, p.items);
          return (
            <div
              key={p.employeeId}
              className="bg-card border border-border rounded-lg p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-foreground truncate">{p.name}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {p.categories.length ? p.categories.join("، ") : "—"}
                  </div>
                </div>
                <div className="text-end shrink-0">
                  <div className="text-2xl font-bold text-teal-600 leading-none">{p.items}</div>
                  <div className="text-[10px] text-muted-foreground mt-1">بند مسند</div>
                </div>
              </div>

              <div className="space-y-2">
                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-muted-foreground">بنود اتسعرت</span>
                    <span className="font-medium text-blue-600">
                      {p.priced} · {pricedPct}%
                    </span>
                  </div>
                  <Bar value={pricedPct} className="bg-blue-500" />
                </div>
                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-muted-foreground">أمر شراء اتسلّم</span>
                    <span className="font-medium text-emerald-600">
                      {p.delivered} · {deliveredPct}%
                    </span>
                  </div>
                  <Bar value={deliveredPct} className="bg-emerald-500" />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border text-center">
                <div>
                  <div className="text-sm font-semibold text-indigo-600">{p.offers}</div>
                  <div className="text-[10px] text-muted-foreground">عروض</div>
                </div>
                <div>
                  <div className="text-sm font-semibold text-emerald-700">{p.converted}</div>
                  <div className="text-[10px] text-muted-foreground">تحوّلت لأمر شراء</div>
                </div>
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    {p.items - p.converted}
                  </div>
                  <div className="text-[10px] text-muted-foreground">لسه بدون أمر شراء</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        «اتسعرت»: بند وصله عرض سعر من مورد. «أمر شراء اتسلّم»: بند ليه بند في أمر شراء تم استلامه
        واعتماد الكمية كاملة.
      </p>
    </div>
  );
}
