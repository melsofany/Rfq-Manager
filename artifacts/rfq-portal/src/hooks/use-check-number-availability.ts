import { useEffect, useState } from "react";

interface AvailabilityState {
  checked: boolean;
  available: boolean;
}

// Debounced uniqueness probe for a field backed by a `GET /…/check-number`
// endpoint that returns `{ available }`． `excludeId` is appended so PATCH saves
// don't flag the row they're editing． Returns only after the value has settled
// for `delayMs` so typing doesn't spam the server．
export function useCheckNumberAvailability(value: string, endpoint: string, excludeId?: number, delayMs = 450): AvailabilityState {
  const [state, setState] = useState<AvailabilityState>({ checked: false, available: true });

  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      setState({ checked: false, available: true });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ value: trimmed });
        if (excludeId !== undefined) params.set("excludeId", String(excludeId));
        const res = await fetch(`${endpoint}?${params.toString()}`, { credentials: "include" });
        if (!res.ok) return;
        const body = (await res.json()) as { available: boolean };
        if (!cancelled) setState({ checked: true, available: body.available !== false });
      } catch {
        // Network hiccups degrade the probe silently; the server still enforces
        // uniqueness on submit．

      }
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, endpoint, excludeId, delayMs]);

  return state;
}