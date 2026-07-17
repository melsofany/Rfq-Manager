import { useState, useEffect, useRef, useCallback } from "react";
import { Layout } from "@/components/Layout";
import { useLanguage } from "@/contexts/LanguageContext";
import {
  Search,
  Send,
  Phone,
  RefreshCw,
  Paperclip,
  FileText,
  Download,
  X,
  Settings,
  Image as ImageIcon,
  Mic,
  Trash2,
  Check,
  Info,
  Plus,
  CheckCheck,
  MoreVertical,
  Bell,
  BellOff,
  Smile,
  Clock,
  AlertCircle,
  User,
  ArrowLeft,
  MessageSquare,
  Zap,
  Users,
  BarChart2,
  ChevronRight,
  Eye,
  Copy,
  CheckCircle,
  XCircle,
  Loader2,
  ExternalLink,
  Layout as LayoutIcon,
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
interface Reaction {
  reactorPhone: string;
  emoji: string;
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
  replyToMessageId: string | null;
  isRead: boolean;
  createdAt: string;
  reactions?: Reaction[];
}
interface Template {
  name: string;
  status: string;
  language: string;
  category: string;
  quality_score?: { score?: string };
  components?: Array<{
    type: string;
    text?: string;
    format?: string;
    buttons?: Array<{ type: string; text: string; url?: string; phone_number?: string }>;
    example?: { body_text?: string[][] };
  }>;
}
interface Supplier {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  category: string;
  contactPerson: string | null;
}
interface Stats {
  total: number;
  unread: number;
  totalChats: number;
  outbound: number;
  inbound: number;
}
interface DiagnoseResult {
  configured: boolean;
  error?: string;
  phone?: {
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
    status?: string;
    platform_type?: string;
    error?: string;
  };
  templates?: {
    total?: number;
    our_templates?: Array<{ name: string; status: string; language: string; category?: string }>;
    warning?: string;
    error?: string;
  };
  creds?: Record<string, string | string[]>;
}
interface PendingFile {
  file: File;
  preview?: string;
}
type Tab = "chats" | "templates" | "broadcast" | "settings";

// ─── Constants ────────────────────────────────────────────────────────────
const AVATAR_COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#10b981",
  "#3b82f6",
  "#14b8a6",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
];
const WA_GREEN = "#25d366";
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;
const WA_DARK = "#128C7E";

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
  const d = new Date(dateStr),
    now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return d.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
  if (diff === 1) return "أمس";
  if (diff < 7) return d.toLocaleDateString("ar-EG", { weekday: "short" });
  return d.toLocaleDateString("ar-EG", { day: "2-digit", month: "2-digit" });
}
function formatFullTime(dateStr: string) {
  return new Date(dateStr).toLocaleString("ar-EG", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function normalizePhoneFE(raw: string) {
  let c = raw.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  if (c.startsWith("00")) c = c.slice(2);
  if (c.length === 11 && c.startsWith("0")) c = "2" + c;
  if (c.length === 10 && c.startsWith("1")) c = "20" + c;
  return c;
}
function playNotifSound() {
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    const osc = ctx.createOscillator();
    osc.connect(gain);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.6);
  } catch {
    /* silent */
  }
}

// ─── Avatar Component ─────────────────────────────────────────────────────
function Avatar({ name, phone, size = 40 }: { name: string; phone: string; size?: number }) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState(false);
  useEffect(() => {
    setImgErr(false);
    setImgSrc(`/api/whatsapp/profile-picture/${encodeURIComponent(phone)}`);
  }, [phone]);
  const color = getAvatarColor(phone);
  const text = initials(name || phone);
  if (imgSrc && !imgErr) {
    return (
      <img
        src={imgSrc}
        onError={() => setImgErr(true)}
        alt={name}
        className="rounded-full object-cover flex-shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="rounded-full flex-shrink-0 flex items-center justify-center text-white font-semibold select-none"
      style={{ width: size, height: size, background: color, fontSize: size * 0.35 }}
    >
      {text}
    </div>
  );
}

