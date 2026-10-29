# accounts-bridge

The RFQ app's only link to Odoo. Odoo is a Render **private service**; the
api-server reaches it over the internal network with JSON-RPC and the RFQ portal
reads everything through this module, never from Odoo directly.

## Configuration

All credentials come from the environment. Nothing is hardcoded.

| Variable       | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| `ODOO_URL`     | Base URL of the Odoo service, e.g. `http://odoo-cortoba:10000`. |
| `ODOO_DB`      | Odoo database name, e.g. `odoo_db_z2ym`.                        |
| `ODOO_USER`    | The dedicated service user's login, e.g. `rfq-bridge`.          |
| `ODOO_API_KEY` | That user's JSON-RPC password / API key.                        |

When any variable is missing the bridge reports itself as unconfigured; the
sync-status screen says so instead of failing silently.

## Event mapping

| RFQ event                | Odoo document                                |
| ------------------------ | -------------------------------------------- |
| Supplier goods receipt   | Vendor bill — net + 14% VAT − 3% withholding |
| Customer delivery        | Customer invoice + cost of goods sold        |
| Expense entry            | Journal entry                                |
| Customer payment         | Payment entry                                |
| Cancellation / rejection | Credit note                                  |

The 14% VAT and 3% withholding are posted as explicit lines, so the totals do
not depend on Odoo tax defaults.

## Idempotency

Each event has a stable key. The first attempt reserves a row in the local
store; the Odoo record id is written back once Odoo returns it. A retry sees the
stored id and returns early **without** calling Odoo, so a replayed event can
never create a second document. A failed attempt leaves the id NULL, so the
retry is allowed to try again.

## Endpoints

- `GET /accounts/sync-status` — bridge health plus the per-event sync log
  (including every failed sync and the reason).
