import { useState, useEffect, useRef } from "react";
import { Layout } from "@/components/Layout";
import { MessageSquare, Send, Phone, User, RefreshCw } from "lucide-react";
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

export default function WhatsAppPage() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMsg, setNewMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
        // refresh chats to clear unread badge
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
    if (!newMsg.trim() || !selectedPhone || sending) return;
    setSending(true);
    const body = newMsg.trim();
    setNewMsg("");
    try {
      const r = await fetch("/api/whatsapp/send", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: selectedPhone,
          message: body,
          supplierId: selectedChat?.supplierId,
        }),
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

  return (
    <Layout>
      <div className="flex h-full" style={{ height: "calc(100vh - 0px)" }}>
        {/* Sidebar — chat list */}
        <div className="w-80 flex-shrink-0 border-r border-border flex flex-col bg-card">
          {/* Header */}
          <div className="p-4 border-b border-border flex items-center justify-between">
            <div>
              <h1 className="text-base font-bold text-foreground flex items-center gap-2">
                <MessageSquare size={18} className="text-green-600" />
                WhatsApp
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">محادثات الموردين</p>
            </div>
            <button
              onClick={handleRefresh}
              className="text-muted-foreground hover:text-foreground p-1.5 rounded hover:bg-muted transition-colors"
              title="تحديث"
            >
              <RefreshCw size={15} className={cn(refreshing && "animate-spin")} />
            </button>
          </div>

          {/* Chat list */}
          <div className="flex-1 overflow-y-auto">
            {chats.length === 0 ? (
              <div className="p-8 text-center">
                <MessageSquare size={36} className="mx-auto text-muted-foreground/20 mb-3" />
                <p className="text-muted-foreground text-sm">لا توجد محادثات بعد</p>
                <p className="text-muted-foreground/60 text-xs mt-1">ستظهر هنا رسائل الموردين</p>
              </div>
            ) : (
              chats.map(chat => (
                <button
                  key={chat.phone}
                  onClick={() => handleSelectChat(chat.phone)}
                  className={cn(
                    "w-full text-left px-4 py-3 border-b border-border/50 hover:bg-muted/50 transition-colors flex items-start gap-3",
                    selectedPhone === chat.phone && "bg-muted"
                  )}
                >
                  <div className="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <User size={16} className="text-green-700" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-sm font-medium text-foreground truncate">
                        {chat.supplierName ?? chat.phone}
                      </span>
                      <span className="text-xs text-muted-foreground flex-shrink-0">
                        {formatTime(chat.lastAt)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-1 mt-0.5">
                      <span className="text-xs text-muted-foreground truncate max-w-[170px]">
                        {chat.lastMessage}
                      </span>
                      {Number(chat.unread) > 0 && (
                        <span className="flex-shrink-0 bg-green-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold">
                          {chat.unread}
                        </span>
                      )}
                    </div>
                    {chat.phone && (
                      <p className="text-xs text-muted-foreground/50 mt-0.5 flex items-center gap-1">
                        <Phone size={10} />
                        {chat.phone}
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
                    <Phone size={10} />
                    {selectedPhone}
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
                    <div
                      key={msg.id}
                      className={cn(
                        "flex",
                        msg.direction === "outbound" ? "justify-end" : "justify-start"
                      )}
                    >
                      <div
                        className={cn(
                          "max-w-[70%] px-3.5 py-2 rounded-2xl text-sm shadow-sm",
                          msg.direction === "outbound"
                            ? "bg-[#dcf8c6] text-gray-800 rounded-tr-sm"
                            : "bg-white text-gray-800 rounded-tl-sm border border-gray-100"
                        )}
                      >
                        <p className="whitespace-pre-wrap leading-relaxed">{msg.body}</p>
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

              {/* Message input */}
              <form
                onSubmit={handleSend}
                className="px-4 py-3 border-t border-border bg-card flex items-end gap-2"
              >
                <textarea
                  value={newMsg}
                  onChange={e => setNewMsg(e.target.value)}
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
                  disabled={sending}
                />
                <button
                  type="submit"
                  disabled={!newMsg.trim() || sending}
                  className="w-10 h-10 rounded-full bg-green-500 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors flex-shrink-0"
                >
                  <Send size={16} className="text-white" />
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </Layout>
  );
}
