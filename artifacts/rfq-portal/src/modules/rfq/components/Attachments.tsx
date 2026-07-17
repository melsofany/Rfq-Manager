import { useRef, useState } from "react";
import { Paperclip, Upload, Trash2, Download, FileText, Image, File } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export interface AttachmentItem {
  id: number;
  originalName: string;
  mimeType: string;
  size: number;
  sizeLabel: string;
  createdAt: string;
  downloadUrl: string;
}

function FileIcon({ mimeType, name }: { mimeType: string; name: string }) {
  if (mimeType.startsWith("image/"))
    return <Image size={16} className="text-blue-500 flex-shrink-0" />;
  if (mimeType === "application/pdf" || name.endsWith(".pdf"))
    return <FileText size={16} className="text-red-500 flex-shrink-0" />;
  return <File size={16} className="text-muted-foreground flex-shrink-0" />;
}

interface Props {
  uploadUrl: string; // POST endpoint
  listUrl: string; // GET endpoint to fetch list
  deleteUrlBase: string; // DELETE /api/rfq/attachments/:id or /api/offer/attachments/:id
  readOnly?: boolean;
  label?: string;
}

export function AttachmentsPanel({
  uploadUrl,
  listUrl,
  deleteUrlBase,
  readOnly = false,
  label = "المرفقات",
}: Props) {
  const [attachments, setAttachments] = useState<AttachmentItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Lazy load on first render
  if (attachments === null && !loading) {
    setLoading(true);
    fetch(listUrl, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: AttachmentItem[]) => {
        setAttachments(data);
        setLoading(false);
      })
      .catch(() => {
        setAttachments([]);
        setLoading(false);
      });
  }

  async function uploadFile(file: File) {
    if (file.size > 20 * 1024 * 1024) {
      toast.error("حجم الملف يتجاوز 20 MB");
      return;
    }
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch(uploadUrl, { method: "POST", credentials: "include", body: fd });
      if (!r.ok) {
        const err = (await r.json().catch(() => ({}))) as { error?: string };
        toast.error(err.error ?? "فشل رفع الملف");
        return;
      }
      const att = (await r.json()) as AttachmentItem;
      setAttachments((prev) => [...(prev ?? []), att]);
      toast.success(`تم رفع "${att.originalName}" بنجاح`);
    } catch {
      toast.error("خطأ في الاتصال بالخادم");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function deleteAttachment(id: number, name: string) {
    setDeleting(id);
    try {
      const r = await fetch(`${deleteUrlBase}/${id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok && r.status !== 204) {
        toast.error("فشل حذف الملف");
        return;
      }
      setAttachments((prev) => (prev ?? []).filter((a) => a.id !== id));
      toast.success(`تم حذف "${name}"`);
    } catch {
      toast.error("خطأ في الاتصال بالخادم");
    } finally {
      setDeleting(null);
    }
  }

  function download(att: AttachmentItem) {
    const a = document.createElement("a");
    a.href = att.downloadUrl;
    a.download = att.originalName;
    a.click();
  }

  const list = attachments ?? [];

  return (
    <div className="space-y-4">
      {/* Upload zone */}
      {!readOnly && (
        <div
          className={cn(
            "border-2 border-dashed rounded-lg px-6 py-8 text-center transition-colors cursor-pointer",
            dragOver
              ? "border-primary bg-primary/5"
              : "border-border hover:border-primary/50 hover:bg-muted/30",
            uploading && "opacity-60 pointer-events-none",
          )}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) uploadFile(file);
          }}
        >
          <Upload size={24} className="mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-foreground font-medium">
            {uploading ? "جاري الرفع..." : "اسحب وأفلت أو انقر للاختيار"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            PDF · صور · Excel · Word · DWG — حد أقصى 20 MB
          </p>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,.xlsx,.xls,.docx,.doc,.dwg,.dxf,.step,.stp,.iges,.igs,.svg"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadFile(f);
            }}
          />
        </div>
      )}

      {/* File list */}
      {loading ? (
        <div className="text-sm text-muted-foreground text-center py-4">جاري التحميل...</div>
      ) : list.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <Paperclip size={32} className="mx-auto mb-2 opacity-30" />
          <p className="text-sm">لا توجد مرفقات</p>
        </div>
      ) : (
        <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
          {list.map((att) => (
            <div
              key={att.id}
              className="flex items-center gap-3 px-4 py-3 bg-card hover:bg-muted/20 transition-colors"
            >
              <FileIcon mimeType={att.mimeType} name={att.originalName} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{att.originalName}</p>
                <p className="text-xs text-muted-foreground">
                  {att.sizeLabel} · {new Date(att.createdAt).toLocaleDateString("ar-EG")}
                </p>
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => download(att)}
                  title="تحميل"
                >
                  <Download size={14} />
                </Button>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => deleteAttachment(att.id, att.originalName)}
                    disabled={deleting === att.id}
                    title="حذف"
                  >
                    <Trash2 size={14} />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