// ─── MediaMessage Component ───────────────────────────────────────────────
function MediaMessage({ msg }: { msg: Message }) {
  const url = `/api/whatsapp/media/${msg.mediaId}`;
  if (msg.mediaType === "image") {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="block">
        <img
          src={url}
          alt="صورة"
          className="max-w-[220px] rounded-lg object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
        {msg.body && !msg.body.startsWith("[صورة") && <p className="text-sm mt-1">{msg.body}</p>}
      </a>
    );
  }
  if (msg.mediaType === "audio") {
    return (
      <div className="flex items-center gap-2">
        <Mic size={16} className="flex-shrink-0 opacity-70" />
        <audio controls src={url} className="h-8 max-w-[180px]" />
      </div>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 hover:opacity-80 transition-opacity"
    >
      <FileText size={16} className="flex-shrink-0 opacity-70" />
      <span className="text-sm underline truncate max-w-[160px]">{msg.filename || msg.body}</span>
      <Download size={14} className="flex-shrink-0 opacity-60" />
    </a>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────
export default function WhatsAppPage() {
  const [activeTab, setActiveTab] = useState<Tab>("chats");
  const [globalStats, setGlobalStats] = useState<Stats | null>(null);

  // Load stats on mount
  useEffect(() => {
    fetch("/api/whatsapp/stats", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setGlobalStats(d);
      })
      .catch(() => {});
  }, []);

  const { t, dir } = useLanguage();
  const tabs: Array<{ id: Tab; label: string; icon: React.ElementType; badge?: number }> = [
    {
      id: "chats",
      label: t("whatsapp.chats"),
      icon: MessageSquare,
      badge: globalStats?.unread || undefined,
    },
    { id: "templates", label: t("whatsapp.templates"), icon: LayoutIcon },
    { id: "broadcast", label: t("whatsapp.broadcast"), icon: Users },
    { id: "settings", label: t("whatsapp.settings"), icon: Settings },
  ];

  return (
    <Layout>
      <div className="h-[calc(100vh-4rem)] flex flex-col bg-[#f0f2f5]" dir={dir}>
        {/* ─── Header + Tabs ─────────────────────────────────────────── */}
        <div className="bg-white border-b border-border flex-shrink-0">
          <div className="px-4 pt-4 pb-0 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center"
                style={{ background: WA_GREEN }}
              >
                <MessageSquare size={18} className="text-white" />
              </div>
              <div>
                <h1 className="text-base font-bold text-foreground leading-tight">
                  {t("whatsapp.title")}
                </h1>
                <p className="text-xs text-muted-foreground leading-tight">
                  Meta Business API · whatsapp-api-js
                </p>
              </div>
            </div>
            {globalStats && (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <MessageSquare size={12} />
                  {globalStats.totalChats} {t("whatsapp.conversations")}
                </span>
                <span className="flex items-center gap-1">
                  <BarChart2 size={12} />
                  {globalStats.inbound} {t("whatsapp.inbound")} / {globalStats.outbound}{" "}
                  {t("whatsapp.outbound")}
                </span>
                {(globalStats.unread || 0) > 0 && (
                  <span className="flex items-center gap-1 text-green-600 font-medium">
                    <Bell size={12} />
                    {globalStats.unread} {t("whatsapp.unread")}
                  </span>
                )}
              </div>
            )}
          </div>
          {/* Tabs */}
          <div className="flex gap-0 mt-3 overflow-x-auto scrollbar-none">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium border-b-2 transition-all relative",
                  activeTab === tab.id
                    ? "border-green-500 text-green-600"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40",
                )}
              >
                <tab.icon size={15} />
                {tab.label}
                {tab.badge ? (
                  <span
                    className="absolute top-1.5 right-2 min-w-[18px] h-[18px] rounded-full text-[10px] flex items-center justify-center text-white font-bold"
                    style={{ background: WA_GREEN }}
                  >
                    {tab.badge > 99 ? "99+" : tab.badge}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        {/* ─── Tab Content ───────────────────────────────────────────── */}
        <div className="flex-1 min-h-0">
          {activeTab === "chats" && <ChatsTab onStatsChange={setGlobalStats} />}
          {activeTab === "templates" && <TemplatesTab />}
          {activeTab === "broadcast" && <BroadcastTab />}
          {activeTab === "settings" && <SettingsTab />}
        </div>
      </div>
    </Layout>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// CHATS TAB — powered by @chatscope/chat-ui-kit-react
// ══════════════════════════════════════════════════════════════════════════
function ChatsTab({ onStatsChange }: { onStatsChange: (s: Stats) => void }) {
  const { t } = useLanguage();
  // ── State ───────────────────────────────────────────────────────────────
  const [chats, setChats] = useState<Chat[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "unread" | "suppliers">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [forwardingMsg, setForwardingMsg] = useState<Message | null>(null);
  const [hoveredMsgId, setHoveredMsgId] = useState<number | null>(null);
  const [emojiPickerForMsg, setEmojiPickerForMsg] = useState<string | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newPhone, setNewPhone] = useState("");
  const [toast, setToast] = useState<{ msg: string; ok: boolean; phone?: string } | null>(null);
  const [contacts, setContacts] = useState<Supplier[]>([]);

  const messagesEnd = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  function showToast(msg: string, ok: boolean, phone?: string) {
    setToast({ msg, ok, phone });
    setTimeout(() => setToast(null), 4500);
  }

  // ── Data loading ────────────────────────────────────────────────────────
  const loadChats = useCallback(async (): Promise<Chat[] | null> => {
    try {
      const r = await fetch("/api/whatsapp/chats", { credentials: "include" });
      if (!r.ok) return null;
      const data: Chat[] = await r.json();
      setChats(data);
      fetch("/api/whatsapp/stats", { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) onStatsChange(d as Stats); })
        .catch(() => {});
      return data;
    } catch { return null; }
  }, [onStatsChange]);

  const loadMessages = useCallback(async (phone: string) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/whatsapp/chats/${encodeURIComponent(phone)}`, { credentials: "include" });
      if (r.ok) {
        setMessages(await r.json() as Message[]);
        await loadChats();
      }
    } finally { setLoading(false); }
  }, [loadChats]);

  useEffect(() => {
    loadChats();
    fetch("/api/whatsapp/contacts", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setContacts(d as Supplier[]))
      .catch(() => {});
  }, [loadChats]);

  // ── SSE real-time ────────────────────────────────────────────────────────
  useEffect(() => {
    let es: EventSource | null = null;
    function connect() {
      es = new EventSource("/api/whatsapp/events", { withCredentials: true });
      es.onmessage = async (e) => {
        if (!e.data || e.data.startsWith(":")) return;
        try {
          const ev = JSON.parse(e.data) as {
            type: string; phone?: string; senderName?: string;
            waMessageId?: string; reactorPhone?: string; emoji?: string; reason?: string;
          };
          if (ev.type === "new_message") {
            playNotifSound();
            if ("Notification" in window && Notification.permission === "granted") {
              new Notification(t("whatsapp.newMessage"), {
                body: ev.senderName ? `${t("whatsapp.from")} ${ev.senderName}` : `${t("whatsapp.from")} ${ev.phone}`,
                icon: "/logo.png", tag: "wa", ...({ renotify: true } as Record<string, unknown>),
              });
            }
            const fresh = await loadChats();
            if (ev.phone && ev.phone === selectedRef.current) {
              const r = await fetch(`/api/whatsapp/chats/${encodeURIComponent(ev.phone)}`, { credentials: "include" });
              if (r.ok) setMessages(await r.json() as Message[]);
            } else {
              const chat = fresh?.find((c) => c.phone === ev.phone);
              if (chat) showToast(`📩 ${chat.supplierName || ev.phone}: ${chat.lastMessage?.substring(0, 40)}`, false, ev.phone);
            }
          } else if (ev.type === "reaction") {
            setMessages((prev) => prev.map((m) => {
              if (m.waMessageId !== ev.waMessageId) return m;
              const reactions = (m.reactions ?? []).filter((r) => r.reactorPhone !== ev.reactorPhone);
              return { ...m, reactions: ev.emoji ? [...reactions, { reactorPhone: ev.reactorPhone!, emoji: ev.emoji! }] : reactions };
            }));
          } else if (ev.type === "delivery_failed") {
            showToast(`❌ ${ev.reason || "فشل تسليم رسالة"}`, false);
          }
        } catch { /* ignore */ }
      };
      es.onerror = () => { es?.close(); setTimeout(connect, 5000); };
    }
    async function requestNotif() {
      if (!("Notification" in window) || Notification.permission !== "default") return;
      await Notification.requestPermission();
    }
    requestNotif();
    connect();
    return () => { es?.close(); };
  }, [loadChats, t]);

  // Auto-scroll
  useEffect(() => {
    setTimeout(() => messagesEnd.current?.scrollIntoView({ behavior: "smooth" }), 80);
  }, [messages]);

  // Close emoji picker on outside click
  useEffect(() => {
    if (!emojiPickerForMsg) return;
    const close = () => setEmojiPickerForMsg(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [emojiPickerForMsg]);

  // ── Actions ──────────────────────────────────────────────────────────────
  async function handleSelect(phone: string) {
    setSelected(phone);
    setReplyingTo(null);
    setPendingFile(null);
    setDraft("");
    await loadMessages(phone);
  }

  async function handleRefresh() {
    setRefreshing(true);
    await loadChats();
    if (selected) await loadMessages(selected);
    setRefreshing(false);
  }

  async function handleSend() {
    if (!selected || (!draft.trim() && !pendingFile)) return;
    setSending(true);
    try {
      if (pendingFile) {
        setUploading(true);
        const fd = new FormData();
        fd.append("phone", selected);
        if (selectedChat?.supplierId != null) fd.append("supplierId", String(selectedChat.supplierId));
        fd.append("file", pendingFile.file, pendingFile.file.name);
        const r = await fetch("/api/whatsapp/send-media", {
          method: "POST", credentials: "include",
          body: fd,
        });
        if (!r.ok) { const d = await r.json() as { error?: string }; showToast(d.error || "فشل رفع الملف", false); }
        else { showToast("تم إرسال الملف ✓", true); }
        setPendingFile(null);
        setUploading(false);
      } else {
        const body: Record<string, unknown> = {
          phone: selected,
          message: draft.trim(),
          supplierId: selectedChat?.supplierId,
        };
        if (replyingTo?.waMessageId) body.replyToWaMessageId = replyingTo.waMessageId;
        const r = await fetch("/api/whatsapp/send", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) { const d = await r.json() as { error?: string }; showToast(d.error || "فشل الإرسال", false); return; }
        setReplyingTo(null);
      }
      setDraft("");
      await loadMessages(selected);
    } finally { setSending(false); }
  }

  async function handleForwardTo(toPhone: string) {
    if (!forwardingMsg) return;
    const r = await fetch("/api/whatsapp/forward", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: forwardingMsg.id, toPhone }),
    });
    if (r.ok) showToast("تم إعادة التوجيه ✓", true);
    else showToast("فشل إعادة التوجيه", false);
    setForwardingMsg(null);
    await loadChats();
  }

  async function handleDeleteMsg(id: number) {
    if (!confirm(t("whatsapp.deleteConfirm"))) return;
    await fetch(`/api/whatsapp/messages/${id}`, { method: "DELETE", credentials: "include" });
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }

  async function handleReact(waMessageId: string, emoji: string) {
    const msg = messages.find((m) => m.waMessageId === waMessageId);
    if (!msg) return;
    const isRemoving = (msg.reactions ?? []).some((r) => r.reactorPhone === "me" && r.emoji === emoji);
    setMessages((prev) => prev.map((m) => {
      if (m.waMessageId !== waMessageId) return m;
      const reactions = (m.reactions ?? []).filter((r) => r.reactorPhone !== "me");
      return { ...m, reactions: isRemoving ? reactions : [...reactions, { reactorPhone: "me", emoji }] };
    }));
    await fetch("/api/whatsapp/react", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waMessageId, toPhone: msg.phone, emoji: isRemoving ? "" : emoji }),
    });
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
    setPendingFile({ file, preview });
    e.target.value = "";
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); }
  }

  async function handleStartNewChat() {
    const phone = normalizePhoneFE(newPhone.trim());
    if (!phone) return;
    setNewChatOpen(false);
    setNewPhone("");
    await handleSelect(phone);
  }

  // ── Derived state ────────────────────────────────────────────────────────
  const filteredChats = chats.filter((c) => {
    const matchSearch = !search ||
      c.supplierName?.toLowerCase().includes(search.toLowerCase()) ||
      c.phone.includes(search) ||
      c.lastMessage?.toLowerCase().includes(search.toLowerCase());
    const matchFilter =
      filter === "all" ||
      (filter === "unread" && c.unread > 0) ||
      (filter === "suppliers" && !!c.supplierId);
    return matchSearch && matchFilter;
  });

  const selectedChat = chats.find((c) => c.phone === selected);
  const displayName = selectedChat?.supplierName || selected || "";

  function getReplyBody(waMessageId: string): string {
    const msg = messages.find((m) => m.waMessageId === waMessageId);
    return msg?.body ?? "(رسالة غير موجودة)";
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full overflow-hidden" style={{ direction: "ltr" }}>
      {/* ── LEFT: Conversation List ────────────────────────────────────── */}
      <div className={cn("flex flex-col bg-white border-r border-border flex-shrink-0 overflow-hidden", selected ? "hidden md:flex md:w-80" : "flex w-full md:w-80")}>
        {/* Sidebar header */}
        <div className="p-3 border-b border-border flex-shrink-0" style={{ direction: "rtl" }}>
          <div className="flex items-center gap-2 mb-2.5">
            <div className="relative flex-1">
              <Search size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("whatsapp.search")}
                className="w-full bg-[#f0f2f5] rounded-full pl-3 pr-8 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-green-400"
                dir="rtl"
              />
            </div>
            <button
              onClick={() => setNewChatOpen((v) => !v)}
              className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-muted transition-colors"
              title={t("whatsapp.newChat")}
            >
              <Plus size={16} className="text-muted-foreground" />
            </button>
            <button
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-muted transition-colors"
            >
              <RefreshCw size={15} className={cn("text-muted-foreground", refreshing && "animate-spin")} />
            </button>
          </div>
          {/* Filter chips */}
          <div className="flex gap-1.5">
            {(["all", "unread", "suppliers"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "text-xs px-2.5 py-1 rounded-full transition-all font-medium",
                  filter === f ? "text-white" : "bg-muted text-muted-foreground hover:bg-muted/80",
                )}
                style={filter === f ? { background: WA_GREEN } : {}}
              >
                {f === "all" ? t("whatsapp.filter.all") : f === "unread" ? t("whatsapp.filter.unread") : t("whatsapp.filter.suppliers")}
              </button>
            ))}
          </div>
        </div>

        {/* New chat dialog */}
        {newChatOpen && (
          <div className="p-3 border-b border-border bg-green-50 flex-shrink-0" style={{ direction: "rtl" }}>
            <div className="flex items-center gap-2">
              <button onClick={() => setNewChatOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X size={16} />
              </button>
              <input
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="+20 1xxxxxxxxx"
                className="flex-1 border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-green-400"
                dir="ltr"
                onKeyDown={(e) => { if (e.key === "Enter") void handleStartNewChat(); }}
                autoFocus
              />
              <button
                onClick={() => void handleStartNewChat()}
                disabled={!newPhone.trim()}
                className="px-3 py-1.5 rounded-lg text-white text-sm font-medium disabled:opacity-40"
                style={{ background: WA_GREEN }}
              >
                فتح
              </button>
            </div>
          </div>
        )}

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {filteredChats.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2">
              <MessageSquare size={24} className="opacity-20" />
              <p className="text-xs">{search ? "لا توجد نتائج" : t("whatsapp.noChats")}</p>
            </div>
          ) : (
            filteredChats.map((chat) => {
              const isActive = selected === chat.phone;
              const name = chat.supplierName || chat.phone;
              const lastTime = chat.lastAt
                ? new Date(chat.lastAt).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })
                : "";
              return (
                <div
                  key={chat.phone}
                  onClick={() => void handleSelect(chat.phone)}
                  className={cn(
                    "flex items-center gap-3 px-3 py-3 cursor-pointer transition-colors hover:bg-[#f5f5f5] border-b border-[#f0f2f5]",
                    isActive && "bg-[#e8f5e9]",
                  )}
                  style={{ direction: "rtl" }}
                >
                  <div className="relative flex-shrink-0">
                    <Avatar name={name} phone={chat.phone} size={44} />
                    {(chat.unread || 0) > 0 && (
                      <span
                        className="absolute -top-1 -left-1 min-w-[18px] h-[18px] rounded-full text-[10px] flex items-center justify-center text-white font-bold"
                        style={{ background: WA_GREEN }}
                      >
                        {chat.unread > 99 ? "99+" : chat.unread}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-baseline gap-1">
                      <span className="text-[10px] text-muted-foreground flex-shrink-0">{lastTime}</span>
                      <span className="font-semibold text-sm text-foreground truncate">{name}</span>
                    </div>
                    <div className="flex justify-end mt-0.5">
                      <p className="text-xs text-muted-foreground truncate max-w-full">{chat.lastMessage}</p>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── RIGHT: Chat Window ─────────────────────────────────────────── */}
      {selected ? (
        <div className="flex-1 flex flex-col min-w-0">
          {/* Chat header */}
          <div
            className="h-16 bg-[#f0f2f5] px-4 flex items-center gap-3 border-b border-border flex-shrink-0"
            style={{ direction: "rtl" }}
          >
            <Avatar name={displayName} phone={selected} size={40} />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm leading-tight">{displayName}</div>
              <div className="text-xs text-muted-foreground leading-tight" dir="ltr">{selected}</div>
            </div>
            <button
              onClick={() => void handleRefresh()}
              className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-black/10 transition-colors"
            >
              <RefreshCw size={15} className={cn("text-muted-foreground", refreshing && "animate-spin")} />
            </button>
          </div>

          {/* Messages area */}
          <div
            className="flex-1 overflow-y-auto p-4"
            style={{
              background: "#e5ddd5",
              backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%2300000006'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
            }}
          >
            {loading ? (
              <div className="flex justify-center py-12">
                <Loader2 size={28} className="animate-spin text-muted-foreground" />
              </div>
            ) : messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 py-16">
                <div className="w-16 h-16 rounded-full bg-white/70 flex items-center justify-center shadow-sm">
                  <MessageSquare size={28} className="opacity-30" />
                </div>
                <p className="text-sm text-muted-foreground">{t("whatsapp.noMessages")}</p>
                <p className="text-xs text-muted-foreground">{t("whatsapp.startChat")}</p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {messages.map((msg, idx) => {
                  const isOut = msg.direction === "outbound";
                  const prevMsg = messages[idx - 1];
                  const showDate =
                    !prevMsg ||
                    new Date(msg.createdAt).toDateString() !== new Date(prevMsg.createdAt).toDateString();
                  const timeStr = new Date(msg.createdAt).toLocaleTimeString("ar-EG", {
                    hour: "2-digit",
                    minute: "2-digit",
                  });

                  return (
                    <div key={msg.id}>
                      {/* Date separator */}
                      {showDate && (
                        <div className="flex justify-center my-4">
                          <span className="text-xs bg-white/80 text-muted-foreground px-3 py-1 rounded-full shadow-sm">
                            {new Date(msg.createdAt).toLocaleDateString("ar-EG", {
                              weekday: "long",
                              day: "numeric",
                              month: "long",
                            })}
                          </span>
                        </div>
                      )}

                      {/* Message row */}
                      <div
                        className={cn("flex gap-1.5 group mb-1", isOut ? "justify-end" : "justify-start")}
                        style={{ direction: "ltr" }}
                        onMouseEnter={() => setHoveredMsgId(msg.id)}
                        onMouseLeave={() => { setHoveredMsgId(null); setEmojiPickerForMsg(null); }}
                      >
                        {!isOut && <Avatar name={displayName} phone={selected} size={28} />}

                        <div className="relative" style={{ maxWidth: "65%" }}>
                          {/* Hover action buttons */}
                          <div
                            className={cn(
                              "absolute top-0 z-10 flex items-center gap-0.5 transition-opacity",
                              hoveredMsgId === msg.id ? "opacity-100" : "opacity-0 pointer-events-none",
                              isOut ? "right-full mr-1.5" : "left-full ml-1.5",
                            )}
                          >
                            {/* Reply */}
                            <button
                              onClick={() => { setReplyingTo(msg); setHoveredMsgId(null); setTimeout(() => textareaRef.current?.focus(), 50); }}
                              className="w-7 h-7 rounded-full bg-white shadow-md flex items-center justify-center hover:bg-gray-50 transition-colors"
                              title="رد"
                            >
                              <ArrowLeft size={13} className="text-muted-foreground" />
                            </button>
                            {/* Forward */}
                            <button
                              onClick={() => { setForwardingMsg(msg); setHoveredMsgId(null); }}
                              className="w-7 h-7 rounded-full bg-white shadow-md flex items-center justify-center hover:bg-gray-50 transition-colors"
                              title="إعادة توجيه"
                            >
                              <ChevronRight size={13} className="text-muted-foreground" />
                            </button>
                            {/* Emoji reaction */}
                            {msg.waMessageId && (
                              <div className="relative">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEmojiPickerForMsg(emojiPickerForMsg === msg.waMessageId ? null : (msg.waMessageId ?? null));
                                  }}
                                  className="w-7 h-7 rounded-full bg-white shadow-md flex items-center justify-center hover:bg-gray-50 transition-colors"
                                  title="تفاعل"
                                >
                                  <Smile size={13} className="text-muted-foreground" />
                                </button>
                                {emojiPickerForMsg === msg.waMessageId && (
                                  <div
                                    className={cn(
                                      "absolute bottom-9 bg-white rounded-2xl shadow-xl border border-border/50 p-1.5 flex gap-0.5 z-30",
                                      isOut ? "right-0" : "left-0",
                                    )}
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {QUICK_EMOJIS.map((em) => (
                                      <button
                                        key={em}
                                        onClick={() => { void handleReact(msg.waMessageId!, em); setEmojiPickerForMsg(null); }}
                                        className="w-8 h-8 text-lg hover:bg-muted rounded-xl transition-colors flex items-center justify-center"
                                      >
                                        {em}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                            {/* Delete */}
                            <button
                              onClick={() => void handleDeleteMsg(msg.id)}
                              className="w-7 h-7 rounded-full bg-white shadow-md flex items-center justify-center hover:bg-red-50 transition-colors"
                              title="حذف"
                            >
                              <Trash2 size={13} className="text-red-400" />
                            </button>
                          </div>

                          {/* Message bubble */}
                          <div
                            className={cn(
                              "rounded-2xl px-3 py-2 shadow-sm cursor-default select-text",
                              isOut ? "rounded-tr-md" : "rounded-tl-md bg-white",
                            )}
                            style={isOut ? { background: "#DCF8C6" } : {}}
                            onDoubleClick={() => { setReplyingTo(msg); setTimeout(() => textareaRef.current?.focus(), 50); }}
                          >
                            {/* Reply quote */}
                            {msg.replyToMessageId && (
                              <div
                                className={cn(
                                  "mb-2 border-r-[3px] pr-2.5 py-1 rounded-sm text-right",
                                  isOut ? "border-green-600 bg-green-50/60" : "border-green-500 bg-gray-50",
                                )}
                              >
                                <p className="text-[10px] font-bold text-green-700 mb-0.5">ردًا على رسالة</p>
                                <p className="text-xs text-muted-foreground truncate">
                                  {getReplyBody(msg.replyToMessageId)}
                                </p>
                              </div>
                            )}

                            {/* Content */}
                            {msg.mediaId ? (
                              <MediaMessage msg={msg} />
                            ) : (
                              <p className="text-sm whitespace-pre-wrap break-words" dir="auto">
                                {msg.body}
                              </p>
                            )}

                            {/* Reactions */}
                            {(msg.reactions?.length || 0) > 0 && (
                              <div className="flex gap-0.5 mt-1.5 flex-wrap">
                                {msg.reactions!.map((r, i) => (
                                  <span key={i} className="text-base leading-none" title={r.reactorPhone}>
                                    {r.emoji}
                                  </span>
                                ))}
                              </div>
                            )}

                            {/* Timestamp + tick */}
                            <div
                              className={cn(
                                "flex items-center gap-1 mt-1",
                                isOut ? "justify-end" : "justify-start",
                              )}
                            >
                              <span className="text-[10px] text-gray-400">{timeStr}</span>
                              {isOut && <CheckCheck size={12} className="text-blue-400" />}
                            </div>
                          </div>
                        </div>

                        {isOut && <Avatar name="أنا" phone="me" size={28} />}
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEnd} />
              </div>
            )}
          </div>

          {/* Reply strip */}
          {replyingTo && (
            <div
              className="bg-white border-t-2 border-green-300 px-4 py-2 flex items-center gap-3 flex-shrink-0"
              style={{ direction: "rtl" }}
            >
              <button
                onClick={() => setReplyingTo(null)}
                className="text-muted-foreground hover:text-foreground flex-shrink-0 transition-colors"
              >
                <X size={16} />
              </button>
              <div className="flex-1 border-r-4 border-green-500 pr-3 min-w-0">
                <p className="text-xs font-bold text-green-600 mb-0.5">ردًا على</p>
                <p className="text-xs text-muted-foreground truncate">
                  {replyingTo.mediaId ? `📎 ${replyingTo.body}` : replyingTo.body}
                </p>
              </div>
              <ArrowLeft size={16} className="text-green-500 flex-shrink-0" />
            </div>
          )}

          {/* File preview strip */}
          {pendingFile && (
            <div
              className="bg-white border-t border-border px-4 py-2.5 flex items-center gap-3 flex-shrink-0"
              style={{ direction: "rtl" }}
            >
              <button
                onClick={() => setPendingFile(null)}
                className="text-muted-foreground hover:text-foreground flex-shrink-0"
              >
                <X size={16} />
              </button>
              {pendingFile.preview ? (
                <img
                  src={pendingFile.preview}
                  alt="preview"
                  className="h-16 w-16 object-cover rounded-lg border border-border shadow-sm"
                />
              ) : (
                <div className="flex items-center gap-2 text-sm">
                  <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                    <FileText size={20} className="text-blue-500" />
                  </div>
                  <div>
                    <p className="font-medium truncate max-w-[200px]">{pendingFile.file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(pendingFile.file.size / 1024).toFixed(0)} KB
                    </p>
                  </div>
                </div>
              )}
              <div className="flex-1" />
              <span className="text-xs text-muted-foreground">جاهز للإرسال</span>
            </div>
          )}

          {/* Input bar */}
          <div
            className="bg-[#f0f2f5] px-3 py-2.5 flex items-end gap-2 flex-shrink-0 border-t border-border/40"
            style={{ direction: "ltr" }}
          >
            <button
              onClick={() => void handleSend()}
              disabled={(!draft.trim() && !pendingFile) || sending}
              className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 transition-all disabled:opacity-40 shadow-sm"
              style={{ background: WA_GREEN }}
            >
              {sending || uploading ? (
                <Loader2 size={18} className="animate-spin text-white" />
              ) : (
                <Send size={18} className="text-white" />
              )}
            </button>
            <div className="flex-1 bg-white rounded-2xl px-3 py-2 flex items-end gap-2 border border-border/30 shadow-sm">
              <button
                onClick={() => fileRef.current?.click()}
                className="text-muted-foreground hover:text-green-600 transition-colors flex-shrink-0 mb-0.5"
                title="إرفاق ملف أو صورة"
              >
                <Paperclip size={20} />
              </button>
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
                }}
                onKeyDown={handleKeyDown}
                placeholder={t("whatsapp.typeMessage") || "اكتب رسالة..."}
                className="flex-1 resize-none text-sm focus:outline-none bg-transparent min-h-[24px] max-h-[120px] leading-relaxed"
                rows={1}
                dir="auto"
              />
            </div>
          </div>

          {/* Hidden file input */}
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={handleFileChange}
            accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.txt,.csv"
          />
        </div>
      ) : (
        /* Empty state: no chat selected */
        <div className="flex-1 flex flex-col items-center justify-center gap-4 bg-[#f0f2f5]">
          <div className="w-24 h-24 rounded-full bg-white/70 flex items-center justify-center shadow-sm">
            <MessageSquare size={40} className="opacity-25" style={{ color: WA_GREEN }} />
          </div>
          <div className="text-center">
            <p className="text-lg font-semibold text-foreground/60">{t("whatsapp.selectChat")}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {t("whatsapp.selectChatSub") || "اختر محادثة من القائمة للبدء"}
            </p>
          </div>
          <button
            onClick={() => setNewChatOpen(true)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-white text-sm font-medium shadow-md transition-transform hover:scale-105"
            style={{ background: WA_GREEN }}
          >
            <Plus size={16} />
            {t("whatsapp.newChat") || "محادثة جديدة"}
          </button>
        </div>
      )}

      {/* ── Forward Modal ──────────────────────────────────────────────── */}
      {forwardingMsg && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={() => setForwardingMsg(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div
              className="p-4 border-b flex items-center justify-between"
              style={{ direction: "rtl" }}
            >
              <button
                onClick={() => setForwardingMsg(null)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={18} />
              </button>
              <div className="text-center flex-1">
                <h3 className="font-bold text-base">إعادة توجيه الرسالة</h3>
                <p className="text-xs text-muted-foreground truncate max-w-[240px] mx-auto">
                  {forwardingMsg.body.substring(0, 60)}{forwardingMsg.body.length > 60 ? "…" : ""}
                </p>
              </div>
              <ChevronRight size={18} className="text-green-600" />
            </div>

            {/* Contact list */}
            <div className="max-h-80 overflow-y-auto">
              {[
                ...filteredChats,
                ...contacts.filter(
                  (c) => c.phone && !filteredChats.find((ch) => ch.phone === c.phone),
                ),
              ].map((item) => {
                const isChat = "lastAt" in item;
                const phone = isChat ? (item as Chat).phone : (item as Supplier).phone ?? "";
                const name = isChat
                  ? ((item as Chat).supplierName ?? phone)
                  : ((item as Supplier).name ?? phone);
                if (!phone) return null;
                return (
                  <div
                    key={phone}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50 cursor-pointer border-b border-border/30 transition-colors"
                    style={{ direction: "rtl" }}
                    onClick={() => void handleForwardTo(phone)}
                  >
                    <Avatar name={name} phone={phone} size={40} />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{name}</p>
                      <p className="text-xs text-muted-foreground" dir="ltr">{phone}</p>
                    </div>
                    <ChevronRight size={14} className="text-muted-foreground flex-shrink-0" />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Toast ─────────────────────────────────────────────────────── */}
      {toast && (
        <div
          onClick={() => { if (toast.phone) void handleSelect(toast.phone); setToast(null); }}
          className={cn(
            "fixed bottom-6 left-6 z-50 px-4 py-3 rounded-xl shadow-xl text-sm font-medium flex items-center gap-2.5 cursor-pointer max-w-xs",
            "transition-all animate-in slide-in-from-bottom-2 duration-200",
            toast.ok ? "text-white" : "bg-amber-500 text-white",
          )}
          style={toast.ok ? { background: WA_GREEN } : {}}
        >
          {toast.ok ? <Check size={14} /> : <AlertCircle size={14} />}
          <span className="flex-1" dir="rtl">{toast.msg}</span>
          {toast.phone && <ChevronRight size={14} className="opacity-70 flex-shrink-0" />}
        </div>
      )}
    </div>
  );
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let setActiveTabExternal: ((t: Tab) => void) | undefined;

// ══════════════════════════════════════════════════════════════════════════
// TEMPLATES TAB
// ══════════════════════════════════════════════════════════════════════════
function TemplatesTab() {
  const { t, dir } = useLanguage();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [sendPhone, setSendPhone] = useState("");
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [contacts, setContacts] = useState<Supplier[]>([]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch("/api/whatsapp/templates", { credentials: "include" })
      .then((r) =>
        r.ok
          ? r.json()
          : r.json().then((e) => {
              throw new Error(e.error || "خطأ");
            }),
      )
      .then((data) => {
        setTemplates(data.templates || []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    fetch("/api/whatsapp/contacts", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then(setContacts)
      .catch(() => {});
  }, []);

  const filtered = templates.filter((tmpl) => {
    const matchSearch = !search || tmpl.name.toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === "ALL" || tmpl.status === filterStatus;
    return matchSearch && matchStatus;
  });

  const statuses = ["ALL", ...Array.from(new Set(templates.map((tmpl) => tmpl.status)))];

  function getStatusColor(status: string) {
    if (status === "APPROVED") return "text-green-600 bg-green-50";
    if (status === "PENDING") return "text-amber-600 bg-amber-50";
    if (status === "REJECTED") return "text-red-600 bg-red-50";
    return "text-muted-foreground bg-muted";
  }
  function getStatusLabel(status: string) {
    if (status === "APPROVED") return t("whatsapp.templates.status.APPROVED");
    if (status === "PENDING") return t("whatsapp.templates.status.PENDING");
    if (status === "REJECTED") return t("whatsapp.templates.status.REJECTED");
    return status;
  }

  async function handleSendTemplate() {
    if (!selectedTemplate || !sendPhone.trim()) return;
    setSending(true);
    setSendResult(null);
    try {
      const r = await fetch("/api/whatsapp/send-template", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: sendPhone.trim(),
          templateName: selectedTemplate.name,
          language: selectedTemplate.language,
        }),
      });
      const data = await r.json();
      if (r.ok) setSendResult({ ok: true, msg: t("whatsapp.sendSuccess") });
      else setSendResult({ ok: false, msg: data.error || t("whatsapp.sendFailed") });
    } catch (e) {
      setSendResult({ ok: false, msg: t("whatsapp.sendFailed") });
    } finally {
      setSending(false);
    }
  }

  function getTemplatePreview(tpl: Template): string {
    const body = tpl.components?.find((c) => c.type === "BODY");
    return body?.text || t("whatsapp.templates.noPreview");
  }
  function getTemplateHeader(tpl: Template): string | null {
    const header = tpl.components?.find((c) => c.type === "HEADER");
    return header?.text || null;
  }
  function getTemplateButtons(tpl: Template): Array<{ text: string; type: string }> {
    const btns = tpl.components?.find((c) => c.type === "BUTTONS");
    return btns?.buttons?.map((b) => ({ text: b.text, type: b.type })) || [];
  }

  return (
    <div className="h-full flex" dir={dir}>
      {/* Template List */}
      <div className="w-72 flex-shrink-0 bg-white border-l border-border flex flex-col">
        <div className="p-3 border-b border-border">
          <h2 className="font-bold text-sm mb-2">{t("whatsapp.templates.title")}</h2>
          <div className="relative mb-2">
            <Search
              size={13}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("whatsapp.templates.search")}
              className="w-full bg-[#f0f2f5] rounded-full pl-3 pr-8 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-green-400"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {statuses.map((s) => (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                className={cn(
                  "text-[10px] px-2 py-0.5 rounded-full transition-all font-medium",
                  filterStatus === s ? "text-white" : "bg-muted text-muted-foreground",
                )}
                style={filterStatus === s ? { background: WA_GREEN } : {}}
              >
                {s === "ALL" ? t("whatsapp.filter.all") : getStatusLabel(s)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="p-4 text-center">
              <AlertCircle size={24} className="text-red-400 mx-auto mb-2" />
              <p className="text-xs text-red-500">{error}</p>
              <p className="text-xs text-muted-foreground mt-1">
                Check WHATSAPP_BUSINESS_ACCOUNT_ID
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-center text-muted-foreground text-xs">
              {templates.length === 0
                ? t("whatsapp.templates.noTemplates")
                : t("whatsapp.templates.noResults")}
            </div>
          ) : (
            filtered.map((tmpl) => (
              <button
                key={tmpl.name}
                onClick={() => {
                  setSelectedTemplate(tmpl);
                  setSendResult(null);
                }}
                className={cn(
                  "w-full text-right px-3 py-2.5 border-b border-border/40 hover:bg-[#f0f2f5] transition-colors",
                  selectedTemplate?.name === tmpl.name && "bg-[#f0f2f5]",
                )}
              >
                <div className="flex items-center justify-between gap-1 mb-0.5">
                  <span
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                      getStatusColor(tmpl.status),
                    )}
                  >
                    {getStatusLabel(tmpl.status)}
                  </span>
                  <span className="text-xs font-semibold text-foreground truncate">
                    {tmpl.name}
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground text-right">
                  {tmpl.category} · {tmpl.language}
                </div>
              </button>
            ))
          )}
        </div>
        <div className="p-2 border-t border-border">
          <p className="text-[10px] text-muted-foreground text-center">
            {filtered.length} {t("whatsapp.templates.count")} {templates.length}
          </p>
        </div>
      </div>

      {/* Template Detail + Send */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#f0f2f5]">
        {!selectedTemplate ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <LayoutIcon size={48} className="opacity-20" />
            <p className="text-sm">{t("whatsapp.templates.select")}</p>
          </div>
        ) : (
          <div className="p-4 h-full overflow-y-auto">
            {/* Template Preview Card */}
            <div className="bg-white rounded-2xl shadow-sm p-5 mb-4 max-w-lg mx-auto">
              <div className="flex items-start justify-between mb-4">
                <span
                  className={cn(
                    "text-xs px-2 py-1 rounded-full font-medium",
                    getStatusColor(selectedTemplate.status),
                  )}
                >
                  {getStatusLabel(selectedTemplate.status)}
                </span>
                <div className="text-right">
                  <h3 className="font-bold text-base">{selectedTemplate.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {selectedTemplate.category} · {selectedTemplate.language}
                  </p>
                </div>
              </div>

              {/* WhatsApp message preview */}
              <div className="bg-[#e5ddd5] rounded-xl p-3 mb-4">
                <div className="bg-white rounded-xl p-3 shadow-sm max-w-[280px] mr-auto">
                  {getTemplateHeader(selectedTemplate) && (
                    <p className="font-bold text-sm mb-1 text-right">
                      {getTemplateHeader(selectedTemplate)}
                    </p>
                  )}
                  <p className="text-sm text-right whitespace-pre-wrap">
                    {getTemplatePreview(selectedTemplate)}
                  </p>
                  {getTemplateButtons(selectedTemplate).length > 0 && (
                    <div className="mt-2 pt-2 border-t border-border space-y-1">
                      {getTemplateButtons(selectedTemplate).map((btn, i) => (
                        <div
                          key={i}
                          className="text-center text-xs text-blue-500 font-medium py-0.5"
                        >
                          {btn.text}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Send form */}
              <div className="space-y-3">
                <h4 className="font-semibold text-sm text-right">{t("whatsapp.templates.send")}</h4>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1 text-right">
                    {t("whatsapp.templates.chooseSupplier")}
                  </label>
                  <select
                    value={sendPhone}
                    onChange={(e) => setSendPhone(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-400 mb-2"
                    dir={dir}
                  >
                    <option value="">{t("whatsapp.templates.selectSupplier")}</option>
                    {contacts.map((s) => (
                      <option key={s.id} value={s.phone || ""}>
                        {s.name} ({s.phone})
                      </option>
                    ))}
                  </select>
                  <input
                    value={sendPhone}
                    onChange={(e) => setSendPhone(e.target.value)}
                    placeholder={t("whatsapp.templates.phonePlaceholder")}
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-400"
                    dir="ltr"
                  />
                </div>
                {sendResult && (
                  <div
                    className={cn(
                      "flex items-center gap-2 p-2.5 rounded-lg text-sm",
                      sendResult.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600",
                    )}
                  >
                    {sendResult.ok ? <CheckCircle size={16} /> : <XCircle size={16} />}
                    {sendResult.msg}
                  </div>
                )}
                <button
                  onClick={handleSendTemplate}
                  disabled={!sendPhone.trim() || sending || selectedTemplate.status !== "APPROVED"}
                  className="w-full py-2.5 rounded-xl text-white font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  style={{ background: WA_GREEN }}
                >
                  {sending ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />{" "}
                      {t("whatsapp.templates.sending")}
                    </>
                  ) : (
                    <>
                      <Send size={16} /> {t("whatsapp.templates.send")}
                    </>
                  )}
                </button>
                {selectedTemplate.status !== "APPROVED" && (
                  <p className="text-xs text-amber-600 text-center">
                    {t("whatsapp.templates.notApproved")}
                  </p>
                )}
              </div>
            </div>

            {/* Template components breakdown */}
            {selectedTemplate.components && selectedTemplate.components.length > 0 && (
              <div className="max-w-lg mx-auto bg-white rounded-2xl shadow-sm p-4">
                <h4 className="font-bold text-sm mb-3 text-right">
                  {t("whatsapp.templates.components")}
                </h4>
                <div className="space-y-2">
                  {selectedTemplate.components.map((comp, i) => (
                    <div key={i} className="border border-border rounded-lg p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">
                          {comp.type}
                        </span>
                        {comp.format && (
                          <span className="text-xs text-muted-foreground">{comp.format}</span>
                        )}
                      </div>
                      {comp.text && (
                        <p className="text-xs text-foreground text-right">{comp.text}</p>
                      )}
                      {comp.buttons &&
                        comp.buttons.map((btn, j) => (
                          <div key={j} className="text-xs text-blue-600 text-right mt-1">
                            [{btn.type}] {btn.text} {btn.url && `→ ${btn.url}`}
                          </div>
                        ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// BROADCAST TAB
// ══════════════════════════════════════════════════════════════════════════
function BroadcastTab() {
  const { t, dir } = useLanguage();
  const [contacts, setContacts] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Array<{
    phone: string;
    ok: boolean;
    error?: string;
    name?: string;
  }> | null>(null);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("ALL");

  useEffect(() => {
    fetch("/api/whatsapp/contacts", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        setContacts(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const categories = ["ALL", ...Array.from(new Set(contacts.map((c) => c.category))).sort()];
  const filtered = contacts.filter((c) => {
    const matchSearch =
      !search ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.phone || "").includes(search);
    const matchCat = filterCategory === "ALL" || c.category === filterCategory;
    return matchSearch && matchCat;
  });

  function toggleAll() {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((c) => c.id)));
  }

  async function handleBroadcast() {
    const chosen = contacts.filter((c) => selected.has(c.id) && c.phone);
    if (!chosen.length || !message.trim()) return;
    setSending(true);
    setResults(null);
    try {
      const r = await fetch("/api/whatsapp/broadcast", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phones: chosen.map((c) => c.phone!),
          supplierIds: chosen.map((c) => c.id),
          message: message.trim(),
        }),
      });
      const data = await r.json();
      const enriched = (data.results || []).map(
        (res: { phone: string; ok: boolean; error?: string }, i: number) => ({
          ...res,
          name: chosen[i]?.name,
        }),
      );
      setResults(enriched);
    } catch {
      setResults([{ phone: "error", ok: false, error: t("whatsapp.broadcast.errorServer") }]);
    } finally {
      setSending(false);
    }
  }

  const selectedContacts = contacts.filter((c) => selected.has(c.id));

  return (
    <div className="h-full flex" dir={dir}>
      {/* Contact Selection */}
      <div className="w-72 flex-shrink-0 bg-white border-l border-border flex flex-col">
        <div className="p-3 border-b border-border">
          <div className="flex items-center justify-between mb-2">
            <button
              onClick={toggleAll}
              className="text-xs text-green-600 font-medium hover:underline"
            >
              {selected.size === filtered.length
                ? t("whatsapp.broadcast.deselectAll")
                : t("whatsapp.broadcast.selectAll")}
            </button>
            <h2 className="font-bold text-sm">{t("whatsapp.broadcast.selectSuppliers")}</h2>
          </div>
          <div className="relative mb-2">
            <Search
              size={13}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("whatsapp.broadcast.search")}
              className="w-full bg-[#f0f2f5] rounded-full pl-3 pr-8 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-green-400"
            />
          </div>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="w-full text-xs border rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-green-400"
            dir={dir}
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {c === "ALL" ? t("whatsapp.broadcast.allCategories") : c}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-center text-muted-foreground text-xs">
              {t("whatsapp.broadcast.noSuppliers")}
            </div>
          ) : (
            filtered.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  const next = new Set(selected);
                  if (next.has(c.id)) next.delete(c.id);
                  else next.add(c.id);
                  setSelected(next);
                }}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2.5 border-b border-border/40 hover:bg-[#f0f2f5] transition-colors text-right",
                )}
              >
                <div
                  className={cn(
                    "w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all",
                    selected.has(c.id) ? "border-green-500" : "border-muted-foreground/40",
                  )}
                  style={selected.has(c.id) ? { background: WA_GREEN, borderColor: WA_GREEN } : {}}
                >
                  {selected.has(c.id) && <Check size={10} className="text-white" />}
                </div>
                <Avatar name={c.name} phone={c.phone || c.name} size={32} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">{c.name}</div>
                  <div className="text-[10px] text-muted-foreground">{c.phone}</div>
                </div>
              </button>
            ))
          )}
        </div>
        <div className="p-2 border-t border-border">
          <p className="text-[10px] text-muted-foreground text-center">
            {selected.size} {t("whatsapp.broadcast.selected")} {contacts.length}
          </p>
        </div>
      </div>

      {/* Compose Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#f0f2f5] p-4">
        <div className="max-w-xl mx-auto w-full space-y-4">
          {/* Selected Contacts Preview */}
          {selectedContacts.length > 0 && (
            <div className="bg-white rounded-2xl p-4 shadow-sm">
              <h3 className="font-semibold text-sm mb-2 text-right">
                {t("whatsapp.broadcast.recipients")} ({selectedContacts.length})
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {selectedContacts.slice(0, 12).map((c) => (
                  <span
                    key={c.id}
                    className="flex items-center gap-1 text-xs bg-[#f0f2f5] rounded-full px-2 py-1"
                  >
                    <button
                      onClick={() => {
                        const n = new Set(selected);
                        n.delete(c.id);
                        setSelected(n);
                      }}
                      className="text-muted-foreground hover:text-red-500"
                    >
                      <X size={10} />
                    </button>
                    {c.name}
                  </span>
                ))}
                {selectedContacts.length > 12 && (
                  <span className="text-xs text-muted-foreground py-1">
                    +{selectedContacts.length - 12} {t("whatsapp.broadcast.moreRecipients")}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Message Compose */}
          <div className="bg-white rounded-2xl p-4 shadow-sm">
            <h3 className="font-semibold text-sm mb-3 text-right">
              {t("whatsapp.broadcast.writeMessage")}
            </h3>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t("whatsapp.broadcast.placeholder")}
              rows={6}
              className="w-full border rounded-xl px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-green-400/30 focus:border-green-400/60"
              dir={dir}
            />
            <div className="flex items-center justify-between mt-3">
              <span className="text-xs text-muted-foreground">
                {message.length} {t("whatsapp.broadcast.chars")}
              </span>
              <button
                onClick={handleBroadcast}
                disabled={selected.size === 0 || !message.trim() || sending}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-white font-semibold text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: WA_GREEN }}
              >
                {sending ? (
                  <>
                    <Loader2 size={16} className="animate-spin" /> {t("whatsapp.broadcast.sending")}
                  </>
                ) : (
                  <>
                    <Zap size={16} /> {t("whatsapp.broadcast.send")} {selected.size}{" "}
                    {t("whatsapp.broadcast.supplier")}
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Results */}
          {results && (
            <div className="bg-white rounded-2xl p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <div className="flex gap-3 text-xs">
                  <span className="text-green-600 font-medium flex items-center gap-1">
                    <CheckCircle size={12} />
                    {results.filter((r) => r.ok).length} {t("whatsapp.broadcast.succeeded")}
                  </span>
                  <span className="text-red-500 font-medium flex items-center gap-1">
                    <XCircle size={12} />
                    {results.filter((r) => !r.ok).length} {t("whatsapp.broadcast.failed")}
                  </span>
                </div>
                <h4 className="font-semibold text-sm">{t("whatsapp.broadcast.results")}</h4>
              </div>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {results.map((r, i) => (
                  <div
                    key={i}
                    className={cn(
                      "flex items-center gap-2 text-xs p-2 rounded-lg",
                      r.ok ? "bg-green-50" : "bg-red-50",
                    )}
                  >
                    {r.ok ? (
                      <CheckCircle size={13} className="text-green-500 flex-shrink-0" />
                    ) : (
                      <XCircle size={13} className="text-red-400 flex-shrink-0" />
                    )}
                    <span className="font-medium">{r.name || r.phone}</span>
                    {r.error && <span className="text-red-500 truncate">{r.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// SETTINGS TAB
// ══════════════════════════════════════════════════════════════════════════
function SettingsTab() {
  const { t, dir } = useLanguage();
  const [diagnose, setDiagnose] = useState<DiagnoseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [testPhone, setTestPhone] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/whatsapp/diagnose", { credentials: "include" }).then((r) =>
        r.ok ? r.json() : null,
      ),
      fetch("/api/whatsapp/stats", { credentials: "include" }).then((r) =>
        r.ok ? r.json() : null,
      ),
    ])
      .then(([d, s]) => {
        if (d) setDiagnose(d);
        if (s) setStats(s);
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleTestSend() {
    if (!testPhone.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch("/api/whatsapp/send", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: testPhone.trim(),
          message: "✅ WhatsApp Business connection test — Meta Cloud API",
        }),
      });
      const data = await r.json();
      setTestResult(r.ok ? `✅ ${t("whatsapp.sendSuccess")}` : `❌ ${data.error}`);
    } catch {
      setTestResult(`❌ ${t("whatsapp.sendFailed")}`);
    } finally {
      setTesting(false);
    }
  }

  function copyWebhookUrl() {
    const url = `${window.location.origin}/api/webhook/whatsapp`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const webhookUrl = `${typeof window !== "undefined" ? window.location.origin : "https://your-app.onrender.com"}/api/webhook/whatsapp`;

  return (
    <div className="h-full overflow-y-auto p-4 bg-[#f0f2f5]" dir={dir}>
      <div className="max-w-2xl mx-auto space-y-4">
        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 size={28} className="animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Account Status Card */}
            <div className="bg-white rounded-2xl shadow-sm p-5">
              <div className="flex items-center gap-2 mb-4">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center"
                  style={{ background: WA_GREEN }}
                >
                  <Phone size={18} className="text-white" />
                </div>
                <h2 className="font-bold text-base">{t("whatsapp.settings.accountStatus")}</h2>
              </div>
              {!diagnose?.configured ? (
                <div className="flex items-center gap-2 p-3 bg-red-50 rounded-xl text-red-600 text-sm">
                  <AlertCircle size={18} />
                  {diagnose?.error || t("whatsapp.settings.notConfigured")}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-3 bg-green-50 rounded-xl">
                    <CheckCircle size={20} className="text-green-500 flex-shrink-0" />
                    <div className="flex-1 text-right">
                      <div className="font-bold text-sm text-green-800">
                        {diagnose.phone?.verified_name || t("whatsapp.settings.configured")}
                      </div>
                      <div className="text-xs text-green-600">
                        {diagnose.phone?.display_phone_number} · {diagnose.phone?.status}
                      </div>
                    </div>
                  </div>
                  {diagnose.phone?.quality_rating && (
                    <div className="flex items-center justify-between text-sm border border-border rounded-xl p-3">
                      <span
                        className={cn(
                          "font-bold",
                          diagnose.phone.quality_rating === "HIGH"
                            ? "text-green-600"
                            : diagnose.phone.quality_rating === "MEDIUM"
                              ? "text-amber-600"
                              : "text-red-600",
                        )}
                      >
                        {diagnose.phone.quality_rating === "HIGH"
                          ? t("whatsapp.settings.quality.HIGH")
                          : diagnose.phone.quality_rating === "MEDIUM"
                            ? t("whatsapp.settings.quality.MEDIUM")
                            : t("whatsapp.settings.quality.LOW")}
                      </span>
                      <span className="text-muted-foreground">
                        {t("whatsapp.settings.messageQuality")}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Stats Card */}
            {stats && (
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <h2 className="font-bold text-base mb-4 flex items-center gap-2">
                  <BarChart2 size={18} className="text-green-500" />
                  {t("whatsapp.settings.statistics")}
                </h2>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    {
                      label: t("whatsapp.settings.totalChats"),
                      value: stats.totalChats,
                      color: "text-blue-600",
                    },
                    {
                      label: t("whatsapp.settings.unread"),
                      value: stats.unread,
                      color: "text-red-500",
                    },
                    {
                      label: t("whatsapp.settings.inbound"),
                      value: stats.inbound,
                      color: "text-green-600",
                    },
                    {
                      label: t("whatsapp.settings.outbound"),
                      value: stats.outbound,
                      color: "text-purple-600",
                    },
                  ].map((s) => (
                    <div key={s.label} className="border border-border rounded-xl p-3 text-right">
                      <div className={cn("text-2xl font-bold", s.color)}>{s.value || 0}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Webhook Config Card */}
            <div className="bg-white rounded-2xl shadow-sm p-5">
              <h2 className="font-bold text-base mb-4 flex items-center gap-2">
                <Zap size={18} className="text-amber-500" />
                {t("whatsapp.settings.webhook")}
              </h2>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1 text-right">
                    {t("whatsapp.settings.webhookUrl")}
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={copyWebhookUrl}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-all",
                        copied
                          ? "border-green-400 text-green-600 bg-green-50"
                          : "border-border hover:bg-muted",
                      )}
                    >
                      {copied ? (
                        <>
                          <CheckCircle size={12} /> {t("whatsapp.settings.copied")}
                        </>
                      ) : (
                        <>
                          <Copy size={12} /> {t("whatsapp.settings.copy")}
                        </>
                      )}
                    </button>
                    <div className="flex-1 bg-[#f0f2f5] rounded-lg px-3 py-1.5 text-xs font-mono text-muted-foreground truncate text-left">
                      {webhookUrl}
                    </div>
                  </div>
                </div>
                <div className="bg-amber-50 rounded-xl p-3 text-xs text-amber-700 space-y-1 text-right">
                  <p className="font-semibold">{t("whatsapp.settings.webhookSteps")}</p>
                  <ol className="space-y-0.5 list-decimal list-inside text-right">
                    <li>{t("whatsapp.settings.webhookStep1")}</li>
                    <li>{t("whatsapp.settings.webhookStep2")}</li>
                    <li>{t("whatsapp.settings.webhookStep3")}</li>
                    <li>{t("whatsapp.settings.webhookStep4")}</li>
                  </ol>
                </div>
                <a
                  href="https://developers.facebook.com/apps"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-1.5 text-xs text-blue-600 hover:underline"
                >
                  <ExternalLink size={12} />
                  {t("whatsapp.settings.openMeta")}
                </a>
              </div>
            </div>

            {/* Credentials Status */}
            {diagnose?.creds && (
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <h2 className="font-bold text-base mb-4 flex items-center gap-2">
                  <Eye size={18} className="text-blue-500" />
                  {t("whatsapp.settings.envVars")}
                </h2>
                <div className="space-y-2">
                  {Object.entries(diagnose.creds).map(([key, val]) => {
                    if (key === "template_names" || key === "template_lang") return null;
                    const isOk = String(val).startsWith("✓");
                    return (
                      <div
                        key={key}
                        className="flex items-center justify-between text-xs border border-border rounded-lg p-2.5"
                      >
                        <span
                          className={cn("font-medium", isOk ? "text-green-600" : "text-red-500")}
                        >
                          {String(val)}
                        </span>
                        <span className="font-mono text-muted-foreground">{key}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Templates Summary */}
            {diagnose?.templates && (
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <h2 className="font-bold text-base mb-4 flex items-center gap-2">
                  <LayoutIcon size={18} className="text-purple-500" />
                  {t("whatsapp.settings.templatesSummary")}
                </h2>
                {diagnose.templates.warning ? (
                  <div className="text-xs text-amber-600 bg-amber-50 p-3 rounded-xl">
                    {diagnose.templates.warning}
                  </div>
                ) : diagnose.templates.error ? (
                  <div className="text-xs text-red-500 bg-red-50 p-3 rounded-xl">
                    {diagnose.templates.error}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      {t("whatsapp.settings.totalTemplates")} {diagnose.templates.total}
                    </p>
                    {(diagnose.templates.our_templates || []).map((tmpl) => (
                      <div
                        key={tmpl.name}
                        className="flex items-center justify-between text-xs border border-border rounded-lg p-2.5"
                      >
                        <span
                          className={cn(
                            "font-medium px-2 py-0.5 rounded-full",
                            tmpl.status === "APPROVED"
                              ? "text-green-600 bg-green-50"
                              : tmpl.status === "PENDING"
                                ? "text-amber-600 bg-amber-50"
                                : "text-red-500 bg-red-50",
                          )}
                        >
                          {tmpl.status === "APPROVED"
                            ? t("whatsapp.templates.status.APPROVED")
                            : tmpl.status === "PENDING"
                              ? t("whatsapp.templates.status.PENDING")
                              : tmpl.status}
                        </span>
                        <span className="font-mono text-foreground">{tmpl.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Test Send */}
            <div className="bg-white rounded-2xl shadow-sm p-5">
              <h2 className="font-bold text-base mb-4 flex items-center gap-2">
                <Send size={18} className="text-green-500" />
                {t("whatsapp.settings.testMessage")}
              </h2>
              <div className="flex gap-2">
                <button
                  onClick={handleTestSend}
                  disabled={!testPhone.trim() || testing}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-white text-sm font-medium transition-all disabled:opacity-40 flex-shrink-0"
                  style={{ background: WA_GREEN }}
                >
                  {testing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  {t("whatsapp.settings.send")}
                </button>
                <input
                  value={testPhone}
                  onChange={(e) => setTestPhone(e.target.value)}
                  placeholder={t("whatsapp.settings.phonePlaceholder")}
                  className="flex-1 border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-400/30"
                  dir="ltr"
                />
              </div>
              {testResult && (
                <div
                  className={cn(
                    "mt-2 p-2.5 rounded-xl text-sm",
                    testResult.startsWith("✅")
                      ? "bg-green-50 text-green-700"
                      : "bg-red-50 text-red-600",
                  )}
                >
                  {testResult}
                </div>
              )}
              <p className="text-xs text-muted-foreground mt-2 text-right">
                {t("whatsapp.settings.poweredBy")}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
