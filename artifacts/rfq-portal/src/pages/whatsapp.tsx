import { useState, useEffect, useRef, useCallback } from "react";
  import { Layout } from "@/components/Layout";
  import {
    Search, Send, Phone, RefreshCw, Paperclip, FileText, Download, X, Settings,
    Image as ImageIcon, Mic, Pencil, Trash2, Check, Info, Plus, CheckCheck,
    MoreVertical, Filter, Archive, Star, Tag, ChevronDown, Bell, BellOff,
    Smile, Clock, AlertCircle, User, Hash, ArrowLeft,
  } from "lucide-react";
  import { cn } from "@/lib/utils";

  // ─── Types ────────────────────────────────────────────────────────────────
  interface Chat {
    phone: string;
    supplierId: number | null;
    supplierName: string | null;
    lastMessage: string;
    lastAt: string;
    lastInboundAt: string | null;
    unread: number;
  }
  interface Message {
    id: number;
    waMessageId: string | null;
    direction: "inbound" | "outbound";
    phone: string;
    supplierId: number | null;
    body: string;
    mediaId: string | null;
    mediaType: string | null;
    mimeType: string | null;
    filename: string | null;
    isRead: boolean;
    createdAt: string;
  }
  interface PendingFile { file: File; base64: string; preview?: string; }

  // ─── Constants ────────────────────────────────────────────────────────────
  const AVATAR_COLORS = [
    "#6366f1","#8b5cf6","#ec4899","#f97316","#10b981",
    "#3b82f6","#14b8a6","#f59e0b","#ef4444","#06b6d4",
  ];

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function getAvatarColor(seed: string) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) & 0xffffffff;
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  }

  function initials(name: string) {
    const parts = name.trim().split(/\s+/);
    return parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : (name.trim()[0] ?? "?").toUpperCase();
  }

  function formatTime(dateStr: string) {
    const d = new Date(dateStr), now = new Date();
    const diff = Math.floor((now.getTime() - d.getTime()) / 86400000);
    if (diff === 0) return d.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
    if (diff === 1) return "أمس";
    if (diff < 7)  return d.toLocaleDateString("ar-EG", { weekday: "short" });
    return d.toLocaleDateString("ar-EG", { day: "2-digit", month: "2-digit" });
  }

  function formatFullTime(dateStr: string) {
    return new Date(dateStr).toLocaleString("ar-EG", {
      weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  }

  function normalizePhoneFE(raw: string) {
    let c = raw.replace(/[\s\-()]/g, "").replace(/^\+/, "");
    if (c.startsWith("00")) c = c.slice(2);
    if (c.length === 11 && c.startsWith("0")) c = "2" + c;
    if (c.length === 10 && c.startsWith("1")) c = "20" + c;
    return c;
  }

  async function requestNotifPermission() {
    if (!("Notification" in window) || Notification.permission !== "default") return;
    await Notification.requestPermission();
  }

  function pushBrowserNotif(title: string, body: string, onClick?: () => void) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const n = new Notification(title, { body, icon: "/logo.png", tag: "wa", renotify: true });
    if (onClick) n.onclick = () => { window.focus(); onClick(); n.close(); };
  }

  function playSound() {
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      const osc = ctx.createOscillator();
      osc.connect(gain); osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.6);
      osc.onended = () => ctx.close();
    } catch { /* ignore */ }
  }

  // ─── Avatar ───────────────────────────────────────────────────────────────
  function Avatar({ name, phone, size = 38 }: { name: string; phone?: string; size?: number }) {
    const [src, setSrc] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      if (!phone || failed) return;
      setSrc(`/api/whatsapp/profile-picture/${encodeURIComponent(phone)}`);
    }, [phone, failed]);

    if (src && !failed) {
      return <img src={src} alt={name} onError={() => { setFailed(true); setSrc(null); }}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />;
    }
    return (
      <div style={{
        width: size, height: size, borderRadius: "50%", flexShrink: 0, background: getAvatarColor(name),
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "#fff", fontWeight: 700, fontSize: Math.round(size * 0.38), letterSpacing: "-0.5px",
      }}>{initials(name)}</div>
    );
  }

  // ─── Status dot ──────────────────────────────────────────────────────────
  function OnlineDot({ lastInboundAt }: { lastInboundAt: string | null }) {
    if (!lastInboundAt) return null;
    const mins = Math.floor((Date.now() - new Date(lastInboundAt).getTime()) / 60000);
    if (mins >= 15) return null;
    return <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-green-400 border-2 border-white" />;
  }

  // ─── Media bubble ─────────────────────────────────────────────────────────
  function MediaBubble({ msg }: { msg: Message }) {
    const [err, setErr] = useState(false);
    const [lb, setLb] = useState(false);
    if (!msg.mediaId) return null;
    const url = `/api/whatsapp/media/${msg.mediaId}`;

    if (msg.mediaType === "image") {
      if (err) return <div className="flex items-center gap-2 text-xs text-red-400 py-1"><AlertCircle size={12} /> تعذّر تحميل الصورة</div>;
      return (
        <>
          <img src={url} alt="" onError={() => setErr(true)} onClick={() => setLb(true)}
            className="max-w-full max-h-52 rounded-xl object-cover cursor-zoom-in border border-white/20 mt-1" />
          {lb && <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center" onClick={() => setLb(false)}>
            <img src={url} alt="" className="max-w-[92vw] max-h-[92vh] rounded-xl" />
            <button className="absolute top-5 right-5 text-white/80 hover:text-white"><X size={22} /></button>
          </div>}
        </>
      );
    }
    if (msg.mediaType === "audio") {
      return <audio controls className="mt-1 h-9 w-full" style={{ minWidth: 200 }}><source src={url} type={msg.mimeType || "audio/ogg"} /></audio>;
    }
    if (msg.mediaType === "video") {
      return <video controls src={url} className="max-w-full max-h-48 rounded-xl mt-1" />;
    }
    return (
      <a href={url} download={msg.filename || "file"} target="_blank" rel="noreferrer"
        className="flex items-center gap-2.5 mt-1 bg-white/10 hover:bg-white/20 rounded-xl px-3 py-2.5 transition-colors group">
        <FileText size={18} className="text-blue-300 flex-shrink-0" />
        <span className="text-xs truncate flex-1 font-medium">{msg.filename || "مستند"}</span>
        <Download size={13} className="opacity-60 group-hover:opacity-100 flex-shrink-0" />
      </a>
    );
  }

  // ─── Emoji quick-pick (simple) ────────────────────────────────────────────
  const QUICK_EMOJIS = ["👍","✅","🙏","📦","💰","🔄","❓","⚠️","🚀","💡"];

  export default function WhatsAppPage() {
    // State
    const [chats, setChats] = useState<Chat[]>([]);
    const [filteredChats, setFilteredChats] = useState<Chat[]>([]);
    const [search, setSearch] = useState("");
    const [selected, setSelected] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState(false);
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
    const [uploading, setUploading] = useState(false);
    const [editId, setEditId] = useState<number | null>(null);
    const [editText, setEditText] = useState("");
    const [hoverId, setHoverId] = useState<number | null>(null);
    const [toast, setToast] = useState<{ msg: string; ok: boolean; phone?: string } | null>(null);
    const [newChatOpen, setNewChatOpen] = useState(false);
    const [newPhone, setNewPhone] = useState("");
    const [newPhoneErr, setNewPhoneErr] = useState("");
    const [showEmoji, setShowEmoji] = useState(false);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
      const [unreadOnly, setUnreadOnly] = useState(false);
      const [showDiagnose, setShowDiagnose] = useState(false);
      const [diagnoseData, setDiagnoseData] = useState<Record<string, unknown> | null>(null);
      const [diagnosing, setDiagnosing] = useState(false);

    const prevUnread = useRef(0);
    const selectedRef = useRef<string | null>(null);
    const messagesEnd = useRef<HTMLDivElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => { selectedRef.current = selected; }, [selected]);

    // ─── Data loading ────────────────────────────────────────────────────
    const loadChats = useCallback(async (): Promise<Chat[] | null> => {
      try {
        const r = await fetch("/api/whatsapp/chats", { credentials: "include" });
        if (!r.ok) return null;
        const data: Chat[] = await r.json();
        const total = data.reduce((s, c) => s + Number(c.unread ?? 0), 0);
        if (total > prevUnread.current) playSound();
        prevUnread.current = total;
        setChats(data);
        return data;
      } catch { return null; }
    }, []);

    const loadMessages = useCallback(async (phone: string) => {
      setLoading(true);
      try {
        const r = await fetch(`/api/whatsapp/chats/${encodeURIComponent(phone)}`, { credentials: "include" });
        if (r.ok) { setMessages(await r.json()); await loadChats(); }
      } finally { setLoading(false); }
    }, [loadChats]);

    // ─── Search / filter ─────────────────────────────────────────────────
    useEffect(() => {
      let list = chats;
      if (unreadOnly) list = list.filter(c => Number(c.unread) > 0);
      if (search.trim()) {
        const q = search.toLowerCase();
        list = list.filter(c =>
          (c.supplierName ?? "").toLowerCase().includes(q) ||
          c.phone.includes(q) ||
          c.lastMessage.toLowerCase().includes(q)
        );
      }
      setFilteredChats(list);
    }, [chats, search, unreadOnly]);

    // ─── SSE + fallback poll ─────────────────────────────────────────────
    useEffect(() => {
      requestNotifPermission();
      let es: EventSource | null = null;
      let rt: ReturnType<typeof setTimeout> | null = null;
      let alive = true;

      function connect() {
        if (!alive) return;
        es = new EventSource("/api/whatsapp/events", { withCredentials: true });
        es.onmessage = async (ev: MessageEvent) => {
          if (!ev.data?.trim()) return;
          try {
            const payload = JSON.parse(ev.data as string) as { type: string; phone?: string };
            if (payload.type !== "new_message") return;
            const ip = payload.phone ?? "";
            const fresh = await loadChats();
            if (ip && ip === selectedRef.current) {
              const r = await fetch(`/api/whatsapp/chats/${encodeURIComponent(ip)}`, { credentials: "include" });
              if (r.ok) setMessages(await r.json());
            } else {
              const chat = fresh?.find(c => c.phone === ip);
              const name = chat?.supplierName ?? ip;
              const last = chat?.lastMessage ?? "رسالة جديدة";
              pushBrowserNotif(`📩 ${name}`, last.slice(0, 100), () => handleSelect(ip));
              setToast({ msg: `رسالة جديدة من ${name}`, ok: true, phone: ip });
              setTimeout(() => setToast(null), 6000);
            }
          } catch { /* ignore */ }
        };
        es.onerror = () => { es?.close(); es = null; if (alive) rt = setTimeout(connect, 5000); };
      }

      connect();
      const poll = setInterval(async () => {
        await loadChats();
        if (selectedRef.current) {
          const r = await fetch(`/api/whatsapp/chats/${encodeURIComponent(selectedRef.current)}`, { credentials: "include" });
          if (r.ok) setMessages(await r.json());
        }
      }, 30000);

      return () => { alive = false; if (rt) clearTimeout(rt); es?.close(); clearInterval(poll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadChats]);

    useEffect(() => { loadChats(); }, [loadChats]);
    useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

    // ─── Actions ──────────────────────────────────────────────────────────
    async function handleSelect(phone: string) {
      setSelected(phone); setMessages([]); setPendingFile(null); setEditId(null);
      await loadMessages(phone);
      if (window.innerWidth < 768) setSidebarCollapsed(true);
    }

    async function handleRefresh() {
        setRefreshing(true);
        await loadChats();
        if (selected) await loadMessages(selected);
        setRefreshing(false);
      }

      async function handleDiagnose() {
        setShowDiagnose(true);
        if (diagnoseData) return;
        setDiagnosing(true);
        try {
          const r = await fetch("/api/whatsapp/diagnose", { credentials: "include" });
          const data = await r.json() as Record<string, unknown>;
          setDiagnoseData(data);
        } catch (e) {
          setDiagnoseData({ error: String(e) });
        } finally {
          setDiagnosing(false);
        }
      }

    async function handleSend(e?: React.FormEvent) {
      e?.preventDefault();
      if (!selected || sending) return;
      if (pendingFile) { await handleSendFile(); return; }
      const body = draft.trim();
      if (!body) return;
      setDraft(""); setSending(true);
      try {
        const chat = chats.find(c => c.phone === selected);
        const r = await fetch("/api/whatsapp/send", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: selected, message: body, supplierId: chat?.supplierId }),
        });
        if (r.ok) { await loadMessages(selected); }
        else { const e2 = await r.json(); showToast("فشل الإرسال: " + (e2.error || "خطأ"), false); setDraft(body); }
      } catch { showToast("خطأ في الاتصال", false); setDraft(body); }
      finally { setSending(false); }
    }

    async function handleSendFile() {
      if (!pendingFile || !selected) return;
      const chat = chats.find(c => c.phone === selected);
      setUploading(true); setSending(true);
      try {
        const r = await fetch("/api/whatsapp/send-media", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: selected, supplierId: chat?.supplierId,
            base64: pendingFile.base64, mimeType: pendingFile.file.type, filename: pendingFile.file.name }),
        });
        if (r.ok) { setPendingFile(null); await loadMessages(selected); }
        else { const e2 = await r.json(); showToast("فشل إرسال الملف: " + (e2.error || "خطأ"), false); }
      } catch { showToast("خطأ في الاتصال", false); }
      finally { setUploading(false); setSending(false); }
    }

    function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
      const file = e.target.files?.[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const res = reader.result as string;
        setPendingFile({ file, base64: res.split(",")[1], preview: file.type.startsWith("image/") ? res : undefined });
      };
      reader.readAsDataURL(file); e.target.value = "";
    }

    async function handleEditSave(id: number) {
      if (!editText.trim()) return;
      const r = await fetch(`/api/whatsapp/messages/${id}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: editText.trim() }),
      });
      if (r.ok) { setMessages(p => p.map(m => m.id === id ? { ...m, body: editText.trim() } : m)); setEditId(null); }
    }

    async function handleDelete(id: number) {
      if (!confirm("حذف الرسالة؟")) return;
      const r = await fetch(`/api/whatsapp/messages/${id}`, { method: "DELETE", credentials: "include" });
      if (r.ok) {
        const d = await r.json() as { waDeletedOnPlatform?: boolean };
        setMessages(p => p.filter(m => m.id !== id));
        showToast(d.waDeletedOnPlatform ? "تم الحذف من WhatsApp وسجلاتنا" : "تم الحذف من سجلاتنا", d.waDeletedOnPlatform ?? true);
      }
    }

    function handleNewChat(e: React.FormEvent) {
      e.preventDefault();
      const raw = newPhone.trim();
      if (!raw) { setNewPhoneErr("أدخل رقم الهاتف"); return; }
      const n = normalizePhoneFE(raw);
      if (n.length < 7) { setNewPhoneErr("رقم غير صحيح"); return; }
      setNewChatOpen(false); setNewPhone(""); setNewPhoneErr("");
      handleSelect(n);
    }

    function showToast(msg: string, ok: boolean) {
      setToast({ msg, ok }); setTimeout(() => setToast(null), 4000);
    }

    // ─── Derived ──────────────────────────────────────────────────────────
    const selectedChat = chats.find(c => c.phone === selected);
    const totalUnread = chats.reduce((s, c) => s + Number(c.unread ?? 0), 0);

    // ─── Group messages by date ──────────────────────────────────────────
    const grouped: Array<{ date: string; msgs: Message[] }> = [];
    for (const msg of messages) {
      const d = new Date(msg.createdAt).toLocaleDateString("ar-EG", { weekday: "long", day: "numeric", month: "long" });
      const last = grouped[grouped.length - 1];
      if (last && last.date === d) last.msgs.push(msg);
      else grouped.push({ date: d, msgs: [msg] });
    }

    return (
      <Layout>
        <div className="flex h-full overflow-hidden" style={{ height: "calc(100vh - 0px)" }}>

          {/* ═══ LEFT SIDEBAR ═══════════════════════════════════════════ */}
          <aside className={cn(
            "flex flex-col border-r border-border bg-background transition-all duration-200 flex-shrink-0",
            sidebarCollapsed ? "w-0 overflow-hidden" : "w-[340px]"
          )}>
            {/* Header */}
            <div className="px-4 py-3 border-b border-border flex items-center gap-2 bg-background">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0">
                  <svg viewBox="0 0 24 24" fill="white" className="w-4 h-4">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                    <path d="M12 0C5.373 0 0 5.373 0 12c0 2.124.558 4.118 1.531 5.845L.057 23.885l6.203-1.43A11.948 11.948 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.817 9.817 0 01-5.001-1.368l-.359-.213-3.681.848.875-3.593-.234-.369A9.818 9.818 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182S21.818 6.57 21.818 12 17.43 21.818 12 21.818z"/>
                  </svg>
                </div>
                <div>
                  <h1 className="text-sm font-bold text-foreground leading-tight">WhatsApp</h1>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    {totalUnread > 0 ? <span className="text-green-600 font-medium">{totalUnread} رسالة غير مقروءة</span> : "محادثات الموردين"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-0.5">
                <button onClick={() => setUnreadOnly(v => !v)}
                  title={unreadOnly ? "كل المحادثات" : "غير المقروءة فقط"}
                  className={cn("p-1.5 rounded-lg transition-colors", unreadOnly ? "bg-green-100 text-green-700" : "text-muted-foreground hover:text-foreground hover:bg-muted")}>
                  <Filter size={14} />
                </button>
                <button onClick={() => setNewChatOpen(v => !v)} title="محادثة جديدة"
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                  <Plus size={14} />
                </button>
                <button onClick={handleRefresh} title="تحديث"
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                  <RefreshCw size={14} className={cn(refreshing && "animate-spin")} />
                </button>
                <button onClick={handleDiagnose} title="تشخيص WhatsApp"
                  className={cn("p-1.5 rounded-lg transition-colors", showDiagnose ? "bg-amber-100 text-amber-600" : "text-muted-foreground hover:text-foreground hover:bg-muted")}>
                  <Settings size={14} />
                </button>
              </div>
            </div>

            {/* Search */}
            <div className="px-3 py-2 border-b border-border/50">
              <div className="relative">
                <Search size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ابحث في المحادثات..."
                  className="w-full text-xs bg-muted/60 rounded-lg pr-8 pl-3 py-2 focus:outline-none focus:ring-1 focus:ring-green-500/30 placeholder:text-muted-foreground/60"
                  style={{ direction: "rtl" }} />
                {search && <button onClick={() => setSearch("")} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X size={12} /></button>}
              </div>
            </div>

            {/* New chat panel */}
            {newChatOpen && (
              <div className="px-3 py-2.5 border-b border-border bg-green-50/50 dark:bg-green-900/10">
                <form onSubmit={handleNewChat} className="space-y-2">
                  <p className="text-[11px] text-green-700 font-semibold flex items-center gap-1.5"><Plus size={11} /> محادثة جديدة</p>
                  <div className="flex gap-1.5">
                    <input type="tel" value={newPhone} onChange={e => { setNewPhone(e.target.value); setNewPhoneErr(""); }}
                      placeholder="01012345678"
                      className="flex-1 text-xs rounded-lg border border-border bg-background px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-green-500/40"
                      style={{ direction: "ltr" }} autoFocus />
                    <button type="submit" className="px-3 py-1.5 text-xs rounded-lg bg-green-500 hover:bg-green-600 text-white font-semibold transition-colors">بدء</button>
                  </div>
                  {newPhoneErr && <p className="text-[10px] text-red-500">{newPhoneErr}</p>}
                </form>
              </div>
            )}

            {/* Chat list */}
            <div className="flex-1 overflow-y-auto">
              {filteredChats.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 gap-2">
                  <Search size={28} className="text-muted-foreground/20" />
                  <p className="text-xs text-muted-foreground">{search ? "لا نتائج" : "لا توجد محادثات"}</p>
                </div>
              ) : filteredChats.map(chat => {
                const name = chat.supplierName ?? chat.phone;
                const isActive = selected === chat.phone;
                const hasUnread = Number(chat.unread) > 0;
                return (
                  <button key={chat.phone} onClick={() => handleSelect(chat.phone)}
                    className={cn(
                      "w-full flex items-center gap-3 px-4 py-3 border-b border-border/40 text-right transition-colors group relative",
                      isActive ? "bg-green-50 dark:bg-green-900/20 border-l-2 border-l-green-500" : "hover:bg-muted/40"
                    )}>
                    {/* Avatar with online dot */}
                    <div className="relative flex-shrink-0">
                      <Avatar name={name} phone={chat.phone} size={42} />
                      <OnlineDot lastInboundAt={chat.lastInboundAt} />
                    </div>
                    {/* Info */}
                    <div className="flex-1 min-w-0 text-right">
                      <div className="flex items-center justify-between gap-1">
                        <span className={cn("text-[10px] flex-shrink-0", hasUnread ? "text-green-600 font-semibold" : "text-muted-foreground")}>
                          {formatTime(chat.lastAt)}
                        </span>
                        <span className={cn("text-sm font-medium truncate", isActive ? "text-green-700 dark:text-green-400" : "text-foreground")}>
                          {name}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-1 mt-0.5">
                        {hasUnread ? (
                          <span className="bg-green-500 text-white text-[9px] font-bold rounded-full min-w-[17px] h-[17px] flex items-center justify-center px-1 flex-shrink-0">
                            {Number(chat.unread) > 99 ? "99+" : chat.unread}
                          </span>
                        ) : <span />}
                        <p className={cn("text-xs truncate flex-1 text-right", hasUnread ? "text-foreground/80 font-medium" : "text-muted-foreground")}>
                          {chat.lastMessage}
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* ═══ MAIN PANEL ═════════════════════════════════════════════ */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {!selected ? (
              /* Empty state */
              <div className="flex-1 flex flex-col items-center justify-center bg-muted/20 gap-4">
                <div className="w-24 h-24 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" fill="none" className="w-12 h-12 text-green-500" stroke="currentColor" strokeWidth="1.5">
                    <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                <div className="text-center">
                  <h2 className="text-base font-semibold text-foreground">WhatsApp Business Inbox</h2>
                  <p className="text-sm text-muted-foreground mt-1">اختر محادثة من القائمة للبدء</p>
                </div>
                <button onClick={() => setNewChatOpen(true)}
                  className="flex items-center gap-2 px-4 py-2 rounded-full bg-green-500 hover:bg-green-600 text-white text-sm font-medium transition-colors">
                  <Plus size={15} /> بدء محادثة جديدة
                </button>
              </div>
            ) : (
              <>
                {/* ─── Chat Header ─────────────────────────────────────── */}
                <div className="px-4 py-2.5 border-b border-border bg-background flex items-center gap-3 flex-shrink-0">
                  {sidebarCollapsed && (
                    <button onClick={() => setSidebarCollapsed(false)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground">
                      <ArrowLeft size={16} />
                    </button>
                  )}
                  <div className="relative flex-shrink-0">
                    <Avatar name={selectedChat?.supplierName ?? selected} phone={selected} size={38} />
                    <OnlineDot lastInboundAt={selectedChat?.lastInboundAt ?? null} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground leading-tight truncate">
                      {selectedChat?.supplierName ?? selected}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {selectedChat?.lastInboundAt && Date.now() - new Date(selectedChat.lastInboundAt).getTime() < 900000 ? (
                        <span className="text-[10px] text-green-500 font-medium flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /> متصل الآن
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <Phone size={9} /> {selected}
                        </span>
                      )}
                      {selectedChat?.supplierId && (
                        <span className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
                          <span className="w-1 h-1 rounded-full bg-muted-foreground/40" />
                          <Hash size={9} /> مورد #{selectedChat.supplierId}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Actions */}
                  <div className="flex items-center gap-0.5">
                    <button onClick={handleRefresh} title="تحديث"
                      className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                      <RefreshCw size={15} className={cn(refreshing && "animate-spin")} />
                    </button>
                  </div>
                </div>

                {/* ─── Messages Area ───────────────────────────────────── */}
                <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1"
                  style={{ background: "radial-gradient(ellipse at top, #f0fdf4 0%, #fafafa 60%)" }}>
                  {loading ? (
                    <div className="flex flex-col items-center justify-center h-full gap-3">
                      <RefreshCw size={22} className="text-green-500 animate-spin" />
                      <p className="text-sm text-muted-foreground">جاري التحميل...</p>
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full gap-2">
                      <Clock size={32} className="text-muted-foreground/20" />
                      <p className="text-sm text-muted-foreground">لا توجد رسائل بعد</p>
                      <p className="text-xs text-muted-foreground/60">ابدأ المحادثة بإرسال رسالة</p>
                    </div>
                  ) : grouped.map(({ date, msgs }) => (
                    <div key={date}>
                      {/* Date separator */}
                      <div className="flex items-center gap-3 my-4">
                        <div className="flex-1 h-px bg-border" />
                        <span className="text-[10px] text-muted-foreground bg-background/80 px-2.5 py-0.5 rounded-full border border-border/60">{date}</span>
                        <div className="flex-1 h-px bg-border" />
                      </div>
                      {msgs.map(msg => {
                        const out = msg.direction === "outbound";
                        const ageMs = Date.now() - new Date(msg.createdAt).getTime();
                        return (
                          <div key={msg.id}
                            className={cn("flex items-end gap-2 mb-1.5 group", out ? "justify-end" : "justify-start")}
                            onMouseEnter={() => setHoverId(msg.id)}
                            onMouseLeave={() => setHoverId(null)}>

                            {/* Inbound avatar */}
                            {!out && <Avatar name={selectedChat?.supplierName ?? selected} phone={selected} size={28} />}

                            {/* Outbound action buttons */}
                            {out && hoverId === msg.id && editId !== msg.id && (
                              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity mb-1">
                                {!msg.mediaId && (
                                  <button onClick={() => { setEditId(msg.id); setEditText(msg.body); }}
                                    className="p-1.5 rounded-lg text-muted-foreground hover:text-blue-500 hover:bg-blue-50 transition-colors" title="تعديل">
                                    <Pencil size={12} />
                                  </button>
                                )}
                                {ageMs <= 86400000 && (
                                  <button onClick={() => handleDelete(msg.id)}
                                    className="p-1.5 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-50 transition-colors" title="حذف">
                                    <Trash2 size={12} />
                                  </button>
                                )}
                              </div>
                            )}

                            {/* Bubble */}
                            <div className={cn(
                              "max-w-[68%] rounded-2xl px-3.5 py-2.5 shadow-sm relative",
                              out
                                ? "bg-[#d9fdd3] dark:bg-[#005c4b] text-gray-800 dark:text-gray-100 rounded-br-sm"
                                : "bg-white dark:bg-[#202c33] text-gray-800 dark:text-gray-100 rounded-bl-sm border border-gray-100 dark:border-white/5"
                            )}>
                              {editId === msg.id ? (
                                <div className="space-y-2 min-w-[200px]">
                                  <p className="text-[10px] text-amber-600 flex items-center gap-1"><Info size={9} /> تعديل محلي فقط</p>
                                  <textarea value={editText} onChange={e => setEditText(e.target.value)}
                                    className="w-full text-sm bg-white/70 border border-green-300 rounded-lg px-2 py-1.5 focus:outline-none resize-none"
                                    rows={3} autoFocus style={{ direction: "rtl" }} />
                                  <div className="flex gap-1.5 justify-end">
                                    <button onClick={() => setEditId(null)}
                                      className="px-2.5 py-1 text-xs rounded-lg border border-border text-muted-foreground hover:bg-muted">إلغاء</button>
                                    <button onClick={() => handleEditSave(msg.id)}
                                      className="px-2.5 py-1 text-xs rounded-lg bg-green-500 text-white hover:bg-green-600 flex items-center gap-1">
                                      <Check size={10} /> حفظ
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  {msg.mediaId && <MediaBubble msg={msg} />}
                                  {(!msg.mediaId || msg.body) && (
                                    <p className="text-sm whitespace-pre-wrap leading-relaxed break-words">{msg.body}</p>
                                  )}
                                  <div className={cn("flex items-center gap-1 mt-1.5", out ? "justify-end" : "justify-start")}>
                                    <span className="text-[10px] text-current/50">{formatTime(msg.createdAt)}</span>
                                    {out && <CheckCheck size={12} className="text-blue-400" />}
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  <div ref={messagesEnd} />
                </div>

                {/* ─── Pending file preview ────────────────────────────── */}
                {pendingFile && (
                  <div className="px-4 py-2.5 border-t border-border bg-muted/30 flex items-center gap-3">
                    {pendingFile.preview
                      ? <img src={pendingFile.preview} alt="" className="w-14 h-14 object-cover rounded-xl border border-border" />
                      : <div className="w-14 h-14 rounded-xl border border-border bg-muted flex items-center justify-center">
                          <FileText size={22} className="text-blue-400" />
                        </div>}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{pendingFile.file.name}</p>
                      <p className="text-xs text-muted-foreground">{(pendingFile.file.size / 1024).toFixed(0)} KB</p>
                    </div>
                    <button onClick={() => setPendingFile(null)} className="p-1.5 rounded-full hover:bg-muted text-muted-foreground">
                      <X size={16} />
                    </button>
                  </div>
                )}

                {/* ─── Input Area ──────────────────────────────────────── */}
                <div className="px-4 py-3 border-t border-border bg-background flex-shrink-0">
                  {/* Emoji quick pick */}
                  {showEmoji && (
                    <div className="mb-2 flex items-center gap-1.5 flex-wrap">
                      {QUICK_EMOJIS.map(em => (
                        <button key={em} onClick={() => { setDraft(d => d + em); setShowEmoji(false); textareaRef.current?.focus(); }}
                          className="text-lg hover:scale-125 transition-transform">
                          {em}
                        </button>
                      ))}
                      <button onClick={() => setShowEmoji(false)} className="text-xs text-muted-foreground hover:text-foreground ml-1"><X size={12} /></button>
                    </div>
                  )}
                  <form onSubmit={handleSend} className="flex items-end gap-2">
                    <input ref={fileRef} type="file"
                      accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
                      className="hidden" onChange={handleFileChange} />
                    {/* Emoji */}
                    <button type="button" onClick={() => setShowEmoji(v => !v)}
                      className={cn("w-9 h-9 rounded-full flex items-center justify-center transition-colors flex-shrink-0 mb-0.5",
                        showEmoji ? "bg-amber-100 text-amber-600" : "text-muted-foreground hover:text-foreground hover:bg-muted")}>
                      <Smile size={18} />
                    </button>
                    {/* Attachment */}
                    <button type="button" onClick={() => fileRef.current?.click()} disabled={sending}
                      className="w-9 h-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex-shrink-0 mb-0.5 disabled:opacity-40">
                      <Paperclip size={18} />
                    </button>
                    {/* Text input */}
                    {pendingFile ? (
                      <div className="flex-1 rounded-2xl border border-green-300 bg-green-50 px-3.5 py-2.5 text-sm text-green-700 flex items-center gap-2 min-h-[42px]">
                        <FileText size={16} className="flex-shrink-0" />
                        <span className="truncate">{pendingFile.file.name}</span>
                        {uploading && <RefreshCw size={12} className="animate-spin flex-shrink-0" />}
                      </div>
                    ) : (
                      <textarea ref={textareaRef} value={draft} onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                        placeholder="اكتب رسالة..."
                        rows={1}
                        className="flex-1 resize-none rounded-2xl border border-border bg-muted/40 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500/20 focus:border-green-500/40 transition-all min-h-[42px] max-h-28"
                        style={{ direction: "rtl" }} disabled={sending} />
                    )}
                    {/* Send */}
                    <button type="submit"
                      disabled={(!draft.trim() && !pendingFile) || sending}
                      className="w-10 h-10 rounded-full bg-green-500 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-all flex-shrink-0 shadow-sm hover:shadow-md active:scale-95">
                      {uploading || sending
                        ? <RefreshCw size={16} className="text-white animate-spin" />
                        : <Send size={16} className="text-white" />}
                    </button>
                  </form>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ─── Toast ───────────────────────────────────────────────────── */}
        {toast && (
          <div
            onClick={() => { if (toast.phone) handleSelect(toast.phone); setToast(null); }}
            className={cn(
              "fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl shadow-xl text-sm font-medium flex items-center gap-2.5 cursor-pointer",
              "transition-all animate-in slide-in-from-bottom-2 duration-200",
              toast.ok ? "bg-[#25d366] text-white" : "bg-amber-500 text-white"
            )}>
            {toast.ok ? <Bell size={14} /> : <BellOff size={14} />}
            {toast.msg}
            {toast.phone && <ChevronDown size={14} className="-rotate-90 opacity-70" />}
          </div>
        )}

        {/* Hidden file input ref needed at top level for iOS */}
      </Layout>
    );
  }
  