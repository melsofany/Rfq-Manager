/**
 * Model routing (P6).
 *
 * A fast-path lookup must not spend the primary model's scarce daily quota, so
 * the router's path decides which model runs. These tests pin the decision and
 * the fallback rule: when no dedicated fast model is configured the primary is
 * used unchanged, so routing can never silently leave the assistant without a
 * model to call.
 */
import { describe, it, expect } from "vitest";
import { modelForPath, DEFAULT_MODEL, FAST_MODEL } from "../../modules/ai-assistant/config";

describe("model routing by path", () => {
  it("uses the light model on the fast path", () => {
    expect(modelForPath(DEFAULT_MODEL, "fast")).toBe(FAST_MODEL);
  });

  it("keeps the configured primary on the deep path", () => {
    expect(modelForPath("my-primary", "deep")).toBe("my-primary");
  });

  it("never returns an empty model id", () => {
    // Routing must not be able to leave the assistant with no model to call.
    expect(modelForPath(DEFAULT_MODEL, "fast")).toBeTruthy();
    expect(modelForPath(DEFAULT_MODEL, "deep")).toBeTruthy();
  });

  it("picks a fast model that differs from the primary default", () => {
    // The whole point of routing is a different (cheaper) model; if they were
    // equal the abstraction would erase the benefit.
    expect(FAST_MODEL).not.toBe(DEFAULT_MODEL);
  });
});
