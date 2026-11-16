import { useEffect, useState } from "react";

/**
 * useDebounced — a value that settles only after the user stops changing it.
 *
 * Every list page fed its search box straight into the query key, so each
 * keystroke issued a full list request. On the customer-RFQ page that was a
 * multi-second round trip per character typed, which reads as "the search is
 * stuck". Debouncing collapses a burst of typing into ONE request.
 *
 * @param value the raw value (e.g. the input's state)
 * @param delay ms of quiet before the value is published (default 300)
 */
export function useDebounced<T>(value: T, delay = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return settled;
}
