import { useEffect, useRef, useCallback } from "react";

/**
 * useDataEntrySession — tracks the real time an operator spends filling a
 * "new" form, from the moment the form mounts (startedAt) to the moment they
 * save it successfully (endedAt) or navigate away (abandoned).
 *
 * Flow:
 *   1. On mount → POST /api/data-entry-sessions { type } → sessionId.
 *   2. On successful save → call endSession(entityId?) → PATCH .../end.
 *   3. On unmount without saving → PATCH .../abandon (best-effort, sendBeacon).
 *
 * The backend uses these rows to compute per-employee data-entry KPIs:
 * number of RFQs/POs, line items, total/avg entry time, weekly/monthly rollups.
 *
 * @param type one of "supplier_rfq" | "customer_rfq" | "supplier_po" | "customer_po"
 */
export function useDataEntrySession(type: "supplier_rfq" | "customer_rfq" | "supplier_po" | "customer_po") {
  const sessionIdRef = useRef<number | null>(null);
  const endedRef = useRef(false);
  const typeRef = useRef(type);
  typeRef.current = type;

  // Start the session on mount (only once).
  useEffect(() => {
    endedRef.current = false;
    sessionIdRef.current = null;

    let cancelled = false;
    fetch("/api/data-entry-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ type: typeRef.current }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.id) sessionIdRef.current = data.id;
      })
      .catch(() => {
        /* best-effort; analytics is non-critical */
      });

    // On unmount: if never ended, mark abandoned via fetch keepalive (survives navigation).
    return () => {
      cancelled = true;
      const id = sessionIdRef.current;
      if (id != null && !endedRef.current) {
        try {
          void fetch(`/api/data-entry-sessions/${id}/abandon`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            keepalive: true,
            body: "{}",
          });
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  /** Call this in the mutation onSuccess to record a successful save. */
  const endSession = useCallback((entityId?: number) => {
    const id = sessionIdRef.current;
    if (id == null || endedRef.current) return;
    endedRef.current = true;
    fetch(`/api/data-entry-sessions/${id}/end`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(entityId != null ? { entityId } : {}),
    }).catch(() => {
      /* best-effort */
    });
  }, []);

  return { endSession };
}
