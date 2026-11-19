import { AlertCircle } from "lucide-react";

export interface RfqBlocker {
  /** The stored key, so the client branches on it instead of parsing Arabic. */
  code: string;
  /** What is in the way. */
  reason: string;
  /** What to do about it, in the operator's words. */
  action: string;
  /** Where to do it, when it has a screen. */
  where?: string;
}

/**
 * A refused action, shown WITH the remedy the server sent for each blocker.
 *
 * The delete refusal used to say «ألغِ بنوده بدلًا من الحذف» for every blocker,
 * but cancelling items clears only the frozen achievement — a customer PO, a
 * supplier RFQ or an invoice is held by a RESTRICT constraint and refuses the
 * delete however many items are cancelled. The operator followed the message and
 * was refused again. Showing the reason alone is what made that possible.
 */
export function ActionErrorBlock({
  error,
  blockers = [],
  testId = "action-error",
}: {
  error: string;
  blockers?: RfqBlocker[];
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2 space-y-1.5"
    >
      <div className="flex items-center gap-2">
        <AlertCircle size={14} />
        <span>{error}</span>
      </div>
      {blockers.length > 0 && (
        <ul className="list-disc pr-5 space-y-1" data-testid={`${testId}-blockers`}>
          {blockers.map((b) => (
            <li key={b.code}>
              <span className="font-medium">{b.reason}:</span> {b.action}
              {b.where ? <span className="opacity-80"> — {b.where}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
