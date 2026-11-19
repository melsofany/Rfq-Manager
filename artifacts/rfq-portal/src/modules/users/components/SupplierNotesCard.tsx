import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListSupplierNotesQueryKey,
  getListSupplierPoLinesQueryKey,
  getGetSupplierPurchasesQueryKey,
  useCreateSupplierNote,
  useGetSupplierPurchases,
  useListSupplierNotes,
  useListSupplierPoLines,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const REASONS: { value: string; label: string }[] = [
  { value: "wrong_price", label: "Wrong price" },
  { value: "unrequested_item", label: "Item not requested" },
  { value: "wrong_qty", label: "Wrong quantity" },
  { value: "late_delivery", label: "Late delivery" },
  { value: "quality", label: "Quality" },
  { value: "other", label: "Other" },
];

const reasonLabel = (value: string) => REASONS.find((r) => r.value === value)?.label ?? value;

const fmt = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "—"
    : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Totals of this supplier's purchased lines, before and after VAT.
export function SupplierPurchasesCard({ supplierId }: { supplierId: number }) {
  const { data } = useGetSupplierPurchases(supplierId, {
    query: { queryKey: getGetSupplierPurchasesQueryKey(supplierId), enabled: !!supplierId },
  });

  const tiles = [
    { label: "Purchase orders", value: data ? String(data.poCount) : "—" },
    { label: "Items bought", value: data ? String(data.lineCount) : "—" },
    { label: "Total before VAT", value: data ? fmt(data.totalNet) : "—" },
    { label: "Total incl. VAT", value: data ? fmt(data.totalGross) : "—" },
  ];

  return (
    <div className="bg-card border border-border rounded-lg p-5 space-y-3">
      <h2 className="font-semibold text-sm text-foreground">Purchases from this supplier</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground">{tile.label}</p>
            <p className="text-lg font-semibold text-foreground tabular-nums">{tile.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function AddNoteDialog({
  supplierId,
  open,
  onOpenChange,
}: {
  supplierId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [poItemId, setPoItemId] = useState("");
  const [reason, setReason] = useState("wrong_price");
  const [text, setText] = useState("");

  const { data: lines = [], isLoading: linesLoading } = useListSupplierPoLines(supplierId, {
    query: { queryKey: getListSupplierPoLinesQueryKey(supplierId), enabled: open },
  });

  const create = useCreateSupplierNote({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSupplierNotesQueryKey(supplierId) });
        setPoItemId("");
        setReason("wrong_price");
        setText("");
        onOpenChange(false);
      },
    },
  });

  const submit = () => {
    create.mutate({
      id: supplierId,
      data: {
        reason: reason as never,
        poItemId: poItemId ? Number(poItemId) : null,
        text: text.trim() || null,
      },
    });
  };

  const selectClass =
    "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a note on this supplier</DialogTitle>
          <DialogDescription>
            Choose the PO line the note is about, then the problem. Notes are for review and do not
            change the score.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="note-line">
              PO line (optional)
            </label>
            <select
              id="note-line"
              className={selectClass}
              value={poItemId}
              onChange={(e) => setPoItemId(e.target.value)}
              disabled={linesLoading}
            >
              <option value="">No specific line</option>
              {lines.map((line) => (
                <option key={line.id} value={String(line.id)}>
                  {`${line.internalPoNo ?? `PO ${line.poId}`} — ${line.description} — ${
                    line.qty ?? "—"
                  } × ${fmt(line.price)} (${line.taxIncluded ? "incl. VAT" : "excl. VAT"})`}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="note-reason">
              Problem
            </label>
            <select
              id="note-reason"
              className={selectClass}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="note-text">
              Details (optional)
            </label>
            <Textarea
              id="note-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={2000}
              rows={3}
            />
          </div>

          {create.isError && (
            <p className="text-xs text-destructive">Could not save the note. Try again.</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            Save note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Notes recorded against this supplier, optionally tied to a PO line.
export function SupplierNotesCard({ supplierId }: { supplierId: number }) {
  const [open, setOpen] = useState(false);
  const { data: notes = [], isLoading } = useListSupplierNotes(supplierId, {
    query: { queryKey: getListSupplierNotesQueryKey(supplierId), enabled: !!supplierId },
  });

  return (
    <div className="bg-card border border-border rounded-lg p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-sm text-foreground">Notes ({notes.length})</h2>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Add note
        </Button>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="text-xs text-muted-foreground">No notes yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {notes.map((note) => (
            <li key={note.id} className="py-3 space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium rounded border border-border px-2 py-0.5 text-foreground">
                  {reasonLabel(note.reason)}
                </span>
                {note.internalPoNo || note.poId ? (
                  <span className="text-muted-foreground">
                    {note.internalPoNo ?? `PO ${note.poId}`}
                    {note.description ? ` — ${note.description}` : ""}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Whole supplier</span>
                )}
                <span className="text-muted-foreground ms-auto">
                  {new Date(note.createdAt).toLocaleDateString("en-GB")}
                </span>
              </div>
              {note.text && (
                <p className="text-sm text-foreground whitespace-pre-wrap">{note.text}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {open && <AddNoteDialog supplierId={supplierId} open={open} onOpenChange={setOpen} />}
    </div>
  );
}
