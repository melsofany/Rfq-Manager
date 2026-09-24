/**
 * The reserve that makes cross-provider failover real.
 *
 * The reported failure: the deployed primary is `gemini-3.8-flash` (measured
 * 1/5 success under load) and the Gemini chain has 7 models, so an outage that
 * makes every one answer 503 spends 7 × perModelMs (≈78s of a 100s completion
 * budget) before DeepSeek is tried. A slow 503 (~40s observed) exhausts the
 * budget outright, the healthy provider is never reached, and the operator is
 * told the quota is spent. `SECONDARY_RESERVE_SHARE` holds a slice of the budget
 * out of the primary chain's reach.
 *
 * Both keys are set HERE (config reads them at import time), which is the
 * condition the live service is now in — `DEEPSEEK_API_KEY` is configured.
 */
import { describe, it, expect } from "vitest";

process.env.AI_API_KEY = "gemini-reserve-test-key";
process.env.DEEPSEEK_API_KEY = "sk-deepseek-reserve-test-key";

describe("budget reserve for the secondary provider", () => {
  it("reserves a meaningful slice of the completion budget", async () => {
    const { secondaryReserveShare } = await import("../../modules/ai-assistant/llm");
    const share = secondaryReserveShare();
    // Too small and the secondary has no time for a tool-calling round; too
    // large and the primary (usually the better model) is starved.
    expect(share).toBeGreaterThanOrEqual(0.25);
    expect(share).toBeLessThanOrEqual(0.6);
  });

  it("puts BOTH providers in the chain, each with its own endpoint and key", async () => {
    const { resetModelState, modelChainForTest } = await import("../../modules/ai-assistant/llm");
    resetModelState();
    const chain = modelChainForTest(
      "gemini-3.8-flash",
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
    const providers = [...new Set(chain.map((c) => c.provider))];
    expect(providers).toContain("gemini");
    expect(providers).toContain("deepseek");

    // A candidate carrying the wrong endpoint/key would fail with a permanent
    // 401 and never actually be a fallback.
    const deepseek = chain.filter((c) => c.provider === "deepseek");
    expect(deepseek.length).toBeGreaterThan(0);
    for (const c of deepseek) {
      expect(c.base).toMatch(/deepseek/i);
      expect(c.apiKey).toBe("sk-deepseek-reserve-test-key");
    }
    for (const c of chain.filter((x) => x.provider === "gemini")) {
      expect(c.base).toMatch(/generativelanguage/i);
      expect(c.apiKey).toBe("gemini-reserve-test-key");
    }
  });
});
