// Tests for the cost-governance policy, router, and ledger.
// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRequest,
  budgetBreakdown,
  recordSpend,
  DEFAULT_STATE,
  INTERNAL_COMPONENTS,
} from "../src/policy.mjs";
import {
  classify,
  planForTask,
  composeChain,
  simulateFallback,
  nextAction,
  classifyFailure,
  FAILURE_KINDS,
  RETRY_BUDGET,
} from "../src/router.mjs";
import { tierOf, isPaidModel, CATALOG } from "../src/models.mjs";
import { costOfUsage, summarize, windowTotals } from "../src/ledger.mjs";
import { priceSummary } from "../src/prices.mjs";

const fresh = () => ({ ...DEFAULT_STATE, alertsFired: [], approvals: [] });

// ---------------------------------------------------------------- Test 1
test("T1 simple task routes to a FREE model", () => {
  const r = classify("read the file and summarise what it does");
  assert.equal(r.class, "simple");
  assert.equal(r.tier, "free");
  const plan = planForTask("read the file and summarise what it does");
  assert.equal(plan.tier, "free");
  assert.ok(
    plan.chain.every((c) => c.tier === "free"),
    "every candidate must be free",
  );
  assert.equal(plan.requiresApproval, false);
  const d = evaluateRequest(fresh(), { model: plan.chain[0].model });
  assert.equal(d.decision, "allow");
  assert.equal(d.reason, "free_tier");
});

// ---------------------------------------------------------------- Test 2
test("T2 medium programming task routes to an ECONOMICAL model", () => {
  const task = "develop a new feature: add an API endpoint and the business logic behind it";
  const r = classify(task);
  assert.equal(r.tier, "economical");
  const plan = planForTask(task);
  assert.ok(plan.chain.some((c) => c.tier === "economical"));
  assert.ok(!plan.chain.some((c) => c.tier === "premium"), "no premium in a medium chain");
  const d = evaluateRequest(fresh(), { model: "openhands/deepseek-v4.1-flash" });
  assert.equal(d.decision, "allow");
  assert.equal(d.reason, "economical_within_budget");
});

// ---------------------------------------------------------------- Test 3
test("T3 a rate-limited free model falls back to ANOTHER FREE model", () => {
  const sim = simulateFallback("read the file", [FAILURE_KINDS.RATE_LIMIT]);
  assert.equal(sim.status, "success");
  assert.notEqual(sim.model, "groq/openai/gpt-oss-120b");
  assert.equal(tierOf(sim.model), "free", "the replacement must itself be free");
});

// ---------------------------------------------------------------- Test 4
test("T4 all free models failing STOPS the task — never a paid escalation", () => {
  const sim = simulateFallback("read the file", [
    FAILURE_KINDS.RATE_LIMIT,
    FAILURE_KINDS.RATE_LIMIT,
    FAILURE_KINDS.RATE_LIMIT,
    FAILURE_KINDS.RATE_LIMIT,
    FAILURE_KINDS.RATE_LIMIT,
  ]);
  assert.equal(sim.status, "stopped");
  assert.ok(sim.tried.length > 0, "it reports which models were tried");
  assert.ok(
    sim.tried.every((m) => tierOf(m) === "free"),
    "only free models were tried",
  );
  assert.ok(!sim.tried.some((m) => isPaidModel(m)), "no paid model was ever reached");
});

