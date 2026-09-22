type Scrollable = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;

/**
 * Jump a scroll container to the bottom and report whether it actually landed
 * there.
 *
 * The return value matters more than the scroll: the auto-scroll effect must
 * only latch its "already scrolled" guard when this returns `true`. Latching on
 * a failed attempt is what left conversations pinned to the top — the container
 * was not laid out yet, the scroll silently no-opped, and every later render
 * skipped the retry because the guard was already set.
 *
 * A container shorter than its viewport is trivially "at the bottom"; otherwise
 * we allow an 8px tolerance for sub-pixel rounding.
 */
export function scrollToBottom(scroller: Scrollable | null): boolean {
  if (!scroller) return false;
  scroller.scrollTop = scroller.scrollHeight;
  if (scroller.scrollHeight <= scroller.clientHeight) return true;
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
}
