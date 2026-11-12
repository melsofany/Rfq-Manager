#!/usr/bin/env node
// Cost-governor CLI.
import { CATALOG, modelsByTier, tierOf } from "./models.mjs";
import { priceSummary, priceSource } from "./prices.mjs";
import {
  evaluateRequest,
  budgetBreakdown,
  estimateTaskCost,
  recordSpend,
  remainingPaidUsd,
} from "./policy.mjs";
import { classify, planForTask, simulateFallback, FAILURE_KINDS, RETRY_BUDGET } from "./router.mjs";
import { loadState, saveState, STATE_FILE } from "./state.mjs";
import {
  readUsageFromEvents,
  latestPerConversation,
  summarize,
  appendLedger,
  readLedger,
  windowTotals,
} from "./ledger.mjs";
import { fetchCloudUsage, cloudSummary, alertsFor } from "./cloud-usage.mjs";

const CONV_DIR = process.env.OH_CONVERSATIONS_PATH || "/workspace/conversations";
const LEDGER = process.env.OH_LEDGER_PATH;

function fmt(n, d = 4) {
  return n == null ? "—" : Number(n).toFixed(d);
}

function cmdPrices() {
  console.log(`Price source: ${priceSource() || "(not found)"}\n`);
  console.log(
    "model".padEnd(42),
    "tier".padEnd(11),
    "in$/1M".padStart(9),
    "out$/1M".padStart(10),
    "cacheR$/1M".padStart(11),
  );
  for (const m of CATALOG) {
    const p = priceSummary(m.id);
    console.log(
      m.id.padEnd(42),
      m.tier.padEnd(11),
      fmt(p.inputPerM).padStart(9),
      fmt(p.outputPerM).padStart(10),
      fmt(p.cacheReadPerM).padStart(11),
    );
  }
}

function cmdTiers() {
  for (const t of ["free", "economical", "premium"]) {
    console.log(`\n== ${t.toUpperCase()} ==`);
    for (const m of modelsByTier(t))
      console.log("  ", m.id.padEnd(42), m.freeTier ? "(documented free tier)" : "");
  }
}

function cmdRoute(task, opts = {}) {
  const plan = planForTask(task, opts);
  console.log(JSON.stringify(plan, null, 2));
}

function cmdReport() {
  const rows = latestPerConversation(readUsageFromEvents(CONV_DIR));
  const sum = summarize(rows);
  console.log("=== Live usage (from conversation event logs) ===");
  console.log(
    "model".padEnd(42),
    "tier".padEnd(11),
    "calls".padStart(6),
    "in".padStart(10),
    "out".padStart(9),
    "cacheR".padStart(10),
    "usd".padStart(10),
  );
  for (const [model, v] of Object.entries(sum.byModel)) {
    console.log(
      model.padEnd(42),
      v.tier.padEnd(11),
      String(v.calls).padStart(6),
      String(v.prompt_tokens).padStart(10),
      String(v.completion_tokens).padStart(9),
      String(v.cache_read_tokens).padStart(10),
      fmt(v.usd, 6).padStart(10),
    );
  }
  console.log("\nTotals:", JSON.stringify(sum.totals, null, 2));
  console.log("Calls by tier:", JSON.stringify(sum.byTier));
  if (sum.unpriced.length)
    console.log("Unpriced models (treated as unknown/paid):", sum.unpriced.join(", "));

  const ledger = readLedger(LEDGER);
  if (ledger.length) {
    const w = windowTotals(ledger);
    console.log("\n=== Ledger windows ===");
    console.log(JSON.stringify(w, null, 2));
  }
  const st = loadState();
  console.log("\n=== Budget ===");
  console.log(JSON.stringify(budgetBreakdown(st), null, 2));
  console.log("Remaining paid (spendable):", fmt(remainingPaidUsd(st), 4));
}

function cmdLedgerSync() {
  const rows = latestPerConversation(readUsageFromEvents(CONV_DIR));
  const n = appendLedger(rows, LEDGER);
  console.log(`Appended ${n} usage row(s) to ${LEDGER || "state/usage-ledger.jsonl"}`);
}

function cmdSpend(usd, model) {
  const st = recordSpend(loadState(), Number(usd), { model });
  saveState(st);
  console.log(
    JSON.stringify(
      {
        spentUsd: st.spentUsd,
        hardStopPaid: st.hardStopPaid,
        alertsFired: st.alertsFired,
        budget: budgetBreakdown(st),
      },
      null,
      2,
    ),
  );
}

