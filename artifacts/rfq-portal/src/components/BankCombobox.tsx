import { useState, useRef, useEffect, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { ChevronDown, Search } from "lucide-react";
import {
  EGYPTIAN_BANKS,
  bankLogoUrl,
  bankInitials,
  findBankByName,
  type EgyptianBank,
} from "@/lib/egyptian-banks";

// شعار البنك مع بديل نصي (الأحرف الأولى) عند تعذّر تحميل الصورة
export function BankLogo({ bank, size = 20 }: { bank: EgyptianBank; size?: number }) {
  const [failed, setFailed] = useState(false);
  const url = bankLogoUrl(bank.domain);
  if (!url || failed) {
    return (
      <span
        className="inline-flex items-center justify-center rounded-full bg-muted text-muted-foreground text-[9px] font-bold shrink-0"
        style={{ width: size, height: size }}
      >
        {bankInitials(bank.name)}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      className="rounded object-contain shrink-0 bg-white"
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
      loading="lazy"
    />
  );
}

// شعار بنك من اسمه المخزَّن (للعرض للقراءة فقط) — يُطابق الاسم مع القائمة
export function BankLogoByName({ name, size = 20 }: { name: string; size?: number }) {
  const bank = findBankByName(name);
  if (!bank) {
    return (
      <span
        className="inline-flex items-center justify-center rounded-full bg-muted text-muted-foreground text-[9px] font-bold shrink-0"
        style={{ width: size, height: size }}
      >
        {bankInitials(name)}
      </span>
    );
  }
  return <BankLogo bank={bank} size={size} />;
}

// Combobox لاختيار البنك: بحث في أسماء البنوك المصرية (عربي/إنجليزي) مع الشعار،
// أو كتابة اسم بنك غير موجود في القائمة (نص حر).
export function BankCombobox({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => EGYPTIAN_BANKS.find((b) => b.name === value) ?? null, [value]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return EGYPTIAN_BANKS;
    return EGYPTIAN_BANKS.filter(
      (b) => b.name.toLowerCase().includes(q) || b.nameEn.toLowerCase().includes(q),
    );
  }, [filter]);

  useEffect(() => {
    setFilter(value);
  }, [value]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center">
        {selected && (
          <span className="border border-r-0 border-border rounded-r-md px-2 py-2 bg-muted/40 flex items-center">
            <BankLogo bank={selected} size={18} />
          </span>
        )}
        <Input
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="ابحث عن البنك أو اكتب اسمه"
          className={selected ? "rounded-l-none" : ""}
          dir="rtl"
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="border border-r-0 border-border rounded-l-md px-2 py-2 bg-muted hover:bg-muted/80 text-muted-foreground"
        >
          <ChevronDown size={14} />
        </button>
      </div>

      {open && (
        <ul className="absolute z-50 mt-1 w-full max-h-72 overflow-y-auto bg-popover border border-border rounded-md shadow-md text-sm">
          <li className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-1.5 border-b border-border sticky top-0 bg-popover">
            <Search size={12} /> {filtered.length} بنك
            {filter.trim() ? ` مطابق لـ «${filter.trim()}»` : " — كل البنوك"}
          </li>
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground">
              لا يوجد بنك مطابق — سيُسجّل الاسم كما هو.
            </li>
          ) : (
            filtered.map((b) => (
              <li
                key={`${b.name}-${b.domain ?? ""}`}
                className="px-3 py-1.5 cursor-pointer hover:bg-accent hover:text-accent-foreground flex items-center gap-2"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(b.name);
                  setFilter(b.name);
                  setOpen(false);
                }}
              >
                <BankLogo bank={b} size={22} />
                <div className="min-w-0">
                  <div className="font-medium truncate">{b.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{b.nameEn}</div>
                </div>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
