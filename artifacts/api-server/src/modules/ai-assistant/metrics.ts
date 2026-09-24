/**
 * AI Assistant — per-request telemetry.
 *
 * Every answer records what it cost: which intent/path the router chose, how
 * many model rounds were spent, which tools ran, whether the verification round
 * fired, the wall-clock latency, and whether a model fallback was used. The
 * assistant's recorded failure modes (silent timeouts, exhausted daily quota)
 * are all *cost* problems, and none of them was measurable before — a diagnosis
 * meant reading logs by hand. This makes "was that question expensive, and why?"
 * a single structured log line and a value the run can attach to its own result.
 *
 * Kept deliberately small: an in-memory ring buffer of recent requests (for the
 * admin dashboard) plus structured logging. No table, no writes on the hot path.
 */
import { logger } from "../../shared/logger";
import type { QueryIntent, QueryPath } from "./router";
import type { Confidence } from "./evidence";

export interface RequestMetrics {
  phone: string;
  intent: QueryIntent;
  path: QueryPath;
  routeReason: string;
  /** Model rounds actually spent (chat completions issued). */
  rounds: number;
  /** Distinct/annotated tool invocations in this run. */
  toolCalls: number;
  toolNames: string[];
  /** True when the grounding-verification round ran. */
  verified: boolean;
  /** True when a model fallback (not the primary) produced the answer. */
  fallbackUsed: boolean;
  /** The primary model the router selected for this path (P6 model routing). */
  model: string;
  /**
   * The model that actually answered, when it differs from `model` — set on a
   * fallback. On the two-provider setup this is how a DeepSeek rescue is visible:
   * `model` stays the Gemini id the router picked, `modelUsed` names what spoke.
   */
  modelUsed?: string;
  /** The provider that answered ("gemini" | "deepseek"). */
  provider?: string;
  latencyMs: number;
  /** Set when the run ended in a timeout/quota error instead of an answer. */
  outcome: "answered" | "timeout" | "quota" | "error";
  /**
   * Answer evidence level, shown on the dashboard. A concurrent figure the model
   * asserted with no tool result behind it is what the operator cannot detect —
   * so "was this reply verified?" must be visible, not inferred from a flag.
   */
  confidence?: Confidence;
  /**
   * Task-execution trace (OpenManus-derived control flow): steps taken, tool
   * errors, how often the run was steered out of a loop or granted an extra
   * round. The "assistant fails at many tasks" reports are execution problems,
   * and without these numbers a stall is only visible by reading logs.
   */
  task?: {
    steps: number;
    toolCalls: number;
    toolErrors: number;
    distinctTools: number;
    successfulTools: number;
    forcedAnswers: number;
    steers: number;
    detections: number;
    /**
     * Real figures reported by data tools on this run: how many source rows went
     * into an aggregate, how many groups came out, and anything a filter or a
     * ceiling cut. The "PDF had 15 items" report was undiagnosable from the
     * transcript because a sample and a full set looked identical.
     */
    data?: Array<Record<string, unknown>>;
  };
}

const HISTORY_LIMIT = 100;
const history: RequestMetrics[] = [];

/** Record one request, log it structurally, and keep it for the dashboard. */
export function recordMetrics(m: RequestMetrics): void {
  history.push(m);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  logger.info(
    {
      phone: m.phone,
      intent: m.intent,
      path: m.path,
      route: m.routeReason,
      rounds: m.rounds,
      toolCalls: m.toolCalls,
      tools: m.toolNames,
      verified: m.verified,
      fallbackUsed: m.fallbackUsed,
      model: m.model,
      modelUsed: m.modelUsed,
      provider: m.provider,
      latencyMs: m.latencyMs,
      outcome: m.outcome,
    },
    "AI assistant: request metrics",
  );
}

/** Most recent requests, newest last — for the admin dashboard. */
export function recentMetrics(limit = 20): RequestMetrics[] {
  return history.slice(-limit);
}

/**
 * Aggregate view for the dashboard: average latency, P95, timeout rate and the
 * model-call average over the retained window. Percentiles are computed over the
 * in-memory buffer only — this is an operational signal, not an audit trail.
 */
export interface MetricsSummary {
  count: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgRounds: number;
  timeoutRate: number;
  verificationRate: number;
  /** Model-call average: how many provider requests one answer costs. */
  avgToolCalls: number;
  /** Share of answers that needed a fallback model (quota/overload signal). */
  fallbackRate: number;
  /** Requests per intent — shows what the assistant is actually used for. */
  byIntent: Record<string, number>;
  /** Requests per path (fast/deep) — the router's own effectiveness. */
  byPath: Record<string, number>;
  /** Requests per primary model — which model carried the traffic. */
  byModel: Record<string, number>;
  /** Answers per evidence level — how much of the traffic was fully verified. */
  byConfidence: Record<string, number>;
}

export function metricsSummary(): MetricsSummary {
  const n = history.length;
  if (n === 0) {
    return {
      count: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      avgRounds: 0,
      timeoutRate: 0,
      verificationRate: 0,
      avgToolCalls: 0,
      fallbackRate: 0,
      byIntent: {},
      byPath: {},
      byModel: {},
      byConfidence: {},
    };
  }
  const latencies = history.map((h) => h.latencyMs).sort((a, b) => a - b);
  const p95Index = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));
  const sum = <T>(f: (x: RequestMetrics) => T) => history.reduce((a, x) => a + Number(f(x)), 0);
  const tally = (f: (x: RequestMetrics) => string) =>
    history.reduce<Record<string, number>>((acc, x) => {
      const k = f(x) || "unknown";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
  return {
    count: n,
    avgLatencyMs: Math.round(sum((h) => h.latencyMs) / n),
    p95LatencyMs: latencies[p95Index] ?? 0,
    avgRounds: Number((sum((h) => h.rounds) / n).toFixed(2)),
    timeoutRate: Number((sum((h) => (h.outcome === "timeout" ? 1 : 0)) / n).toFixed(3)),
    verificationRate: Number((sum((h) => (h.verified ? 1 : 0)) / n).toFixed(3)),
    avgToolCalls: Number((sum((h) => h.toolCalls) / n).toFixed(2)),
    fallbackRate: Number((sum((h) => (h.fallbackUsed ? 1 : 0)) / n).toFixed(3)),
    byIntent: tally((h) => h.intent),
    byPath: tally((h) => h.path),
    byModel: tally((h) => h.model),
    byConfidence: tally((h) => h.confidence ?? "UNKNOWN"),
  };
}

/** Test-only: drop the retained buffer so cases do not leak into each other. */
export function resetMetrics(): void {
  history.length = 0;
}
