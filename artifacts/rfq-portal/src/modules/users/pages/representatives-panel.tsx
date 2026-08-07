import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/contexts/LanguageContext";
import { Pencil, Plus, Trash2, UsersRound, X } from "lucide-react";

type Representative = { id: number; name: string; phone: string; isActive: boolean };
type Form = { name: string; phone: string };
const EMPTY: Form = { name: "", phone: "" };

async function readError(response: Response, fallback: string) {
  try {
    const body = await response.json();
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

export default function RepresentativesPanel() {
  const { t } = useLanguage();
  const [items, setItems] = useState<Representative[]>([]);
  const [form, setForm] = useState<Form>(EMPTY);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/representatives", { credentials: "include" });
      if (!response.ok) throw new Error(await readError(response, t("representatives.loadError")));
      setItems(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("representatives.loadError"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function startEdit(item: Representative) {
    setEditingId(item.id);
    setForm({ name: item.name, phone: item.phone });
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(editingId ? `/api/representatives/${editingId}` : "/api/representatives", {
        method: editingId ? "PATCH" : "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!response.ok) throw new Error(await readError(response, t("representatives.saveError")));
      setForm(EMPTY);
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("representatives.saveError"));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    if (!window.confirm(t("representatives.deleteWarning"))) return;
    const response = await fetch(`/api/representatives/${id}`, { method: "DELETE", credentials: "include" });
    if (!response.ok) { setError(await readError(response, t("representatives.deleteError"))); return; }
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-foreground">{editingId ? t("representatives.edit") : t("representatives.add")}</h2>
          {editingId && <button onClick={() => { setEditingId(null); setForm(EMPTY); }} className="text-muted-foreground"><X size={18} /></button>}
        </div>
        <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5"><Label>{t("representatives.name")}</Label><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("representatives.namePlaceholder")} /></div>
          <div className="space-y-1.5"><Label>{t("representatives.phone")}</Label><Input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+201000000000" inputMode="tel" /></div>
          <p className="sm:col-span-2 text-xs text-muted-foreground">{t("representatives.phoneHint")}</p>
          {error && <div className="sm:col-span-2 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">⚠ {error}</div>}
          <div className="sm:col-span-2 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => { setEditingId(null); setForm(EMPTY); }}>{t("employees.cancel")}</Button><Button type="submit" disabled={saving} className="gap-1.5"><Plus size={15} />{saving ? t("employees.saving") : editingId ? t("representatives.save") : t("representatives.addButton")}</Button></div>
        </form>
      </div>
      <div className="bg-card border border-border rounded-lg overflow-hidden">
        {loading ? <div className="p-8 text-center text-muted-foreground text-sm">{t("employees.loading")}</div> : !items.length ? <div className="p-12 text-center"><UsersRound size={40} className="mx-auto text-muted-foreground/30 mb-3" /><p className="text-muted-foreground text-sm">{t("representatives.empty")}</p></div> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="bg-muted/30 border-b border-border text-left"><th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">{t("representatives.name")}</th><th className="px-4 py-2.5 text-muted-foreground text-xs font-medium">{t("representatives.phone")}</th><th className="px-4 py-2.5 text-muted-foreground text-xs font-medium text-center">{t("employees.actionsCol")}</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className="border-b border-border last:border-0"><td className="px-4 py-3 font-medium">{item.name}</td><td className="px-4 py-3"><a className="text-green-700 hover:underline" href={`https://wa.me/${item.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer">{item.phone}</a></td><td className="px-4 py-3"><div className="flex justify-center gap-1"><button onClick={() => startEdit(item)} title={t("employees.edit")} className="p-1.5 hover:bg-blue-50 text-muted-foreground hover:text-blue-600"><Pencil size={14} /></button><button onClick={() => void remove(item.id)} title={t("employees.delete")} className="p-1.5 hover:bg-red-50 text-muted-foreground hover:text-red-600"><Trash2 size={14} /></button></div></td></tr>)}</tbody></table></div>}
      </div>
    </div>
  );
}
