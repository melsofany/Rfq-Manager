// Deny-by-default spend policy.
//
// This module is the single source of truth for "may this request run, and on
// what?". It is pure: give it a state object and a request, get a decision.
// The CLI/guard layers persist the state and enforce the decision.
//
// Rules (evaluated in order):
//   R0  Unknown model              -> deny            (deny-by-default)
//   R1  Free tier                  -> allow
//   R2  Budget exhausted (>=90%)   -> deny paid, free still allowed
//   R3  Reserve would be breached  -> deny paid
//   R4  Internal component using a paid model -> deny (planner/condenser/
//       sub-agent/background/retry may never spend without the same approval)
//   R5  Economical within budget   -> allow
//   R6  Premium                    -> approval_required (unless a valid,
//       unexpired, task-scoped approval is supplied)
import { tierOf, modelById, isPaidModel, freeTierCaveat } from "./models.mjs";
import { priceSummary } from "./prices.mjs";

export const INTERNAL_COMPONENTS = [
  "planner",
  "condenser",
  "subagent",
  "background",
  "auto_retry",
  "auto_fallback",
];

export const DEFAULT_STATE = {
  currency: "USD",
  claudeTargetUsd: 5.0,
  allocation: { essential: 0.7, complex: 0.2, reserve: 0.1 },
  spentUsd: 0,
  alertThresholds: [0.5, 0.75, 0.9],
  alertsFired: [],
  approvals: [],
  // When true, paid spend is hard-stopped (set by the 90% alert or by hand).
  hardStopPaid: false,
};

export function budgetBreakdown(state) {
  const target = Number(state.claudeTargetUsd ?? DEFAULT_STATE.claudeTargetUsd);
  const alloc = { ...DEFAULT_STATE.allocation, ...(state.allocation || {}) };
  const essential = target * alloc.essential;
  const complex = target * alloc.complex;
  const reserve = target * alloc.reserve;
  const spendable = essential + complex; // reserve is locked by default
  const spent = Number(state.spentUsd || 0);
  const usedPct = target > 0 ? spent / target : 0;
  return {
    target,
    essential,
    complex,
    reserve,
    spendable,
    spent,
    remaining: Math.max(0, target - spent),
    remainingSpendable: Math.max(0, spendable - spent),
    usedPct,
  };
}

export function alertLevel(state) {
  const b = budgetBreakdown(state);
  const sorted = [...(state.alertThresholds || DEFAULT_STATE.alertThresholds)].sort(
    (a, c) => a - c,
  );
  let level = null;
  for (const t of sorted) if (b.usedPct >= t) level = t;
  return level;
}

export function isApprovalValid(state, approval, modelId) {
  if (!approval) return false;
  if (approval.model !== modelId) return false;
  if (approval.expiresAt && Date.parse(approval.expiresAt) < Date.now()) return false;
  if (approval.used) return false;
  return true;
}

/**
 * Decide whether a request may proceed.
 * @param {object} state    policy state (see DEFAULT_STATE)
 * @param {object} req      { model, component?, approvalId?, taskTier? }
 */
