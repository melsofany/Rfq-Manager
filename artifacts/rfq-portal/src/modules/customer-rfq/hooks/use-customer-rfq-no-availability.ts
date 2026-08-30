import { useEffect, useState } from "react";

interface AvailabilityState {
  checked: boolean;
  available: boolean;
}

// Live (debounced) uniqueness probe for the customer-RFQ number using the
// `GET /customer-rfq/check-number` endpoint. Returns only after the value has
// settled for `delayMs` so typing doesn't spam the server.
export function useCustomerRfqNoAvailability(value: string, excludeId?: number, delayMs = 450): AvailabilityState {
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
        const res = await fetch(`/api/customer-rfq/check-number?${params.toString()}`, { credentials: "include" });
        if (!res.ok) return;
        const body = (await res.json()) as { available: boolean };
        if (!cancelled) setState({ checked: true, available: body.available !== false });
      } catch {
        // Network hiccups degrade the probe silently; the server still enforces
        // uniqueness on submit.

      }
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, excludeId, delayMs]);

  return state;
}