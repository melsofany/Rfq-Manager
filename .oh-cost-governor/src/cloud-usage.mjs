// Authoritative spend monitoring from the OpenHands Cloud organization API.
//
// The cloud knows what was actually billed; the local event logs know what
// models ran. We combine both: cloud numbers drive the budget, local numbers
// explain it and catch unpriced/free usage.
import { budgetBreakdown, alertLevel } from "./policy.mjs";
import { tierOf } from "./models.mjs";

const API = process.env.OH_CLOUD_API || "https://app.all-hands.dev/api";

function auth() {
  const t = process.env.OPENHANDS_API_KEY;
  if (!t) throw new Error("OPENHANDS_API_KEY not set");
  return { Authorization: `Bearer ${t}` };
}

async function get(path) {
  const r = await fetch(`${API}${path}`, { headers: auth() });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
}

export async function discoverOrgId() {
  if (process.env.OH_ORG_ID) return process.env.OH_ORG_ID;
  const d = await get("/organizations");
  const items = d.items || d.organizations || [];
  if (!items.length) throw new Error("no organization found for this account");
  return items[0].id;
}

export async function fetchCloudUsage(orgId) {
  const org = orgId || (await discoverOrgId());
  const [usage, stats, credits, me] = await Promise.all([
    get(`/organizations/${org}/conversations/my-usage`).catch(() => null),
    get(`/organizations/${org}/conversations/usage-stats`).catch(() => null),
    get("/billing/credits").catch(() => null),
    get(`/organizations/${org}/budgets/me`).catch(() => null),
  ]);
  return { orgId: org, usage, stats, credits, budgetMe: me };
}

// Map the cloud's per-model spend onto our tiers so the report can show how
// much of the spend went to models we consider paid.
export function tierBreakdown(cloudUsage) {
  const rows = cloudUsage?.usage?.model_usage || [];
  const out = { free: 0, economical: 0, premium: 0, unknown: 0, unpricedButBilled: [] };
  for (const m of rows) {
    const t = tierOf(m.model_name) || "unknown";
    const cost = Number(m.total_cost || 0);
    out[t] = (out[t] || 0) + cost;
    if (t === "unknown" && cost > 0) out.unpricedButBilled.push({ model: m.model_name, cost });
  }
  return out;
}

export function cloudSummary(cloudUsage) {
  const u = cloudUsage?.usage || {};
  const stats = cloudUsage?.stats || {};
  const daily = (u.daily_spend || []).map((d) => ({ date: d.date, cost: Number(d.cost || 0) }));
  const now = Date.now();
  const sumSince = (days) =>
    daily
      .filter((d) => Date.parse(d.date) >= now - days * 86400000)
      .reduce((s, d) => s + d.cost, 0);
  return {
    orgId: cloudUsage?.orgId,
    creditsRemainingUsd:
      cloudUsage?.credits?.credits != null ? Number(cloudUsage.credits.credits) : null,
    monthToDateUsd: Number(u.total_spend || 0),
    previousPeriodUsd: Number(u.previous_period_spend || 0),
    todayUsd: sumSince(1),
    weekUsd: sumSince(7),
    totalTokens: Number(stats.total_tokens || 0),
    agentRuns: Number(stats.agent_runs || 0),
    conversationCount: Number(stats.usage_conversation_count || 0),
    modelUsage: u.model_usage || [],
    daily,
    tierSpend: tierBreakdown(cloudUsage),
    monthlyBudgetLimit: cloudUsage?.budgetMe?.monthly_limit ?? null,
    budgetEnabled: cloudUsage?.budgetMe?.enabled ?? false,
  };
}

export function alertsFor(state, summary) {
  const b = budgetBreakdown(state);
  // Prefer the authoritative month-to-date cloud spend when available.
  const spent = summary?.monthToDateUsd != null ? summary.monthToDateUsd : b.spent;
  const usedPct = b.target > 0 ? spent / b.target : 0;
  const level = alertLevel({ ...state, spentUsd: spent });
  const thresholds = state.alertThresholds || [0.5, 0.75, 0.9];
  const messages = thresholds
    .filter((t) => usedPct >= t)
    .map((t) => {
      const pct = Math.round(t * 100);
      if (t >= 0.9)
        return `[RED] ${pct}%: paid models are HARD-STOPPED. Free tiers only until reset or explicit approval.`;
      if (t >= 0.75)
        return `[AMBER] ${pct}%: approaching the ceiling — prefer free models, avoid premium.`;
      return `[YELLOW] ${pct}%: half the budget is used.`;
    });
  return {
    spentUsd: spent,
    targetUsd: b.target,
    usedPct,
    level,
    hardStopPaid: level != null && level >= 0.9,
    messages,
  };
}
