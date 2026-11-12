// Usage ledger: derive per-call token usage and cost from OpenHands
// conversation event logs, and keep a local JSONL ledger.
//
// OpenHands writes per-turn token accounting into
// ConversationStateUpdateEvent -> stats -> usage_to_metrics[...] ->
// accumulated_token_usage { model, prompt_tokens, completion_tokens,
// cache_read_tokens, cache_write_tokens, reasoning_tokens }. We read that,
// price it with the LiteLLM map, and append a ledger row.
//
// SECURITY: never write API keys, prompts, or file contents to the ledger.
import { readdirSync, readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { priceSummary } from "./prices.mjs";
import { tierOf, modelById } from "./models.mjs";

export const DEFAULT_LEDGER_DIR = join(process.cwd(), "state");
export const DEFAULT_LEDGER = join(DEFAULT_LEDGER_DIR, "usage-ledger.jsonl");

export function costOfUsage(model, usage) {
  const p = priceSummary(model);
  const tier = tierOf(model) || "unknown";
  if (!p.found) return { usd: null, effectiveUsd: null, priced: false, tier, price: p };
  const prompt = Number(usage.prompt_tokens || 0);
  const completion = Number(usage.completion_tokens || 0);
  const cacheRead = Number(usage.cache_read_tokens || 0);
  const cacheWrite = Number(usage.cache_write_tokens || 0);
  // Cache-read tokens are billed at the cache-read rate when known, otherwise
  // at the full input rate (conservative).
  const fullInput = Math.max(0, prompt - cacheRead - cacheWrite);
  const inRate = (p.inputPerM ?? 0) / 1e6;
  const crRate = (p.cacheReadPerM ?? p.inputPerM ?? 0) / 1e6;
  const cwRate = (p.cacheWritePerM ?? p.inputPerM ?? 0) / 1e6;
  const outRate = (p.outputPerM ?? 0) / 1e6;
  const usd = fullInput * inRate + cacheRead * crRate + cacheWrite * cwRate + completion * outRate;
  // `usd` is the provider LIST price (what a paid account would be charged).
  // `effectiveUsd` is what this workspace is actually billed: zero only for a
  // model on a documented free tier. A free-tier model is never assumed free
  // beyond its quota, so the caveat is carried alongside.
  const effectiveUsd = tier === "free" ? 0 : usd;
  return {
    usd,
    effectiveUsd,
    priced: true,
    tier,
    freeTier: tier === "free",
    price: p,
    breakdown: { fullInput, cacheRead, cacheWrite, completion },
  };
}

export function readUsageFromEvents(conversationsDir) {
  const rows = [];
  if (!existsSync(conversationsDir)) return rows;
  for (const conv of readdirSync(conversationsDir)) {
    const evDir = join(conversationsDir, conv, "events");
    if (!existsSync(evDir)) continue;
    for (const f of readdirSync(evDir)) {
      if (!f.endsWith(".json")) continue;
      let d;
      try {
        d = JSON.parse(readFileSync(join(evDir, f), "utf8"));
      } catch {
        continue;
      }
      const stats = d?.stats || d?.state?.stats;
      const metrics = stats?.usage_to_metrics || d?.usage_to_metrics;
      if (!metrics) continue;
      for (const [usageId, m] of Object.entries(metrics)) {
        const u = m?.accumulated_token_usage;
        if (!u || !u.model) continue;
        rows.push({
          conversationId: conv,
          usageId,
          model: u.model,
          prompt_tokens: u.prompt_tokens ?? 0,
          completion_tokens: u.completion_tokens ?? 0,
          cache_read_tokens: u.cache_read_tokens ?? 0,
          cache_write_tokens: u.cache_write_tokens ?? 0,
          reasoning_tokens: u.reasoning_tokens ?? 0,
        });
      }
    }
  }
  return rows;
}

// De-duplicate: the state snapshot repeats accumulated totals as the
// conversation grows, so keep the max per (conversation, usageId).
export function latestPerConversation(rows) {
  const best = new Map();
  for (const r of rows) {
    const k = r.conversationId + "::" + r.usageId;
    const cur = best.get(k);
    if (!cur || r.prompt_tokens >= cur.prompt_tokens) best.set(k, r);
  }
  return [...best.values()];
}

export function summarize(rows) {
  const out = {
    calls: 0,
    byModel: {},
    totals: {
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      usd: 0, // effective (what this workspace is billed)
      listUsd: 0, // provider list price (what a paid account would pay)
    },
    unpriced: [],
    byTier: { free: 0, economical: 0, premium: 0, unknown: 0 },
  };
  for (const r of rows) {
    const c = costOfUsage(r.model, r);
    const tier = c.tier;
    out.calls += 1;
    out.byTier[tier] = (out.byTier[tier] || 0) + 1;
    const k = r.model;
    out.byModel[k] = out.byModel[k] || {
      calls: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_read_tokens: 0,
      usd: 0,
      listUsd: 0,
      tier,
    };
    out.byModel[k].calls += 1;
    out.byModel[k].prompt_tokens += r.prompt_tokens;
    out.byModel[k].completion_tokens += r.completion_tokens;
    out.byModel[k].cache_read_tokens += r.cache_read_tokens;
    out.totals.prompt_tokens += r.prompt_tokens;
    out.totals.completion_tokens += r.completion_tokens;
    out.totals.cache_read_tokens += r.cache_read_tokens;
    out.totals.cache_write_tokens += r.cache_write_tokens;
    out.totals.reasoning_tokens += r.reasoning_tokens;
    if (c.priced) {
      out.byModel[k].usd += c.effectiveUsd || 0;
      out.byModel[k].listUsd += c.usd || 0;
      out.totals.usd += c.effectiveUsd || 0;
      out.totals.listUsd += c.usd || 0;
    } else if (!out.unpriced.includes(r.model)) {
      out.unpriced.push(r.model);
    }
  }
  return out;
}

export function appendLedger(rows, ledgerPath = DEFAULT_LEDGER) {
  mkdirSync(join(ledgerPath, ".."), { recursive: true });
  const lines = rows
    .map((r) => {
      const c = costOfUsage(r.model, r);
      return JSON.stringify({
        ts: new Date().toISOString(),
        conversationId: r.conversationId,
        model: r.model,
        tier: tierOf(r.model) || "unknown",
        provider: modelById(r.model)?.provider || r.model.split("/")[0],
        prompt_tokens: r.prompt_tokens,
        completion_tokens: r.completion_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_write_tokens: r.cache_write_tokens,
        reasoning_tokens: r.reasoning_tokens,
        usd: c.priced ? Number((c.usd || 0).toFixed(8)) : null,
      });
    })
    .join("\n");
  if (lines) appendFileSync(ledgerPath, lines + "\n");
  return rows.length;
}

export function readLedger(ledgerPath = DEFAULT_LEDGER) {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function windowTotals(rows, sinceMs) {
  const now = Date.now();
  const pick = (ms) => rows.filter((r) => Date.parse(r.ts) >= now - ms);
  const sum = (a) => a.reduce((s, r) => s + (r.usd || 0), 0);
  return {
    today: sum(pick(24 * 3600 * 1000)),
    week: sum(pick(7 * 24 * 3600 * 1000)),
    month: sum(pick(30 * 24 * 3600 * 1000)),
    allTime: sum(rows),
    freeCalls: rows.filter((r) => r.tier === "free").length,
    paidCalls: rows.filter((r) => r.tier !== "free").length,
    totalCalls: rows.length,
  };
}
