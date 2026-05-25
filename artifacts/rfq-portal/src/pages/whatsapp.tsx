import { useState, useEffect, useRef } from "react";
  import { Layout } from "@/components/Layout";
  import { MessageSquare, Send, Phone, User, RefreshCw, Paperclip, FileText, Download, X, Image as ImageIcon, Mic } from "lucide-react";
  import { cn } from "@/lib/utils";

  interface Chat {
    phone: string;
    supplierId: number | null;
    supplierName: string | null;
    lastMessage: string;
    lastAt: string;
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

  function formatTime(dateStr: string) {
    const d = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
    if (diffDays === 0) return d.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
    if (diffDays === 1) return "أمس";
    if (diffDays < 7) return d.toLocaleDateString("ar-EG", { weekday: "short" });
    return d.toLocaleDateString("ar-EG", { day: "2-digit", month: "2-digit" });
  }

  function MediaContent({ msg }: { msg: Message }) {
    const [imgError, setImgError] = useState(false);
    const [lightbox, setLightbox] = useState(false);

    if (!msg.mediaId) return null;
    const mediaUrl = `/api/whatsapp/media/${msg.mediaId}`;

    if (msg.mediaType === "image") {
      if (imgError) return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
          <ImageIcon size={14} /> تعذر تحميل الصورة
        </div>
      );
      return (
        <>
          <img
            src={mediaUrl}
            alt="صورة"
            className="max-w-full rounded-lg cursor-pointer max-h-64 object-cover mt-1 mb-0.5 border border-black/5"
            onError={() => setImgError(true)}
            onClick={() => setLightbox(true)}
          />
          {lightbox && (
            <div
              className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"
              onClick={() => setLightbox(false)}
            >
              <button className="absolute top-4 right-4 text-white p-2 rounded-full bg-black/40 hover:bg-black/60">
                <X size={20} />
              </button>
              <img src={mediaUrl} alt="صورة" className="max-w-[90vw] max-h-[90vh] rounded-lg object-contain" />
            </div>
          )}
        </>
      );
    }

    if (msg.mediaType === "audio") {
      return (
        <div className="mt-1 mb-0.5">
          <audio controls className="max-w-full h-9" style={{ minWidth: 200 }}>
            <source src={mediaUrl} type={msg.mimeType || "audio/ogg"} />
            متصفحك لا يدعم تشغيل الصوت
          </audio>
        </div>
      );
    }

    if (msg.mediaType === "document" || msg.mediaType === "video") {
      const isVideo = msg.mediaType === "video";
      return (
        <div className="mt-1 mb-0.5">
          {isVideo ? (
            <video controls className="max-w-full max-h-56 rounded-lg">
              <source src={mediaUrl} type={msg.mimeType || "video/mp4"} />
            </video>
          ) : (
            <a
              href={mediaUrl}
              download={msg.filename || "document"}
              className="flex items-center gap-2.5 bg-black/5 hover:bg-black/10 rounded-lg px-3 py-2 transition-colors group"
              target="_blank"
              rel="noreferrer"
            >
              <FileText size={18} className="text-blue-500 flex-shrink-0" />
              <span className="text-xs text-foreground flex-1 truncate font-medium">
                {msg.filename || "مستند"}
              </span>
              <Download size={14} className="text-muted-foreground group-hover:text-foreground flex-shrink-0" />
            </a>
          )}
        </div>
      );
    }

    return null;
  }

  interface PendingFile { file: File; base64: string; preview?: string; }

  export default function WhatsAppPage() {
    const [chats, setChats] = useState<Chat[]>([]);
    const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [newMsg, setNewMsg] = useState("");
    const [sending, setSending] = useState(false);
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
    const [uploadProgress, setUploadProgress] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const selectedChat = chats.find(c => c.phone === selectedPhone);

    async function loadChats() {
      try {
        const r = await fetch("/api/whatsapp/chats", { credentials: "include" });
        if (r.ok) setChats(await r.json());
      } catch { /* ignore */ }
    }

    async function loadMessages(phone: string) {
      setLoading(true);
      try {
        const r = await fetch(`/api/whatsapp/chats/${encodeURIComponent(phone)}`, { credentials: "include" });
        if (r.ok) {
          setMessages(await r.json());
          await loadChats();
        }
      } finally {
        setLoading(false);
      }
    }

    useEffect(() => {
      loadChats();
      const interval = setInterval(async () => {
        await loadChats();
        if (selectedPhone) await loadMessages(selectedPhone);
      }, 10000);
      return () => clearInterval(interval);
    }, [selectedPhone]);

    useEffect(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    async function handleSelectChat(phone: string) {
      setSelectedPhone(phone);
      setMessages([]);
      setPendingFile(null);
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

      // If there's a pending file, send it
      if (pendingFile) {
        await handleSendMedia();
        return;
      }

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
        if (r.ok) {
          await loadMessages(selectedPhone);
        } else {
          const err = await r.json();
          alert("فشل الإرسال: " + (err.error || "خطأ غير معروف"));
          setNewMsg(body);
        }
      } catch {
        alert("خطأ في الاتصال");
        setNewMsg(body);
      } finally {
        setSending(false);
      }
    }

    async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
      const file = e.target.files?.[0];
      if (!file) return;

      // Read file as base64
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(",")[1];
        const preview = file.type.startsWith("image/") ? result : undefined;
        setPendingFile({ file, base64, preview });
      };
      reader.readAsDataURL(file);

      // Reset input so same file can be re-selected
      e.target.value = "";
    }

    async function handleSendMedia() {
      if (!pendingFile || !selectedPhone) return;
      setUploadProgress(true);
      setSending(true);
      try {
        const r = await fetch("/api/whatsapp/send-media", {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: selectedPhone,
            supplierId: selectedChat?.supplierId,
            base64: pendingFile.base64,
            mimeType: pendingFile.file.type,
            filename: pendingFile.file.name,
          }),
        });
        if (r.ok) {
          setPendingFile(null);
          await loadMessages(selectedPhone);
        } else {
          const err = await r.json();
          alert("فشل إرسال الملف: " + (err.error || "خطأ غير معروف"));
        }
      } catch {
        alert("خطأ في الاتصال");
      } finally {
        setUploadProgress(false);
        setSending(false);
      }
    }

    function getFileIcon(mime: string) {
      if (mime.startsWith("image/")) return <ImageIcon size={20} className="text-blue-500" />;
      if (mime.startsWith("audio/")) return <Mic size={20} className="text-purple-500" />;
      return <FileText size={20} className="text-blue-500" />;
    }

    return (
      <Layout>
        <div className="flex h-full" style={{ height: "calc(100vh - 0px)" }}>
          {/* Sidebar — chat list */}
          <div className="w-80 flex-shrink-0 border-r border-border flex flex-col bg-card">
            <div className="p-4 border-b border-border flex items-center justify-between">
              <div>
                <h1 className="text-base font-bold text-foreground flex items-center gap-2">
                  <MessageSquare size={18} className="text-green-600" />
                  WhatsApp
                </h1>
                <p className="text-xs text-muted-foreground mt-0.5">محادثات الموردين</p>
              </div>
              <button onClick={handleRefresh}
                className="text-muted-foreground hover:text-foreground p-1.5 rounded hover:bg-muted transition-colors"
                title="تحديث">
                <RefreshCw size={15} className={cn(refreshing && "animate-spin")} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {chats.length === 0 ? (
                <div className="p-8 text-center">
                  <MessageSquare size={36} className="mx-auto text-muted-foreground/20 mb-3" />
                  <p className="text-muted-foreground text-sm">لا توجد محادثات بعد</p>
                  <p className="text-muted-foreground/60 text-xs mt-1">ستظهر هنا رسائل الموردين</p>
                </div>
              ) : (
                chats.map(chat => (
                  <button key={chat.phone} onClick={() => handleSelectChat(chat.phone)}
                    className={cn(
                      "w-full text-left px-4 py-3 border-b border-border/50 hover:bg-muted/50 transition-colors flex items-start gap-3",
                      selectedPhone === chat.phone && "bg-muted"
                    )}>
                    <div className="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <User size={16} className="text-green-700" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-sm font-medium text-foreground truncate">
                          {chat.supplierName ?? chat.phone}
                        </span>
                        <span className="text-xs text-muted-foreground flex-shrink-0">{formatTime(chat.lastAt)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-1 mt-0.5">
                        <span className="text-xs text-muted-foreground truncate max-w-[170px]">{chat.lastMessage}</span>
                        {Number(chat.unread) > 0 && (
                          <span className="flex-shrink-0 bg-green-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold">
                            {chat.unread}
                          </span>
                        )}
                      </div>
                      {chat.phone && (
                        <p className="text-xs text-muted-foreground/50 mt-0.5 flex items-center gap-1">
                          <Phone size={10} /> {chat.phone}
                        </p>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Main chat area */}
          <div className="flex-1 flex flex-col bg-background">
            {!selectedPhone ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
                <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center mb-4">
                  <MessageSquare size={28} className="text-green-500" />
                </div>
                <h2 className="text-base font-semibold text-foreground">WhatsApp Business</h2>
                <p className="text-muted-foreground text-sm mt-1 max-w-xs">
                  اختر محادثة من القائمة لعرض الرسائل والرد على الموردين
                </p>
              </div>
            ) : (
              <>
                {/* Chat header */}
                <div className="px-5 py-3 border-b border-border bg-card flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center">
                    <User size={16} className="text-green-700" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      {selectedChat?.supplierName ?? selectedPhone}
                    </p>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Phone size={10} /> {selectedPhone}
                    </p>
                  </div>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-2"
                  style={{ background: "linear-gradient(135deg, #f0fdf4 0%, #fafafa 100%)" }}>
                  {loading ? (
                    <div className="flex items-center justify-center h-full">
                      <div className="text-muted-foreground text-sm">جاري التحميل...</div>
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                      <div className="text-muted-foreground text-sm">لا توجد رسائل</div>
                    </div>
                  ) : (
                    messages.map(msg => (
                      <div key={msg.id}
                        className={cn("flex", msg.direction === "outbound" ? "justify-end" : "justify-start")}>
                        <div className={cn(
                          "max-w-[75%] px-3.5 py-2 rounded-2xl text-sm shadow-sm",
                          msg.direction === "outbound"
                            ? "bg-[#dcf8c6] text-gray-800 rounded-tr-sm"
                            : "bg-white text-gray-800 rounded-tl-sm border border-gray-100"
                        )}>
                          {/* Media content */}
                          {msg.mediaId && <MediaContent msg={msg} />}
                          {/* Text body — hide redundant bracket labels when media shown */}
                          {(!msg.mediaId || msg.mediaType === "text") && (
                            <p className="whitespace-pre-wrap leading-relaxed">{msg.body}</p>
                          )}
                          {/* Caption or filename for media */}
                          {msg.mediaId && msg.mediaType !== "document" && (
                            <p className="whitespace-pre-wrap leading-relaxed text-xs opacity-70 mt-0.5">
                              {msg.filename || ""}
                            </p>
                          )}
                          <p className={cn(
                            "text-[10px] mt-1",
                            msg.direction === "outbound" ? "text-green-700 text-right" : "text-gray-400"
                          )}>
                            {formatTime(msg.createdAt)}
                            {msg.direction === "outbound" && " ✓✓"}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Pending file preview */}
                {pendingFile && (
                  <div className="px-4 py-2 border-t border-border bg-muted/30 flex items-center gap-3">
                    {pendingFile.preview ? (
                      <img src={pendingFile.preview} alt="preview"
                        className="w-14 h-14 object-cover rounded-lg border border-border" />
                    ) : (
                      <div className="w-14 h-14 rounded-lg border border-border bg-muted flex items-center justify-center">
                        {getFileIcon(pendingFile.file.type)}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{pendingFile.file.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {(pendingFile.file.size / 1024).toFixed(0)} KB
                      </p>
                    </div>
                    <button onClick={() => setPendingFile(null)}
                      className="p-1.5 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                      <X size={16} />
                    </button>
                  </div>
                )}

                {/* Input area */}
                <form onSubmit={handleSend}
                  className="px-4 py-3 border-t border-border bg-card flex items-end gap-2">
                  {/* Hidden file input */}
                  <input ref={fileInputRef} type="file"
                    accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
                    className="hidden" onChange={handleFileSelect} />

                  {/* Paperclip button */}
                  <button type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={sending}
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
                      onKeyDown={e => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleSend(e as unknown as React.FormEvent);
                        }
                      }}
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
      </Layout>
    );
  }
  