// ---------------------------------------------------------------- Test 5
test("T5 a premium model requires explicit approval", () => {
  const d = evaluateRequest(fresh(), { model: "anthropic/claude-opus-5-5" });
  assert.equal(d.decision, "approval_required");
  assert.equal(d.reason, "premium_needs_approval");
  assert.ok(d.estimate, "an approval request must carry a cost estimate");

  // With a valid approval the same request is allowed.
  const state = {
    ...fresh(),
    approvals: [
      {
        id: "a1",
        model: "anthropic/claude-opus-5-5",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    ],
  };
  const d2 = evaluateRequest(state, { model: "anthropic/claude-opus-5-5", approvalId: "a1" });
  assert.equal(d2.decision, "allow");
  assert.equal(d2.reason, "premium_approved");

  // An expired approval is not an approval.
  const expired = {
    ...fresh(),
    approvals: [
      {
        id: "a2",
        model: "anthropic/claude-opus-5-5",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    ],
  };
  assert.equal(
    evaluateRequest(expired, { model: "anthropic/claude-opus-5-5", approvalId: "a2" }).decision,
    "approval_required",
  );

  // An approval for a different model does not transfer.
  const other = { ...fresh(), approvals: [{ id: "a3", model: "anthropic/claude-sonnet-5" }] };
  assert.equal(
    evaluateRequest(other, { model: "anthropic/claude-opus-5-5", approvalId: "a3" }).decision,
    "approval_required",
  );
});

// ---------------------------------------------------------------- Test 9
// The operator writes Arabic. An English-only classifier leaves every task at
// the default tier, so the routing exists but never fires — measured: 7/7
// Arabic tasks classified "medium" with zero signal hits.
test("T9 Arabic tasks classify correctly (routing must fire for its operator)", () => {
  const simple = [
    "اقرأ الملف ولخصه",
    "ابحث في المشروع عن الدالة دي",
    "اشرح الكود ده",
    "لخص محتوى الملف",
    "ضيف كومنت على الدالة",
  ];
  for (const t of simple) {
    const r = classify(t);
    assert.equal(r.class, "simple", `"${t}" must be simple, got ${r.class}`);
    assert.equal(r.tier, "free", `"${t}" must route to a free model`);
  }

  const complex = [
    "أعد هيكلة نظام المصادقة كامل",
    "حلل مشكلة الإنتاج دي",
    "المشكلة معقدة ومحتاجة تحليل عميق",
    "أصلح الخطأ المعقد في قاعدة البيانات",
    "فيه تسريب ذاكرة في السيرفر",
  ];
  for (const t of complex) {
    const r = classify(t);
    assert.equal(r.class, "complex", `"${t}" must be complex, got ${r.class}`);
    assert.equal(r.tier, "premium", `"${t}" must require premium approval`);
  }

  // A plain feature request stays medium — the Arabic signals must not over-fire.
  for (const t of ["أضف ميزة جديدة لتسجيل العملاء", "اكتب endpoint جديد للطلبات"]) {
    assert.equal(classify(t).class, "medium", `"${t}" must stay medium`);
  }
});

test("T10 an Arabic simple task reaches the free chain end to end", () => {
  const plan = planForTask("اقرأ الملف ده واشرحه");
  assert.equal(plan.tier, "free");
  assert.ok(
    plan.chain.every((c) => c.tier === "free"),
    "an Arabic simple task must be offered free models only",
  );
  assert.equal(plan.requiresApproval, false);
});

test("T11 Arabic folding tolerates spelling variants", () => {
  // hamza/alef, taa-marbuta and yaa variants must fold to the same signal.
  assert.equal(classify("أعد هيكلة النظام").class, "complex");
  assert.equal(classify("اعد هيكله النظام").class, "complex");
  assert.equal(classify("اشرح الكود").class, "simple");
  assert.equal(classify("إشرح الكود").class, "simple");
});

// ---------------------------------------------------------------- Test 12
test("T12 no automatic chain can reach a PREMIUM model, and the plan says so honestly", () => {
  for (const task of [
    "اقرأ الملف ولخصه", // simple
    "أضف ميزة جديدة لتسجيل العملاء", // medium
    "أعد هيكلة نظام المصادقة كامل", // complex
  ]) {
    const plan = planForTask(task);
    assert.ok(
      !plan.chain.some((c) => c.tier === "premium"),
      `"${task}" must never offer a premium model without approval`,
    );
    // The note must not claim a paid model is unreachable when the chain
    // actually contains a paid (economical) model — that would be false.
    const hasPaid = plan.chain.some((c) => c.tier === "economical");
    if (hasPaid) {
      assert.ok(
        !/paid escalation is never automatic/i.test(plan.note),
        `"${task}" has a paid candidate, so the note must not deny paid escalation`,
      );
      assert.match(plan.note, /premium/i, "the note must name what is actually blocked");
    }
  }
  // A simple task's chain is free-only, so its note may claim paid is unreachable.
  const simplePlan = planForTask("اقرأ الملف");
  assert.ok(simplePlan.chain.every((c) => c.tier === "free"));
  assert.match(simplePlan.note, /free/i);
});

// ---------------------------------------------------------------- Test 6
test("T6 planner, condenser and sub-agents cannot bypass the budget policy", () => {
  for (const component of INTERNAL_COMPONENTS) {
    // Any PAID model (premium or economical) is denied without an approval.
    const premium = evaluateRequest(fresh(), { model: "anthropic/claude-opus-5-5", component });
    assert.equal(premium.decision, "deny", `${component} must be denied a premium model`);
    assert.equal(premium.reason, "internal_component_paid_denied");

    const econ = evaluateRequest(fresh(), { model: "openhands/deepseek-v4.1-flash", component });
    assert.equal(econ.decision, "deny", `${component} must be denied a paid economical model too`);
    assert.equal(econ.reason, "internal_component_paid_denied");

    // Free is always fine, including for internal components.
    assert.equal(
      evaluateRequest(fresh(), { model: "groq/openai/gpt-oss-120b", component }).decision,
      "allow",
    );

    // With an explicit approval the paid model is allowed — the same approval
    // policy applies everywhere.
    const state = {
      ...fresh(),
      approvals: [
        {
          id: "ok",
          model: "openhands/deepseek-v4.1-flash",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    };
    assert.equal(
      evaluateRequest(state, {
        model: "openhands/deepseek-v4.1-flash",
        component,
        approvalId: "ok",
      }).decision,
      "allow",
    );
  }
});

// ---------------------------------------------------------------- Test 7
test("T7 prompt caching is declared and priced where the provider supports it", () => {
  // Every paid model we ship must have a known cache-read price, otherwise the
  // monitor would silently over-count cost.
  const cacheAware = CATALOG.filter((m) => m.tier !== "free" || m.provider === "gemini");
  for (const m of cacheAware) {
    const p = priceSummary(m.id);
    if (!p.found) continue;
    assert.ok(p.inputPerM != null, `${m.id} must have an input price`);
  }
  // A cached read must be billed below a fresh input token for models that
  // publish a cache-read rate.
  for (const id of ["openhands/deepseek-v4.1-flash", "deepseek/deepseek-chat"]) {
    const p = priceSummary(id);
    if (p.cacheReadPerM != null)
      assert.ok(p.cacheReadPerM <= p.inputPerM, `${id} cache read must not cost more than input`);
  }
});

// ---------------------------------------------------------------- Test 8
test("T8 no infinite retry and no fallback loop", () => {
  // The retry budget is finite and small.
  assert.ok(RETRY_BUDGET.maxTotalAttempts <= 10);
  assert.ok(RETRY_BUDGET.maxFallbackDepth <= 6);
  // A chain longer than the depth is truncated.
  const plan = planForTask("medium feature work");
  assert.ok(plan.chain.length <= RETRY_BUDGET.maxFallbackDepth);

  // Every failure kind either advances or stops — never "retry forever".
  for (const kind of Object.values(FAILURE_KINDS)) {
    const action = nextAction(kind, 0, plan);
    assert.ok(["try_next", "stop"].includes(action));
  }
  // At the end of the chain the only possible action is "stop".
  for (const kind of Object.values(FAILURE_KINDS)) {
    assert.equal(nextAction(kind, plan.chain.length - 1, plan), "stop");
  }
  // A run where every model fails terminates.
  const sim = simulateFallback("medium feature work", Object.values(FAILURE_KINDS).slice(0, 8));
  assert.equal(sim.status, "stopped");
});

test("a medium chain always contains an economical model (regression)", () => {
  // Truncating [free..., economical...] to the fallback depth once dropped every
  // economical model, so a medium task could never run. Guard the composition.
  const chain = composeChain("economical", RETRY_BUDGET.maxFallbackDepth);
  assert.ok(chain.length <= RETRY_BUDGET.maxFallbackDepth);
  assert.ok(
    chain.some((c) => c.tier === "economical"),
    "medium task must reach an economical model",
  );
  assert.ok(
    chain.every((c) => c.tier !== "premium"),
    "medium task must never include premium",
  );
  assert.equal(chain[0].tier, "free", "free models are still tried first");

  const freeChain = composeChain("free", RETRY_BUDGET.maxFallbackDepth);
  assert.ok(freeChain.every((c) => c.tier === "free"));
});

test("a high-cost economical model needs approval, and is never auto-routed to", () => {
  // deepseek-v4-pro is measured as the single biggest cost line in this
  // workspace ($7.18 of $10.92). It is not premium, but it must not run
  // unreviewed.
  const d = evaluateRequest(fresh(), { model: "deepseek/deepseek-v4-pro" });
  assert.equal(d.decision, "approval_required");
  assert.equal(d.reason, "high_cost_needs_approval");

  const state = {
    ...fresh(),
    approvals: [
      {
        id: "h1",
        model: "deepseek/deepseek-v4-pro",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
  };
  assert.equal(
    evaluateRequest(state, { model: "deepseek/deepseek-v4-pro", approvalId: "h1" }).decision,
    "allow",
  );

  // Automatic routing must never propose it.
  for (const task of [
    "read a file",
    "develop a feature",
    "analyse the architecture and refactor",
  ]) {
    const plan = planForTask(task);
    assert.ok(
      !plan.chain.some((c) => c.model === "deepseek/deepseek-v4-pro"),
      `${task}: must not auto-route to the high-cost model`,
    );
  }
});

// ---------------------------------------------------------------- budget rules
test("deny-by-default for unknown models", () => {
  const d = evaluateRequest(fresh(), { model: "totally/made-up-model" });
  assert.equal(d.decision, "deny");
  assert.equal(d.reason, "unknown_model");
});

test("the 90% threshold hard-stops paid spend but keeps free models", () => {
  const state = { ...fresh(), spentUsd: 4.5 }; // 90% of $5
  const paid = evaluateRequest(state, { model: "openhands/deepseek-v4.1-flash" });
  assert.equal(paid.decision, "deny");
  assert.equal(paid.reason, "budget_90pct_hard_stop");
  const free = evaluateRequest(state, { model: "groq/openai/gpt-oss-120b" });
  assert.equal(free.decision, "allow");
});

test("the 10% reserve is protected from normal spending", () => {
  // Raise the hard-stop threshold so this test isolates the reserve rule.
  const state = { ...fresh(), spentUsd: 4.6, alertThresholds: [0.99] }; // beyond spendable (4.5), below 99%
  const d = evaluateRequest(state, { model: "openhands/deepseek-v4.1-flash" });
  assert.equal(d.decision, "deny");
  assert.equal(d.reason, "reserve_locked");
});

test("alerts fire at 50%, 75% and 90% and 90% sets the hard stop", () => {
  let s = fresh();
  s = recordSpend(s, 2.5); // 50%
  assert.ok(s.alertsFired.includes(0.5));
  assert.equal(s.hardStopPaid, false);
  s = recordSpend(s, 1.25); // 75%
  assert.ok(s.alertsFired.includes(0.75));
  assert.equal(s.hardStopPaid, false);
  s = recordSpend(s, 0.75); // 90%
  assert.ok(s.alertsFired.includes(0.9));
  assert.equal(s.hardStopPaid, true);
});

test("budget breakdown splits the $5 target 70/20/10", () => {
  const b = budgetBreakdown(fresh());
  assert.equal(b.target, 5);
  assert.equal(Number(b.essential.toFixed(2)), 3.5);
  assert.equal(Number(b.complex.toFixed(2)), 1.0);
  assert.equal(Number(b.reserve.toFixed(2)), 0.5);
  assert.equal(b.spendable, 4.5);
});

// ---------------------------------------------------------------- failures
test("failure classification distinguishes the documented causes", () => {
  assert.equal(classifyFailure({ status: 429 }), FAILURE_KINDS.RATE_LIMIT);
  assert.equal(classifyFailure({ status: 503 }), FAILURE_KINDS.SERVER_ERROR);
  assert.equal(classifyFailure(new Error("request timed out")), FAILURE_KINDS.TIMEOUT);
  assert.equal(classifyFailure({ status: 401 }), FAILURE_KINDS.INVALID_KEY);
  assert.equal(
    classifyFailure({ status: 404, message: "model not found" }),
    FAILURE_KINDS.MODEL_UNAVAILABLE,
  );
  assert.equal(
    classifyFailure(new Error("maximum context length exceeded")),
    FAILURE_KINDS.CONTEXT_LENGTH,
  );
  assert.equal(
    classifyFailure(new Error("tool calling unsupported")),
    FAILURE_KINDS.NO_TOOL_CALLING,
  );
  assert.equal(classifyFailure(new Error("ECONNREFUSED")), FAILURE_KINDS.CONNECTION);
});

// ---------------------------------------------------------------- ledger
test("cost accounting bills cached tokens at the cache rate", () => {
  const usage = {
    prompt_tokens: 100000,
    completion_tokens: 1000,
    cache_read_tokens: 50000,
    cache_write_tokens: 0,
  };
  const c = costOfUsage("openhands/deepseek-v4.1-flash", usage);
  assert.equal(c.priced, true);
  const p = priceSummary("openhands/deepseek-v4.1-flash");
  const expected =
    (50000 * p.inputPerM) / 1e6 + (50000 * p.cacheReadPerM) / 1e6 + (1000 * p.outputPerM) / 1e6;
  assert.ok(Math.abs(c.usd - expected) < 1e-9, `expected ${expected}, got ${c.usd}`);
});

test("a free-tier model is billed 0 but its LIST price is still recorded", () => {
  const rows = [
    {
      model: "groq/openai/gpt-oss-120b",
      prompt_tokens: 1000,
      completion_tokens: 100,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
    {
      model: "openhands/deepseek-v4.1-flash",
      prompt_tokens: 100000,
      completion_tokens: 2000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  ];
  const s = summarize(rows);
  assert.equal(s.byTier.free, 1);
  assert.equal(s.byTier.economical, 1);
  // Effective cost is zero for the free tier...
  assert.equal(s.byModel["groq/openai/gpt-oss-120b"].usd, 0);
  // ...but its list price is non-zero, so the monitor never claims "free
  // forever" without evidence.
  assert.ok(s.byModel["groq/openai/gpt-oss-120b"].listUsd > 0);
  assert.ok(s.byModel["openhands/deepseek-v4.1-flash"].usd > 0);
  assert.ok(s.totals.listUsd > s.totals.usd);
});

test("windowTotals separates free from paid calls", () => {
  const now = new Date().toISOString();
  const rows = [
    { ts: now, tier: "free", usd: 0 },
    { ts: now, tier: "economical", usd: 0.01 },
    { ts: now, tier: "premium", usd: 0.5 },
  ];
  const w = windowTotals(rows);
  assert.equal(w.freeCalls, 1);
  assert.equal(w.paidCalls, 2);
  assert.ok(Math.abs(w.allTime - 0.51) < 1e-9);
});
