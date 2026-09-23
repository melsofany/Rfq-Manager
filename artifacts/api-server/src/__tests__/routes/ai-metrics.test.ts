/**
 * Telemetry (P6). The assistant's failure modes are all COST failures (silent
 * timeouts, exhausted quota), and none of them was measurable before. These
 * tests pin the summary the dashboard reads, including the routing breakdowns
 * that show whether the fast/deep split and the fallback chain are working.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { recordMetrics, metricsSummary, recentMetrics, resetMetrics } =
  await import("../../modules/ai-assistant/metrics");

type M = Parameters<typeof recordMetrics>[0];
const base: M = {
  phone: "2010",
  intent: "document_lookup",
  path: "fast",
  routeReason: "test",
  rounds: 1,
  toolCalls: 1,
  toolNames: ["lookup_document"],
  verified: false,
  fallbackUsed: false,
  model: "gemini-3.6-flash",
  latencyMs: 1000,
  outcome: "answered",
};

beforeEach(() => resetMetrics());

describe("metricsSummary", () => {
  it("returns a zeroed summary with empty breakdowns when nothing was recorded", () => {
    const s = metricsSummary();
    expect(s.count).toBe(0);
    expect(s.byIntent).toEqual({});
    expect(s.byPath).toEqual({});
    expect(s.byModel).toEqual({});
    expect(s.avgToolCalls).toBe(0);
    expect(s.fallbackRate).toBe(0);
  });

  it("aggregates latency, rounds and the fallback rate", () => {
    recordMetrics({ ...base, latencyMs: 1000 });
    recordMetrics({ ...base, latencyMs: 3000, fallbackUsed: true, rounds: 2 });
    const s = metricsSummary();
    expect(s.count).toBe(2);
    expect(s.avgLatencyMs).toBe(2000);
    expect(s.avgRounds).toBe(1.5);
    expect(s.fallbackRate).toBe(0.5);
    expect(s.p95LatencyMs).toBeGreaterThanOrEqual(3000);
  });

  it("breaks requests down by intent, path and model", () => {
    recordMetrics({ ...base, intent: "analytics", path: "deep", model: "primary" });
    recordMetrics({ ...base, intent: "analytics", path: "deep", model: "primary" });
    recordMetrics({ ...base, intent: "smalltalk", path: "fast", model: "light" });
    const s = metricsSummary();
    expect(s.byIntent).toEqual({ analytics: 2, smalltalk: 1 });
    expect(s.byPath).toEqual({ deep: 2, fast: 1 });
    expect(s.byModel).toEqual({ primary: 2, light: 1 });
  });

  it("records a timeout as an outcome so the timeout rate is real", () => {
    recordMetrics({ ...base, outcome: "timeout", latencyMs: 160000 });
    recordMetrics(base);
    expect(metricsSummary().timeoutRate).toBe(0.5);
  });

  it("keeps only the most recent requests", () => {
    for (let i = 0; i < 150; i++) recordMetrics({ ...base, latencyMs: i });
    expect(recentMetrics(20)).toHaveLength(20);
    expect(metricsSummary().count).toBe(100);
  });

  it("breaks answers down by evidence level, defaulting unset ones to UNKNOWN", () => {
    recordMetrics({ ...base, confidence: "VERIFIED" });
    recordMetrics({ ...base, confidence: "VERIFIED" });
    recordMetrics({ ...base, confidence: "PARTIALLY_VERIFIED" });
    recordMetrics(base); // no confidence recorded
    const s = metricsSummary();
    expect(s.byConfidence).toEqual({ VERIFIED: 2, PARTIALLY_VERIFIED: 1, UNKNOWN: 1 });
  });
});
