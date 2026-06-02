import { useState, useEffect, useRef, useCallback } from "react";
  import { Layout } from "@/components/Layout";
  import { MessageSquare, Send, Phone, RefreshCw, Paperclip, FileText, Download, X, Image as ImageIcon, Mic, Pencil, Trash2, Check, Info, Plus } from "lucide-react";
  import { cn } from "@/lib/utils";

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

  // ─── Avatar ───────────────────────────────────────────────────────────────
  const AVATAR_COLORS = ["#16a34a","#2563eb","#9333ea","#ea580c","#dc2626","#0891b2","#d97706","#0f766e"];
  function getAvatarColor(seed: string): string {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }

  function Avatar({ name, phone, size = 36 }: { name: string; phone?: string; size?: number }) {
    const [imgSrc, setImgSrc] = useState<string | null>(null);
    const [imgFailed, setImgFailed] = useState(false);
    useEffect(() => {
      if (!phone || imgFailed) return;
      setImgSrc(`/api/whatsapp/profile-picture/${encodeURIComponent(phone)}`);
    }, [phone, imgFailed]);
    const initial = name.trim()[0]?.toUpperCase() ?? "?";
    const color = getAvatarColor(name);
    if (imgSrc && !imgFailed) {
      return (
        <img src={imgSrc} alt={name}
          onError={() => { setImgFailed(true); setImgSrc(null); }}
          style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
      );
    }
    return (
      <div style={{
        width: size, height: size, background: color, borderRadius: "50%", flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "white", fontWeight: 700, fontSize: Math.round(size * 0.42),
      }}>{initial}</div>
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function formatTime(dateStr: string) {
    const d = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
    if (diffDays === 0) return d.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
    if (diffDays === 1) return "أمس";
    if (diffDays < 7) return d.toLocaleDateString("ar-EG", { weekday: "short" });
    return d.toLocaleDateString("ar-EG", { day: "2-digit", month: "2-digit" });
  }

  function formatLastSeen(dateStr: string | null): { text: string; isOnline: boolean } {
    if (!dateStr) return { text: "", isOnline: false };
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 5)  return { text: "متصل الآن", isOnline: true };
    if (diffMins < 60) return { text: `آخر ظهور منذ ${diffMins} دقيقة`, isOnline: false };
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return { text: `آخر ظهور منذ ${diffHours} ساعة`, isOnline: false };
    const diffDays = Math.floor(diffHours / 24);
    return { text: `آخر ظهور منذ ${diffDays} يوم`, isOnline: false };
  }

  function MediaContent({ msg }: { msg: Message }) {
    const [imgError, setImgError] = useState(false);
    const [lightbox, setLightbox] = useState(false);
    if (!msg.mediaId) return null;
    const mediaUrl = `/api/whatsapp/media/${msg.mediaId}`;
    if (msg.mediaType === "image") {
      if (imgError) return <div className="flex items-center gap-2 text-xs text-muted-foreground py-1"><ImageIcon size={14} /> تعذر تحميل الصورة</div>;
      return (
        <>
          <img src={mediaUrl} alt="صورة"
            className="max-w-full rounded-lg cursor-pointer max-h-64 object-cover mt-1 mb-0.5 border border-black/5"
            onError={() => setImgError(true)} onClick={() => setLightbox(true)} />
          {lightbox && (
            <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center" onClick={() => setLightbox(false)}>
              <button className="absolute top-4 right-4 text-white p-2 rounded-full bg-black/40 hover:bg-black/60"><X size={20} /></button>
              <img src={mediaUrl} alt="صورة" className="max-w-[90vw] max-h-[90vh] rounded-lg object-contain" />
            </div>
          )}
        </>
      );
    }
    if (msg.mediaType === "audio") {
      return <div className="mt-1 mb-0.5"><audio controls className="max-w-full h-9" style={{ minWidth: 200 }}><source src={mediaUrl} type={msg.mimeType || "audio/ogg"} />متصفحك لا يدعم تشغيل الصوت</audio></div>;
    }
    if (msg.mediaType === "document" || msg.mediaType === "video") {
      const isVideo = msg.mediaType === "video";
      return (
        <div className="mt-1 mb-0.5">
          {isVideo ? (
            <video controls className="max-w-full max-h-56 rounded-lg"><source src={mediaUrl} type={msg.mimeType || "video/mp4"} /></video>
          ) : (
            <a href={mediaUrl} download={msg.filename || "document"}
              className="flex items-center gap-2.5 bg-black/5 hover:bg-black/10 rounded-lg px-3 py-2 transition-colors group"
              target="_blank" rel="noreferrer">
              <FileText size={18} className="text-blue-500 flex-shrink-0" />
              <span className="text-xs text-foreground flex-1 truncate font-medium">{msg.filename || "مستند"}</span>
              <Download size={14} className="text-muted-foreground group-hover:text-foreground flex-shrink-0" />
            </a>
          )}
        </div>
      );
    }
    return null;
  }

  interface PendingFile { file: File; base64: string; preview?: string; }

  // ─── Browser notification helper ──────────────────────────────────────────
  async function requestNotificationPermission(): Promise<boolean> {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    const result = await Notification.requestPermission();
    return result === "granted";
  }

  function showBrowserNotification(title: string, body: string, onClick?: () => void) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const n = new Notification(title, { body, icon: "/logo.png", tag: "wa-message", renotify: true });
    if (onClick) n.onclick = () => { window.focus(); onClick(); n.close(); };
  }

  export default function WhatsAppPage() {
    const [chats, setChats] = useState<Chat[]>([]);
    const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
    const prevUnreadRef = useRef<number>(0);
    const [messages, setMessages] = useState<Message[]>([]);
    const [newMsg, setNewMsg] = useState("");
    const [sending, setSending] = useState(false);
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
    const [uploadProgress, setUploadProgress] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editText, setEditText] = useState("");
    const [hoveredId, setHoveredId] = useState<number | null>(null);
    const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
    const [newChatOpen, setNewChatOpen] = useState(false);
    const [newChatInput, setNewChatInput] = useState("");
    const [newChatError, setNewChatError] = useState("");
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const selectedPhoneRef = useRef<string | null>(null);
    const chatsRef = useRef<Chat[]>([]);

    // Keep refs in sync so SSE handler can read current values without stale closures
    useEffect(() => { selectedPhoneRef.current = selectedPhone; }, [selectedPhone]);
    useEffect(() => { chatsRef.current = chats; }, [chats]);

    function showToast(msg: string, ok: boolean) {
      setToast({ msg, ok });
      setTimeout(() => setToast(null), 3500);
    }

    function normalizePhoneFE(raw: string): string {
      let cleaned = raw.replace(/[\s\-()]/g, "").replace(/^\+/, "");
      if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);
      if (cleaned.length === 11 && cleaned.startsWith("0")) cleaned = "2" + cleaned;
      if (cleaned.length === 10 && cleaned.startsWith("1")) cleaned = "20" + cleaned;
      return cleaned;
    }

    function handleStartNewChat(e: React.FormEvent) {
      e.preventDefault();
      const raw = newChatInput.trim();
      if (!raw) { setNewChatError("أدخل رقم الهاتف"); return; }
      const normalized = normalizePhoneFE(raw);
      if (normalized.length < 7) { setNewChatError("رقم الهاتف غير صحيح"); return; }
      setNewChatOpen(false); setNewChatInput(""); setNewChatError("");
      handleSelectChat(normalized);
    }

    function playNotificationSound() {
      try {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioCtx();
        const gainNode = ctx.createGain();
        gainNode.connect(ctx.destination);
        gainNode.gain.setValueAtTime(0, ctx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        const osc1 = ctx.createOscillator();
        osc1.connect(gainNode);
        osc1.type = "sine";
        osc1.frequency.setValueAtTime(880, ctx.currentTime);
        osc1.frequency.setValueAtTime(1100, ctx.currentTime + 0.15);
        osc1.start(ctx.currentTime); osc1.stop(ctx.currentTime + 0.5);
        osc1.onended = () => ctx.close();
      } catch { /* browser may block until user interaction */ }
    }

    const loadChats = useCallback(async () => {
      try {
        const r = await fetch("/api/whatsapp/chats", { credentials: "include" });
        if (r.ok) {
          const data: Chat[] = await r.json();
          const totalUnread = data.reduce((sum, c) => sum + Number(c.unread ?? 0), 0);
          if (totalUnread > prevUnreadRef.current) playNotificationSound();
          prevUnreadRef.current = totalUnread;
          setChats(data);
          return data;
        }
      } catch { /* ignore */ }
      return null;
    }, []);

    const loadMessages = useCallback(async (phone: string) => {
      setLoading(true);
      try {
        const r = await fetch(`/api/whatsapp/chats/${encodeURIComponent(phone)}`, { credentials: "include" });
        if (r.ok) { setMessages(await r.json()); await loadChats(); }
      } finally { setLoading(false); }
    }, [loadChats]);

    // ─── SSE: real-time updates from server ───────────────────────────────
    useEffect(() => {
      // Request browser notification permission on mount
      requestNotificationPermission();

      let es: EventSource | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let alive = true;

      function connect() {
        if (!alive) return;
        es = new EventSource("/api/whatsapp/events", { withCredentials: true });

        es.onmessage = async (event: MessageEvent) => {
          if (!event.data || event.data.trim() === "") return;
          try {
            const payload = JSON.parse(event.data as string) as { type: string; phone?: string };
            if (payload.type !== "new_message") return;

            const incomingPhone = payload.phone ?? "";

            // Refresh chat list to update unread counts & last messages
            const freshChats = await loadChats();

            // If the incoming message is in the currently open conversation → reload messages
            if (incomingPhone && incomingPhone === selectedPhoneRef.current) {
              const r = await fetch(`/api/whatsapp/chats/${encodeURIComponent(incomingPhone)}`, { credentials: "include" });
              if (r.ok) setMessages(await r.json());
            } else {
              // Different conversation: show browser notification + toast
              const matchedChat = freshChats?.find(c => c.phone === incomingPhone);
              const senderName = matchedChat?.supplierName ?? incomingPhone;
              const lastMsg = matchedChat?.lastMessage ?? "رسالة جديدة";

              showBrowserNotification(
                `رسالة جديدة من ${senderName}`,
                lastMsg.slice(0, 100),
                () => { if (incomingPhone) handleSelectChat(incomingPhone); }
              );

              // In-app toast with click-to-open
              setToast({ msg: `رسالة جديدة من ${senderName}`, ok: true });
              setTimeout(() => setToast(null), 5000);
            }
          } catch { /* malformed event — ignore */ }
        };

        es.onerror = () => {
          es?.close();
          es = null;
          if (alive) reconnectTimer = setTimeout(connect, 5000);
        };
      }

      connect();

      // Fallback polling every 30 s (much less frequent now that SSE handles real-time)
      const poll = setInterval(async () => {
        await loadChats();
        if (selectedPhoneRef.current) {
          const r = await fetch(`/api/whatsapp/chats/${encodeURIComponent(selectedPhoneRef.current)}`, { credentials: "include" });
          if (r.ok) setMessages(await r.json());
        }
      }, 30000);

      return () => {
        alive = false;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        es?.close();
        clearInterval(poll);
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadChats]);

    // Initial load
    useEffect(() => { loadChats(); }, [loadChats]);

    useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

    async function handleSelectChat(phone: string) {
      setSelectedPhone(phone);
      setMessages([]);
      setPendingFile(null);
      setEditingId(null);
      await loadMessages(phone);
    }

    async function handleRefresh() {
      setRefreshing(true);
      await loadChats();
      if (selectedPhone) await loadMessages(selectedPhone);
      setRefreshing(false);
    }

    async function handleSend(e: React.FormEvent) {
      e.preventDefault();
      if (!selectedPhone || sending) return;
      if (pendingFile) { await handleSendMedia(); return; }
      if (!newMsg.trim()) return;
      setSending(true);
      const body = newMsg.trim();
      setNewMsg("");
      try {
        const r = await fetch("/api/whatsapp/send", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: selectedPhone, message: body, supplierId: selectedChat?.supplierId }),
        });
        if (r.ok) { await loadMessages(selectedPhone); }
        else { const err = await r.json(); alert("فشل الإرسال: " + (err.error || "خطأ غير معروف")); setNewMsg(body); }
      } catch { alert("خطأ في الاتصال"); setNewMsg(body); }
      finally { setSending(false); }
    }

    async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        setPendingFile({ file, base64: result.split(",")[1], preview: file.type.startsWith("image/") ? result : undefined });
      };
      reader.readAsDataURL(file);
      e.target.value = "";
    }

    async function handleSendMedia() {
      if (!pendingFile || !selectedPhone) return;
      setUploadProgress(true); setSending(true);
      try {
        const r = await fetch("/api/whatsapp/send-media", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: selectedPhone, supplierId: selectedChat?.supplierId,
            base64: pendingFile.base64, mimeType: pendingFile.file.type, filename: pendingFile.file.name }),
        });
        if (r.ok) { setPendingFile(null); await loadMessages(selectedPhone); }
        else { const err = await r.json(); alert("فشل إرسال الملف: " + (err.error || "خطأ غير معروف")); }
      } catch { alert("خطأ في الاتصال"); }
      finally { setUploadProgress(false); setSending(false); }
    }

    async function handleEditSave(msgId: number) {
      if (!editText.trim()) return;
      const r = await fetch(`/api/whatsapp/messages/${msgId}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: editText.trim() }),
      });
      if (r.ok) {
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, body: editText.trim() } : m));
        setEditingId(null);
      }
    }

    async function handleDelete(msgId: number) {
      const msg = messages.find(m => m.id === msgId);
      if (!confirm("هل تريد حذف هذه الرسالة؟ سيتم حذفها من WhatsApp ومن سجلاتنا.")) return;
      try {
        const r = await fetch(`/api/whatsapp/messages/${msgId}`, { method: "DELETE", credentials: "include" });
        if (r.ok) {
          const data = await r.json() as { ok: boolean; waDeletedOnPlatform?: boolean };
          setMessages(prev => prev.filter(m => m.id !== msgId));
          if (data.waDeletedOnPlatform) showToast("تم حذف الرسالة من WhatsApp وسجلاتنا", true);
          else if (msg?.waMessageId) showToast("تم الحذف من سجلاتنا — تعذر الحذف من WhatsApp (ربما انتهت المهلة)", false);
          else showToast("تم الحذف من سجلاتنا", true);
        } else {
          const err = await r.json().catch(() => ({ error: "خطأ في الخادم" }));
          showToast("فشل الحذف: " + (err.error || r.status), false);
        }
      } catch { showToast("خطأ في الاتصال أثناء الحذف", false); }
    }

    function getFileIcon(mime: string) {
      if (mime.startsWith("image/")) return <ImageIcon size={20} className="text-blue-500" />;
      if (mime.startsWith("audio/")) return <Mic size={20} className="text-purple-500" />;
      return <FileText size={20} className="text-blue-500" />;
    }

    const selectedChat = chats.find(c => c.phone === selectedPhone);
    const lastSeen = formatLastSeen(selectedChat?.lastInboundAt ?? null);
    const avatarSeed = selectedChat?.supplierName ?? selectedPhone ?? "?";

    return (
      <Layout>
        <div className="flex h-full" style={{ height: "calc(100vh - 0px)" }}>
          {/* Sidebar */}
          <div className="w-80 flex-shrink-0 border-r border-border flex flex-col bg-card">
            <div className="p-4 border-b border-border flex items-center justify-between">
              <div>
                <h1 className="text-base font-bold text-foreground flex items-center gap-2">
                  <MessageSquare size={18} className="text-green-600" /> WhatsApp
                </h1>
                <p className="text-xs text-muted-foreground mt-0.5">محادثات الموردين</p>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => setNewChatOpen(v => !v)}
                  className="text-muted-foreground hover:text-foreground p-1.5 rounded hover:bg-muted transition-colors" title="محادثة جديدة">
                  <Plus size={15} />
                </button>
                <button onClick={handleRefresh}
                  className="text-muted-foreground hover:text-foreground p-1.5 rounded hover:bg-muted transition-colors" title="تحديث">
                  <RefreshCw size={15} className={cn(refreshing && "animate-spin")} />
                </button>
              </div>
            </div>

            {/* New chat input panel */}
            {newChatOpen && (
              <div className="px-3 py-2.5 border-b border-border bg-muted/20">
                <form onSubmit={handleStartNewChat} className="space-y-1.5">
                  <p className="text-xs text-muted-foreground font-medium">ابدأ محادثة جديدة</p>
                  <div className="flex gap-1.5">
                    <input
                      type="tel"
                      value={newChatInput}
                      onChange={e => { setNewChatInput(e.target.value); setNewChatError(""); }}
                      placeholder="رقم الهاتف (مثال: 01012345678)"
                      className="flex-1 text-xs rounded border border-border bg-background px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-green-500/40"
                      style={{ direction: "ltr" }}
                      autoFocus
                    />
                    <button type="submit" className="px-2.5 py-1.5 text-xs rounded bg-green-500 hover:bg-green-600 text-white font-medium">بدء</button>
                  </div>
                  {newChatError && <p className="text-xs text-red-500">{newChatError}</p>}
                </form>
              </div>
            )}

            {/* Chat list */}
            <div className="flex-1 overflow-y-auto">
              {chats.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <p className="text-muted-foreground text-sm">لا توجد محادثات</p>
                </div>
              ) : (
                chats.map(chat => (
                  <button key={chat.phone} onClick={() => handleSelectChat(chat.phone)}
                    className={cn(
                      "w-full flex items-center gap-3 px-4 py-3 border-b border-border/60 text-right hover:bg-muted/50 transition-colors",
                      selectedPhone === chat.phone && "bg-muted"
                    )}>
                    <Avatar name={chat.supplierName ?? chat.phone} phone={chat.phone} size={40} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium truncate">{chat.supplierName ?? chat.phone}</p>
                        <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatTime(chat.lastAt)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-0.5">
                        <p className="text-xs text-muted-foreground truncate">{chat.lastMessage}</p>
                        {Number(chat.unread) > 0 && (
                          <span className="bg-green-500 text-white text-[10px] rounded-full min-w-[18px] h-[18px] flex items-center justify-center font-bold px-1 flex-shrink-0">
                            {Number(chat.unread) > 99 ? "99+" : chat.unread}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Main panel */}
          <div className="flex-1 flex flex-col min-w-0">
            {!selectedPhone ? (
              <div className="flex-1 flex items-center justify-center bg-muted/20">
                <div className="text-center space-y-2">
                  <MessageSquare size={48} className="text-muted-foreground/30 mx-auto" />
                  <p className="text-muted-foreground text-sm">اختر محادثة للبدء</p>
                </div>
              </div>
            ) : (
              <>
                {/* Chat header */}
                <div className="px-5 py-3 border-b border-border bg-card flex items-center gap-3">
                  <Avatar name={avatarSeed} phone={selectedPhone} size={40} />
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-foreground">{selectedChat?.supplierName ?? selectedPhone}</p>
                    {lastSeen.text ? (
                      <p className={cn("text-xs flex items-center gap-1", lastSeen.isOnline ? "text-green-600 font-medium" : "text-muted-foreground")}>
                        {lastSeen.isOnline && <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block animate-pulse" />}
                        {lastSeen.text}
                        {!lastSeen.isOnline && (
                          <span title="آخر ظهور مبني على آخر رسالة استلمناها" className="opacity-40 cursor-help"><Info size={10} /></span>
                        )}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground flex items-center gap-1"><Phone size={10} /> {selectedPhone}</p>
                    )}
                  </div>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-2"
                  style={{ background: "linear-gradient(135deg, #f0fdf4 0%, #fafafa 100%)" }}>
                  {loading ? (
                    <div className="flex items-center justify-center h-full"><div className="text-muted-foreground text-sm">جاري التحميل...</div></div>
                  ) : messages.length === 0 ? (
                    <div className="flex items-center justify-center h-full"><div className="text-muted-foreground text-sm">لا توجد رسائل</div></div>
                  ) : (
                    messages.map(msg => (
                      <div key={msg.id}
                        className={cn("flex items-end gap-1.5", msg.direction === "outbound" ? "justify-end" : "justify-start")}
                        onMouseEnter={() => setHoveredId(msg.id)}
                        onMouseLeave={() => setHoveredId(null)}>
                        {msg.direction === "inbound" && (
                          <Avatar name={selectedChat?.supplierName ?? selectedPhone ?? "?"} phone={selectedPhone ?? undefined} size={26} />
                        )}
                        {msg.direction === "outbound" && hoveredId === msg.id && editingId !== msg.id && (() => {
                          const ageMs = Date.now() - new Date(msg.createdAt).getTime();
                          const canDelete = ageMs <= 86400000;
                          if (!canDelete && msg.mediaId) return null;
                          return (
                            <div className="flex items-center gap-0.5 mb-1">
                              {!msg.mediaId && (
                                <button onClick={() => { setEditingId(msg.id); setEditText(msg.body); }}
                                  title="تعديل في سجلاتنا فقط"
                                  className="p-1.5 rounded text-muted-foreground hover:text-blue-600 hover:bg-blue-50 transition-colors">
                                  <Pencil size={13} />
                                </button>
                              )}
                              {canDelete ? (
                                <button onClick={() => handleDelete(msg.id)}
                                  title="حذف الرسالة"
                                  className="p-1.5 rounded text-muted-foreground hover:text-red-500 hover:bg-red-50 transition-colors">
                                  <Trash2 size={13} />
                                </button>
                              ) : (
                                !msg.mediaId && (
                                  <span title="انتهت مهلة الحذف" className="p-1.5 rounded text-muted-foreground/30 cursor-not-allowed">
                                    <Trash2 size={13} />
                                  </span>
                                )
                              )}
                            </div>
                          );
                        })()}
                        <div className={cn(
                          "max-w-[72%] px-3.5 py-2 rounded-2xl text-sm shadow-sm",
                          msg.direction === "outbound"
                            ? "bg-[#dcf8c6] text-gray-800 rounded-tr-sm"
                            : "bg-white text-gray-800 rounded-tl-sm border border-gray-100"
                        )}>
                          {editingId === msg.id ? (
                            <div className="space-y-1.5">
                              <p className="text-[10px] text-orange-500 mb-1 flex items-center gap-1"><Info size={9} /> التعديل في سجلاتنا فقط</p>
                              <textarea value={editText} onChange={e => setEditText(e.target.value)}
                                className="w-full text-sm bg-white/70 border border-green-300 rounded px-2 py-1 focus:outline-none resize-none min-w-[180px]"
                                rows={3} autoFocus style={{ direction: "rtl" }} />
                              <div className="flex gap-1.5 justify-end">
                                <button onClick={() => setEditingId(null)}
                                  className="px-2 py-0.5 text-xs rounded border border-gray-200 text-muted-foreground hover:text-foreground">إلغاء</button>
                                <button onClick={() => handleEditSave(msg.id)}
                                  className="px-2 py-0.5 text-xs rounded bg-green-600 text-white hover:bg-green-700 flex items-center gap-1">
                                  <Check size={11} /> حفظ
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              {msg.mediaId && <MediaContent msg={msg} />}
                              {(!msg.mediaId || msg.mediaType === "text") && (
                                <p className="whitespace-pre-wrap leading-relaxed">{msg.body}</p>
                              )}
                              {msg.mediaId && msg.mediaType !== "document" && (
                                <p className="whitespace-pre-wrap leading-relaxed text-xs opacity-70 mt-0.5">{msg.filename || ""}</p>
                              )}
                              <p className={cn("text-[10px] mt-1", msg.direction === "outbound" ? "text-green-700 text-right" : "text-gray-400")}>
                                {formatTime(msg.createdAt)}{msg.direction === "outbound" && " ✓✓"}
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Pending file preview */}
                {pendingFile && (
                  <div className="px-4 py-2 border-t border-border bg-muted/30 flex items-center gap-3">
                    {pendingFile.preview
                      ? <img src={pendingFile.preview} alt="preview" className="w-14 h-14 object-cover rounded-lg border border-border" />
                      : <div className="w-14 h-14 rounded-lg border border-border bg-muted flex items-center justify-center">{getFileIcon(pendingFile.file.type)}</div>
                    }
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{pendingFile.file.name}</p>
                      <p className="text-xs text-muted-foreground">{(pendingFile.file.size / 1024).toFixed(0)} KB</p>
                    </div>
                    <button onClick={() => setPendingFile(null)}
                      className="p-1.5 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                      <X size={16} />
                    </button>
                  </div>
                )}

                {/* Input */}
                <form onSubmit={handleSend} className="px-4 py-3 border-t border-border bg-card flex items-end gap-2">
                  <input ref={fileInputRef} type="file"
                    accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
                    className="hidden" onChange={handleFileSelect} />
                  <button type="button" onClick={() => fileInputRef.current?.click()} disabled={sending}
                    className="w-9 h-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors flex-shrink-0 mb-[1px] disabled:opacity-40"
                    title="إرفاق ملف">
                    <Paperclip size={18} />
                  </button>
                  {pendingFile ? (
                    <div className="flex-1 rounded-xl border border-green-300 bg-green-50 px-3.5 py-2.5 text-sm text-green-700 flex items-center gap-2 min-h-[42px]">
                      {getFileIcon(pendingFile.file.type)}
                      <span className="truncate">{pendingFile.file.name}</span>
                      {uploadProgress && <span className="text-xs opacity-70">جاري الإرسال...</span>}
                    </div>
                  ) : (
                    <textarea value={newMsg} onChange={e => setNewMsg(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(e as unknown as React.FormEvent); } }}
                      placeholder="اكتب رسالة..."
                      rows={1}
                      className="flex-1 resize-none rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500/30 min-h-[42px] max-h-32"
                      style={{ direction: "rtl" }}
                      disabled={sending} />
                  )}
                  <button type="submit"
                    disabled={(!newMsg.trim() && !pendingFile) || sending}
                    className="w-10 h-10 rounded-full bg-green-500 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors flex-shrink-0">
                    {uploadProgress
                      ? <RefreshCw size={16} className="text-white animate-spin" />
                      : <Send size={16} className="text-white" />}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>

        {/* Toast */}
        {toast && (
          <div className={cn(
            "fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium flex items-center gap-2 transition-all cursor-pointer",
            toast.ok ? "bg-green-600 text-white" : "bg-amber-500 text-white"
          )}>
            {toast.ok ? "✓" : "⚠"} {toast.msg}
          </div>
        )}
      </Layout>
    );
  }
  