import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebounced } from "@/hooks/use-debounced";

/**
 * The list pages fed the raw search box state straight into the query key, so
 * every keystroke issued a full list request — on the customer-RFQ page that is
 * a multi-second round trip per character. These tests drive the real hook with
 * fake timers and assert the request-driving value settles only once.
 */
describe("useDebounced", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("publishes only the final value after the quiet window", () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 300), {
      initialProps: { v: "a" },
    });

    rerender({ v: "ab" });
    rerender({ v: "abc" });
    rerender({ v: "abcd" });
    // Still the initial value — a burst of typing issues no request.
    expect(result.current).toBe("a");

    act(() => vi.advanceTimersByTime(300));
    // ONE value, the last one typed.
    expect(result.current).toBe("abcd");
  });

  it("keeps the previous value until the window elapses", () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 300), {
      initialProps: { v: "x" },
    });
    rerender({ v: "xy" });
    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe("x");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("xy");
  });

  it("restarts the window on every change (no premature publish)", () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 300), {
      initialProps: { v: "1" },
    });
    rerender({ v: "12" });
    act(() => vi.advanceTimersByTime(250));
    rerender({ v: "123" });
    act(() => vi.advanceTimersByTime(250));
    // 500ms of real time passed but never 300ms of QUIET → still the old value.
    expect(result.current).toBe("1");
    act(() => vi.advanceTimersByTime(50));
    expect(result.current).toBe("123");
  });
});
