# DEPRECATED — الحسابات القديمة (home-grown ledger)

**Do not delete this module yet.** It is kept mounted until Odoo is verified
working in production (see the acceptance criteria of the accounts-bridge work).

## Status

- **Replaced by**: `artifacts/api-server/src/modules/accounts-bridge/` — the
  RFQ-to-Odoo bridge. Odoo Community is now the accounting engine.
- **UI**: the accounts screens were rebuilt under
  `artifacts/rfq-portal/src/modules/accounts/` and read from the bridge (Odoo),
  not from this ledger.
- **Why it is still here**: decision #5 — do not delete the existing accounts
  API until Odoo is verified working. Deleting it now would remove the only
  working accounting read path if the bridge has to be rolled back.

## Rules while deprecated

- Do **not** add new features here.
- Do **not** wire new UI to these routes.
- The bridge is mounted **before** this module in `routes/index.ts`, so any path
  it claims (`/accounts/sync-status`, `/accounts/odoo/*`, `/accounts/bridge/*`)
  is served by the bridge.
- When Odoo is verified, remove this directory and its mount in
  `routes/index.ts` in a single follow-up change.

## Routes still served here

`/accounts/margins`, `/accounts/margins/summary`, `/accounts/vat`,
`/accounts/withholding`, `/accounts/tax-settings`, `/accounts/journal*`,
`/accounts/coa*`, `/accounts/trial-balance`, `/accounts/income-statement`,
`/accounts/balance-sheet`, `/accounts/ledger/:code`, `/accounts/dashboard`,
`/accounts/aging/*`, `/accounts/supplier-invoices*`, `/accounts/sales-invoices*`,
`/accounts/supplier-payments`, `/accounts/collected-orders`, `/accounts/po-charges`,
`/accounts/monthly-closing*`.