function cmdEvaluate(model, component, approvalId) {
  const st = loadState();
  const d = evaluateRequest(st, { model, component: component || "agent", approvalId });
  console.log(JSON.stringify(d, null, 2));
  process.exitCode = d.decision === "allow" ? 0 : 2;
}

function cmdEstimate(model) {
  console.log(JSON.stringify(estimateTaskCost(loadState(), model), null, 2));
}

function cmdSimulate(task, failuresCsv) {
  const failures = (failuresCsv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(JSON.stringify(simulateFallback(task, failures), null, 2));
}

function cmdState() {
  console.log("state file:", STATE_FILE);
  console.log(JSON.stringify(loadState(), null, 2));
}

async function cmdCloud() {
  const cu = await fetchCloudUsage(process.env.OH_ORG_ID);
  const s = cloudSummary(cu);
  console.log("=== Cloud spend (authoritative) ===");
  console.log(
    JSON.stringify(
      {
        orgId: s.orgId,
        creditsRemainingUsd: s.creditsRemainingUsd,
        todayUsd: Number(s.todayUsd.toFixed(4)),
        weekUsd: Number(s.weekUsd.toFixed(4)),
        monthToDateUsd: Number(s.monthToDateUsd.toFixed(4)),
        previousPeriodUsd: Number(s.previousPeriodUsd.toFixed(4)),
        totalTokens: s.totalTokens,
        agentRuns: s.agentRuns,
        conversations: s.conversationCount,
        monthlyBudgetLimit: s.monthlyBudgetLimit,
        budgetEnabled: s.budgetEnabled,
      },
      null,
      2,
    ),
  );
  console.log("\n=== Spend by model (cloud) ===");
  console.log(
    "model".padEnd(46),
    "convs".padStart(6),
    "tokens".padStart(14),
    "usd".padStart(10),
    "tier".padStart(11),
  );
  for (const m of s.modelUsage) {
    console.log(
      String(m.model_name).padEnd(46),
      String(m.conversation_count).padStart(6),
      String(m.total_tokens).padStart(14),
      Number(m.total_cost || 0)
        .toFixed(6)
        .padStart(10),
      (tierOf(m.model_name) || "unknown").padStart(11),
    );
  }
  console.log("\n=== Spend by tier ===");
  const t = s.tierSpend;
  console.log(
    JSON.stringify(
      { free: t.free, economical: t.economical, premium: t.premium, unknown: t.unknown },
      null,
      2,
    ),
  );
  if (t.unpricedButBilled.length) {
    console.log(
      "Billed but unpriced models (deny-by-default candidates):",
      JSON.stringify(t.unpricedButBilled, null, 2),
    );
  }
  const a = alertsFor(loadState(), s);
  console.log("\n=== Budget alerts ===");
  console.log(JSON.stringify(a, null, 2));
}

function cmdAlerts() {
  const st = loadState();
  const rows = readLedger(LEDGER);
  const w = windowTotals(rows);
  const a = alertsFor(st, { monthToDateUsd: st.spentUsd });
  console.log(JSON.stringify({ ...a, localLedger: w }, null, 2));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "cloud":
      return cmdCloud();
    case "alerts":
      return cmdAlerts();
    case "prices":
      return cmdPrices();
    case "tiers":
      return cmdTiers();
    case "route":
      return cmdRoute(args[0] || "", { forcedModel: args[1] });
    case "report":
      return cmdReport();
    case "ledger-sync":
      return cmdLedgerSync();
    case "spend":
      return cmdSpend(args[0], args[1]);
    case "evaluate":
      return cmdEvaluate(args[0], args[1], args[2]);
    case "estimate":
      return cmdEstimate(args[0]);
    case "simulate":
      return cmdSimulate(args[0] || "", args[1]);
    case "state":
      return cmdState();
    case "failure-kinds":
      return console.log(JSON.stringify(FAILURE_KINDS, null, 2));
    case "budget":
      return console.log(
        JSON.stringify(
          { retryBudget: RETRY_BUDGET, budget: budgetBreakdown(loadState()) },
          null,
          2,
        ),
      );
    default:
      console.log(
        `Usage: cli.mjs <prices|tiers|route|report|cloud|alerts|ledger-sync|spend|evaluate|estimate|simulate|state|failure-kinds|budget> [args]`,
      );
  }
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