export function evaluateRequest(state, req) {
  const st = { ...DEFAULT_STATE, ...state };
  const { model } = req;
  const component = (req.component || "agent").toLowerCase();
  const b = budgetBreakdown(st);
  const alert = alertLevel(st);
  const base = { model, component, tier: tierOf(model), budget: b, alertLevel: alert };

  // R0 - unknown model => deny (deny-by-default)
  if (!modelById(model)) {
    return {
      ...base,
      decision: "deny",
      reason: "unknown_model",
      message: `Unknown model '${model}' — deny by default.`,
    };
  }

  const tier = tierOf(model);
  const paid = isPaidModel(model);

  // R1 - free tier always allowed
  if (!paid) {
    return {
      ...base,
      decision: "allow",
      reason: "free_tier",
      caveat: freeTierCaveat(model),
      message: `Free tier '${model}' allowed.`,
    };
  }

  // R2 - 90% hard stop
  if (st.hardStopPaid || (alert != null && alert >= 0.9)) {
    return {
      ...base,
      decision: "deny",
      reason: "budget_90pct_hard_stop",
      message: `Paid models are disabled at >=90% of the target budget (used ${(b.usedPct * 100).toFixed(1)}%). Free tiers only until the budget is reset or approved.`,
    };
  }

  // R3 - reserve protection
  if (b.spent >= b.spendable) {
    return {
      ...base,
      decision: "deny",
      reason: "reserve_locked",
      message: `Spendable budget exhausted ($${b.spendable.toFixed(2)} of $${b.target.toFixed(2)}); the ${(st.allocation.reserve * 100).toFixed(0)}% reserve is locked.`,
    };
  }

  // R4 - internal components may never use a paid model without approval
  if (INTERNAL_COMPONENTS.includes(component)) {
    const appr = (st.approvals || []).find((a) => a.id === req.approvalId);
    if (!isApprovalValid(st, appr, model)) {
      return {
        ...base,
        decision: "deny",
        reason: "internal_component_paid_denied",
        message: `Component '${component}' may not use the paid model '${model}' without an explicit approval.`,
      };
    }
  }

  // R5 - economical within budget
  if (tier === "economical") {
    const meta = modelById(model);
    // A "high-cost economical" model (measured expensive on real billing, e.g.
    // deepseek-v4-pro at ~$7 of a $11 month) is cheap enough not to be premium
    // but too costly to run unreviewed. It follows the same approval rule.
    if (meta?.highCost) {
      const apprH = (st.approvals || []).find((a) => a.id === req.approvalId);
      if (isApprovalValid(st, apprH, model)) {
        return {
          ...base,
          decision: "allow",
          reason: "high_cost_approved",
          approvalId: apprH.id,
          message: `High-cost economical model '${model}' approved.`,
        };
      }
      return {
        ...base,
        decision: "approval_required",
        reason: "high_cost_needs_approval",
        message: `Model '${model}' is in the economical tier but is measured as high-cost; it needs explicit approval.`,
        estimate: estimateTaskCost(state, model),
      };
    }
    return {
      ...base,
      decision: "allow",
      reason: "economical_within_budget",
      message: `Economical model '${model}' allowed (used ${(b.usedPct * 100).toFixed(1)}% of budget).`,
    };
  }

  // R6 - premium requires approval
  const appr = (st.approvals || []).find((a) => a.id === req.approvalId);
  if (isApprovalValid(st, appr, model)) {
    return {
      ...base,
      decision: "allow",
      reason: "premium_approved",
      approvalId: appr.id,
      message: `Premium model '${model}' approved for this task.`,
    };
  }
  return {
    ...base,
    decision: "approval_required",
    reason: "premium_needs_approval",
    message: `Premium model '${model}' requires explicit user approval before it is called.`,
    estimate: estimateTaskCost(state, model),
  };
}

/**
 * Approximate cost of one task on a model, using the live price map.
 * `turns` defaults to a conservative 25 model calls per task.
 */
export function estimateTaskCost(state, modelId, opts = {}) {
  const turns = opts.turns ?? 25;
  const inTok = opts.inTokPerTurn ?? 12000;
  const outTok = opts.outTokPerTurn ?? 1200;
  const p = priceSummary(modelId);
  if (!p || !p.found) {
    return { model: modelId, turns, estimateUsd: null, note: "price unknown — treat as unbounded" };
  }
  const inCost = ((p.inputPerM ?? 0) / 1e6) * inTok * turns;
  const outCost = ((p.outputPerM ?? 0) / 1e6) * outTok * turns;
  return {
    model: modelId,
    turns,
    inTokPerTurn: inTok,
    outTokPerTurn: outTok,
    estimateUsd: inCost + outCost,
    worstCaseUsd: inCost * 3 + outCost * 2,
  };
}

export function remainingPaidUsd(state) {
  const b = budgetBreakdown(state);
  return Math.max(0, b.spendable - b.spent);
}

export function recordSpend(state, usd, meta = {}) {
  const st = { ...DEFAULT_STATE, ...state };
  st.spentUsd = Number(st.spentUsd || 0) + Number(usd || 0);
  const level = alertLevel(st);
  const fired = new Set(st.alertsFired || []);
  if (level != null && !fired.has(level)) {
    fired.add(level);
    st.alertsFired = [...fired];
    st.lastAlert = { threshold: level, at: new Date().toISOString(), ...meta };
    if (level >= 0.9) st.hardStopPaid = true;
  }
  return st;
}
