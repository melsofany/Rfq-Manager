import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useLanguage } from "@/contexts/LanguageContext";

type Chain = {
  customerRfq?: { id: number; customerRfqNo: string; status: string } | null;
  supplierRfq?: { id: number; internalRfqNo: string; status: string } | null;
  supplierRfqs?: { id: number; internalRfqNo: string; status: string }[];
  customerPos?: { id: number; customerPoNo: string; status: string }[];
  purchaseOrders?: { id: number; internalPoNo: string; status: string }[];
  offers?: { id: number; supplierName: string }[];
};

/**
 * Shows the linked documents of one record, so the chain
 * customer RFQ → supplier RFQ → customer PO → supplier PO can be followed.
 * `kind` picks the chain endpoint: "customer-rfq" or "po".
 */
export function DocumentChain({ kind, id }: { kind: "customer-rfq" | "po"; id: number }) {
  const { t } = useLanguage();
  const [chain, setChain] = useState<Chain | null>(null);

  useEffect(() => {
    let cancelled = false;
    const base = kind === "customer-rfq" ? "customer-rfq" : "po";
    fetch(`/api/${base}/${id}/chain`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setChain(data);
      })
      .catch(() => {
        if (!cancelled) setChain(null);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, id]);

  if (!chain) return null;

  const Item = ({ href, label }: { href: string; label: string }) => (
    <Link href={href}>
      <a className="inline-block rounded border border-border px-2 py-1 text-xs hover:bg-muted">{label}</a>
    </Link>
  );

  const rows: { title: string; items: JSX.Element[] }[] = [];
  if (kind === "customer-rfq") {
    rows.push({
      title: t("chain.supplierRfq"),
      items: (chain.supplierRfqs ?? []).map((r) => <Item key={r.id} href={`/rfq/${r.id}`} label={r.internalRfqNo} />),
    });
    rows.push({
      title: t("chain.customerPo"),
      items: (chain.customerPos ?? []).map((p) => <Item key={p.id} href={`/customer-po/${p.id}`} label={p.customerPoNo} />),
    });
    rows.push({
      title: t("chain.purchaseOrder"),
      items: (chain.purchaseOrders ?? []).map((p) => <Item key={p.id} href={`/purchase-orders/${p.id}`} label={p.internalPoNo} />),
    });
  } else {
    if (chain.customerRfq) {
      rows.push({
        title: t("chain.customerRfq"),
        items: [<Item key="cr" href={`/customer-rfq/${chain.customerRfq.id}`} label={chain.customerRfq.customerRfqNo} />],
      });
    }
    if (chain.supplierRfq) {
      rows.push({
        title: t("chain.supplierRfq"),
        items: [<Item key="sr" href={`/rfq/${chain.supplierRfq.id}`} label={chain.supplierRfq.internalRfqNo} />],
      });
    }
    if ((chain.customerPos ?? []).length) {
      rows.push({
        title: t("chain.customerPo"),
        items: (chain.customerPos ?? []).map((p) => <Item key={p.id} href={`/customer-po/${p.id}`} label={p.customerPoNo} />),
      });
    }
    if ((chain.offers ?? []).length) {
      rows.push({
        title: t("chain.offers"),
        items: (chain.offers ?? []).map((o) => (
          <span key={o.id} className="inline-block rounded border border-border px-2 py-1 text-xs text-muted-foreground">
            {o.supplierName}
          </span>
        )),
      });
    }
  }

  const hasAny = rows.some((r) => r.items.length > 0);
  if (!hasAny) {
    return (
      <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
        {t("chain.empty")}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{t("chain.title")}</h3>
      {rows
        .filter((r) => r.items.length > 0)
        .map((r) => (
          <div key={r.title} className="flex flex-wrap items-center gap-2">
            <span className="w-40 text-xs text-muted-foreground">{r.title}</span>
            {r.items}
          </div>
        ))}
    </div>
  );
}
