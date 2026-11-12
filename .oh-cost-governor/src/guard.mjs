#!/usr/bin/env node
// Preflight guard: decide whether a model may run, and exit non-zero when it
// may not. This is the enforcement point to wrap around any task launcher.
//
// Usage:
//   node src/guard.mjs --model <id> [--component agent] [--approval <id>]
//   node src/guard.mjs --task "<task text>"          # classify + recommend
//   node src/guard.mjs --approve --model <id> --cost <usd> [--task "<text>"]
//   node src/guard.mjs --list-approvals
//
// Exit codes: 0 allow, 2 deny/approval-required, 3 usage error.
import { evaluateRequest, estimateTaskCost, recordSpend, budgetBreakdown } from "./policy.mjs";
import { loadState, saveState } from "./state.mjs";
import { planForTask } from "./router.mjs";

function parseArgs(argv) {
  const a = { component: "agent" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--model") a.model = argv[++i];
    else if (k === "--component") a.component = argv[++i];
    else if (k === "--approval") a.approval = argv[++i];
    else if (k === "--task") a.task = argv[++i];
    else if (k === "--cost") a.cost = Number(argv[++i]);
    else if (k === "--ttl-min") a.ttlMin = Number(argv[++i]);
    else if (k === "--approve") a.approve = true;
    else if (k === "--list-approvals") a.listApprovals = true;
    else if (k === "--revoke") a.revoke = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const state = loadState();

if (args.listApprovals) {
  console.log(JSON.stringify(state.approvals || [], null, 2));
  process.exit(0);
}

if (args.revoke) {
  state.approvals = (state.approvals || []).filter((x) => x.id !== args.revoke);
  saveState(state);
  console.log(`revoked approval ${args.revoke}`);
  process.exit(0);
}

if (args.approve) {
  if (!args.model) {
    console.error("--approve requires --model");
    process.exit(3);
  }
  const est = estimateTaskCost(state, args.model);
  const id = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const approval = {
    id,
    model: args.model,
    task: args.task || null,
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (args.ttlMin ?? 60) * 60000).toISOString(),
    estimateUsd: est.estimateUsd,
    requestedCostUsd: Number.isFinite(args.cost) ? args.cost : null,
    used: false,
  };
  state.approvals = [...(state.approvals || []), approval];
  saveState(state);
  console.log(JSON.stringify(approval, null, 2));
  process.exit(0);
}

if (args.task && !args.model) {
  const plan = planForTask(args.task);
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}

if (!args.model) {
  console.error(
    "Usage: guard.mjs --model <id> | --task <text> | --approve --model <id> | --list-approvals",
  );
  process.exit(3);
}

const decision = evaluateRequest(state, {
  model: args.model,
  component: args.component,
  approvalId: args.approval,
});
console.log(JSON.stringify(decision, null, 2));

if (decision.decision === "allow") {
  // Mark a one-shot approval as used and record an estimated spend if asked.
  if (args.approval) {
    const s = loadState();
    const ap = (s.approvals || []).find((x) => x.id === args.approval);
    if (ap) {
      ap.used = true;
      ap.usedAt = new Date().toISOString();
      saveState(s);
    }
  }
  if (Number.isFinite(args.cost) && args.cost > 0) {
    const s2 = recordSpend(loadState(), args.cost, { model: args.model });
    saveState(s2);
    console.log("\nRecorded spend:", JSON.stringify(budgetBreakdown(s2), null, 2));
  }
  process.exit(0);
}
process.exit(2);
