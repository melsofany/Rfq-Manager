# OpenHands Cost Governor

Deny-by-default cost governance for OpenHands Cloud: tiered model routing,
explicit approval for paid models, authoritative spend monitoring, and a safe
rollback.

## Security notice (read first)

The original task message contained what appears to be an **Anthropic API key**
(the string starting `sk-ant-usr-...`). This toolchain **did not** echo, store,
log, or transmit it. The key was also used as the _title_ of an OpenHands
conversation, so it is visible in the conversation list — see "Exposed
credential" in the final report. **Rotate that key in the Anthropic Console.**

## What it does

| Concern                        | Mechanism                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| Task → model routing           | `router.mjs` classifies a task into simple / medium / complex and builds a candidate chain |
| Paid-spend blocking            | `policy.mjs` evaluates every model call: deny by default, approve for paid                 |
| Hard server-side cap           | `max_budget_per_task` on the OpenHands org (both org endpoints)                            |
| Native in-conversation routing | OpenHands meta-profile `cost-router` (classifier → profile)                                |
| Spend monitoring               | `cloud-usage.mjs` reads authoritative billing from the org API                             |
| Local attribution              | `ledger.mjs` parses conversation event logs for tokens and cost                            |
| Enforcement hook               | `guard.mjs` — exit 0 allow / 2 deny, wrap any launcher                                     |

## Tiers

- **free** — zero marginal cost within the provider's quota.
- **economical** — paid but cheap; the default for real work.
- **premium** — expensive; requires explicit, expiring, one-shot approval.

A fourth flag, **high-cost economical**, marks a model that is _cheap-tier but
measured expensive_ (e.g. `deepseek/deepseek-v4-pro`, ~66% of this workspace's
spend). It follows the premium approval rule and is never auto-routed to.

## Commands

```bash
node src/cli.mjs tiers                 # list models by tier
node src/cli.mjs route "<task>"        # classify + build the candidate chain
node src/cli.mjs cloud                 # authoritative cloud spend + alerts
node src/cli.mjs alerts                # budget alerts + local ledger totals
node src/cli.mjs report                # local token/cost report from events
node src/cli.mjs evaluate <model> [component]
node src/cli.mjs estimate <model>
node src/cli.mjs simulate "<task>" "<failure,failure>"
node src/cli.mjs spend <usd>           # record spend, fire thresholds

node src/guard.mjs --task "<task>"                    # recommend only
node src/guard.mjs --model <id>                       # exit 0 allow / 2 deny
node src/guard.mjs --approve --model <id> --ttl-min 30
node src/guard.mjs --list-approvals
node src/guard.mjs --revoke <approval-id>

node src/apply-cloud.mjs '{"max_budget_per_task":1.0}'
node src/rollback.mjs --dry-run
```

## Budget policy

Target **$5**. Split 70 / 20 / 10:

- 70% ($3.50) essential programming work
- 20% ($1.00) complex work
- 10% ($0.50) reserve — **locked** from normal spending

Alert thresholds: 50% (info), 75% (warn), 90% (**hard stop** on paid; free
models keep working). At ≥90% no new paid request is allowed without a fresh
explicit approval.

## Honest limitations

1. **The budget is internal, not a provider-enforced spend limit.** Anthropic
   has no API to set a hard credit ceiling. The real, server-enforced guard here
   is OpenHands' `max_budget_per_task` (per task, not per month) plus this
   policy layer. The monitor _detects_; only the policy + guard _prevent_.
2. **The local ledger only sees conversations whose event logs are on disk.**
   Cloud billing is the authoritative source.
3. **The OpenHands Cloud org meta-profile router is not enabled on this
   deployment**, so org-level automatic routing is unavailable. Routing is done
   by this toolchain (router + guard) and by the agent-server meta-profile.
4. **No background/automatic path calls a paid model** in this toolchain, and
   `deepseek-v4-pro` is excluded from automatic routing.

## Layout

```
src/prices.mjs      LiteLLM price map loader
src/models.mjs      curated catalog with tiers
src/policy.mjs      deny-by-default engine + budget accounting
src/router.mjs      task classification + bounded fallback chain
src/ledger.mjs      token/cost accounting from event logs
src/cloud-usage.mjs authoritative spend from the OpenHands API
src/guard.mjs       CLI enforcement hook
src/apply-cloud.mjs minimal, backed-up cloud settings patch
src/rollback.mjs    restore every change
test/policy.test.mjs  the 8 required system tests + guards
```
