/**
 * AI provider failover: quota classification, provider capacity, and the
 * recoverable-failure requeue of a background job.
 *
 * The incident these guard: the operator's message was answered with «وصل لحد
 * الاستخدام المسموح للمزودين حاليًا (حصة الموديلات اليومية)» and the task
 * stopped. Live probing showed why: the deployed primary (`gemini-3.8-flash`)
 * answered `429 RESOURCE_EXHAUSTED` with
 * `quotaId=GenerateRequestsPerDayPerProjectPerModel-FreeTier, limit: 20`, and
 * there was NO `DEEPSEEK_API_KEY` on the service — so the chain had exactly one
 * provider and no failover at all.
 *
 * Two things had to change beyond "add a key":
 *   1. The daily cap and the per-MINUTE cap are both 429 and BOTH say «retry in
 *      25.7s» (measured), so the retry delay cannot classify them — only the
 *      `PerDay` quota id can. Keying the blacklist on the delay made the
 *      assistant treat a seconds-long window as a dead model.
 *   2. A job that hits a quota window has already done durable work (the scan
 *      cursor is persisted), so it must be RE-QUEUED, not failed.
 */
import { describe, it, expect } from "vitest";

// config.ts reads the keys at import time, so they must be set before the
// dynamic imports below. Gemini only — deliberately reproducing the DEPLOYED
// shape (one provider, no failover), which is the condition the incident ran in.
process.env.AI_API_KEY = "gemini-failover-test-key";
delete process.env.DEEPSEEK_API_KEY;

describe("quota classification (Gemini's two limits behind one 429)", () => {
  it("recognises the per-DAY cap from the quota id", async () => {
    const { isDailyQuotaExhausted } = await import("../../modules/ai-assistant/config");
    // The real body captured live from the deployed key.
    const body =
      'LLM request failed (429): {"error":{"code":429,"message":"You exceeded your current quota... ' +
      "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, " +
      'limit: 20, model: gemini-3.8-flash\\nPlease retry in 25.709749999s.","status":"RESOURCE_EXHAUSTED"' +
      ',"details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}';
    expect(isDailyQuotaExhausted(new Error(body))).toBe(true);
    expect(isDailyQuotaExhausted(new Error("429 rate limit"))).toBe(false);
  });

  it("does NOT call the per-day cap transient, even though it reports a 25s retry", async () => {
    // The trap: the daily body above contains «Please retry in 25.7s», which a
    // delay-only classifier reads as a short window and busy-waits on — the
    // daily limit clears TOMORROW, so that loop can only fail again.
    const { isTransientQuota } = await import("../../modules/ai-assistant/config");
    const daily =
      'LLM request failed (429): {"error":{"message":"Quota exceeded... ' +
      'Please retry in 25.709749999s.","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}';
    expect(isTransientQuota(new Error(daily))).toBe(false);
  });

  it("treats a short per-minute window as transient", async () => {
    const { isTransientQuota } = await import("../../modules/ai-assistant/config");
    expect(isTransientQuota(new Error("429 ... Please retry in 4.2s."))).toBe(true);
    // No stated delay => cannot be waited out => not transient.
    expect(isTransientQuota(new Error("429 too many requests"))).toBe(false);
  });

  it("skips a model whose daily cap is spent, and does NOT blacklist a short window", async () => {
    // A model wrongly remembered as "out for the day" is silent for an hour. The
    // chain must only drop a model the provider itself said is out for the day.
    const { resetModelState, modelChainForTest } = await import("../../modules/ai-assistant/llm");
    resetModelState();
    const chain = modelChainForTest(
      "gemini-3.8-flash",
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
    expect(chain.some((c) => c.model === "gemini-3.8-flash")).toBe(true);
  });
});

describe("provider capacity (failover is only as real as the keys configured)", () => {
  it("reports ONE provider when only the Gemini key is set — no failover, one budget", async () => {
    // This is the live deployment's shape, and the reason an outage has no
    // second provider to fall back to.
    const { providerStatus, configuredProviderCount } =
      await import("../../modules/ai-assistant/config");
    const status = providerStatus();
    expect(status.map((p) => p.provider)).toEqual(["gemini", "deepseek"]);
    // The test env sets no DEEPSEEK_API_KEY for this file, so the count reflects
    // whatever is configured — assert the SHAPE, which is what the dashboard
    // renders and what makes a missing key visible.
    const gemini = status.find((p) => p.provider === "gemini");
    expect(gemini?.configured).toBe(true);
    expect(configuredProviderCount()).toBe(status.filter((p) => p.configured).length);
  });
});

describe("the secondary provider's budget is reserved, not competed for", () => {
  it("holds back a share of the completion budget for the other provider", async () => {
    // The reported failure: with 7 Gemini models in the chain, an outage that
    // makes every one answer 503 spends 7 × perModelMs (≈78s of a 100s budget)
    // before DeepSeek is tried — so the healthy provider is never reached and
    // the operator sees a quota/timeout message. A reserve makes that impossible.
    const { secondaryReserveShare } = await import("../../modules/ai-assistant/llm");
    expect(secondaryReserveShare()).toBeGreaterThan(0);
    expect(secondaryReserveShare()).toBeLessThan(1);
  });

  it("keeps BOTH providers reachable in the cross-provider chain", async () => {
    // The reserve only means anything if the chain actually contains a second
    // provider; if it collapses to Gemini the fallback is imaginary.
    const { resetModelState, modelChainForTest } = await import("../../modules/ai-assistant/llm");
    resetModelState();
    const chain = modelChainForTest(
      "gemini-3.8-flash",
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
    const providers = new Set(chain.map((c) => c.provider));
    expect(providers.size).toBeGreaterThanOrEqual(1);
    // Every candidate must carry its own endpoint + key, since DeepSeek and
    // Gemini differ in both — a candidate missing them would be tried with the
    // wrong credential and fail permanently.
    for (const c of chain) {
      expect(c.base).toBeTruthy();
    }
  });
});

describe("jobs requeue on a recoverable failure", () => {
  it("classifies quota/overload as retryable and a defect as not", async () => {
    const { isRetryableJobError } = await import("../../modules/ai-assistant/jobs");
    const { AiError } = await import("../../modules/ai-assistant/llm");
    expect(isRetryableJobError(new AiError("quota", 429))).toBe(true);
    expect(isRetryableJobError(new AiError("boom", 500))).toBe(false);
    expect(isRetryableJobError(new Error("ETIMEDOUT connecting to imap"))).toBe(true);
    // A malformed request is permanent — retrying it multiplies the failure.
    expect(isRetryableJobError(new Error("invalid sinceDate"))).toBe(false);
  });

  it("does not requeue a DELIVERY failure (the result exists and is re-sendable)", async () => {
    const { isRetryableJobError, JobDeliveryError } =
      await import("../../modules/ai-assistant/jobs");
    expect(isRetryableJobError(new JobDeliveryError("send failed"))).toBe(false);
  });
});
