import { describe, it, expect } from "vitest";
import { scrollToBottom } from "@/lib/scroll-to-bottom";

/** Stand-in for a DOM scroll container; scrollTop clamps like a real element. */
function scroller(scrollHeight: number, clientHeight: number) {
  const limit = Math.max(0, scrollHeight - clientHeight);
  let top = 0;
  return {
    scrollHeight,
    clientHeight,
    get scrollTop() {
      return top;
    },
    set scrollTop(v: number) {
      top = Math.min(Math.max(v, 0), limit);
    },
  };
}

describe("scrollToBottom", () => {
  it("returns false for a missing container instead of throwing", () => {
    expect(scrollToBottom(null)).toBe(false);
  });

  it("scrolls to the bottom and reports success", () => {
    const el = scroller(2000, 500);
    expect(scrollToBottom(el)).toBe(true);
    expect(el.scrollTop).toBe(1500);
  });

  it("reports true when the content does not overflow yet", () => {
    // Not laid out (content shorter than the viewport) — at the bottom by
    // definition, so latching the guard here is safe.
    expect(scrollToBottom(scroller(0, 500))).toBe(true);
  });

  it("reports false when the container cannot scroll yet", () => {
    // An unlaid-out container: writing scrollTop does not move it. Reporting
    // false is what makes the effect retry on the next frame.
    const frozen = {
      scrollHeight: 2000,
      clientHeight: 500,
      get scrollTop() {
        return 0;
      },
      set scrollTop(_v: number) {
        /* not scrollable yet */
      },
    };
    expect(scrollToBottom(frozen)).toBe(false);
  });

  it("tolerates up to 8px of sub-pixel rounding at the bottom", () => {
    const el = scroller(2000, 500);
    el.scrollTop = 1493; // 7px short of 1500
    expect(el.scrollTop).toBe(1493);
    expect(scrollToBottom(el)).toBe(true);
  });
});
