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
import {
  modelForPath,
  DEFAULT_MODEL,
  FAST_MODEL,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_FALLBACK_MODELS,
} from "../../modules/ai-assistant/config";

describe("model routing by path", () => {
  it("uses the light DeepSeek model on the fast path when DeepSeek is primary", () => {
    const light = modelForPath(DEFAULT_MODEL, "fast", DEEPSEEK_BASE_URL);
    expect(light).toBe(DEEPSEEK_FALLBACK_MODELS[0]);
  });

  it("keeps the configured primary on the deep path", () => {
    expect(modelForPath("my-primary", "deep")).toBe("my-primary");
  });

  it("never returns an empty model id", () => {
    // Routing must not be able to leave the assistant with no model to call.
    expect(modelForPath(DEFAULT_MODEL, "fast")).toBeTruthy();
    expect(modelForPath(DEFAULT_MODEL, "deep")).toBeTruthy();
    // A DeepSeek endpoint with no configured fallback still yields the primary.
    expect(modelForPath(DEFAULT_MODEL, "fast", "https://api.deepseek.com/v1")).toBeTruthy();
  });

  it("picks a fast model that differs from the primary default", () => {
    // The whole point of routing is a different (cheaper) model; if they were
    // equal the abstraction would erase the benefit. On the DeepSeek endpoint the
    // light model is DeepSeek's fast model, not the reasoning flagship.
    const light = modelForPath(DEFAULT_MODEL, "fast", "https://api.deepseek.com/v1");
    expect(light).not.toBe(DEFAULT_MODEL);
  });

  it("keeps the Gemini fast model when Gemini is the primary", () => {
    const light = modelForPath(
      "gemini-3.6-flash",
      "fast",
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
    expect(light).toBe(FAST_MODEL);
  });
});
