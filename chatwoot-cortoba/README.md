# Chatwoot × Cortoba — agent console

The supplier conversation console for Cortoba Supplies. Chatwoot Community
Edition runs **inside this repository**, wired to the WhatsApp gateway that
already lives in `artifacts/api-server`.

```
WhatsApp (Meta) ──► api-server  /webhook/whatsapp  ──► Chatwoot (this stack)
                        │                                  │
                        └── mirror inbound/outbound ───────┘
                            (bridge.ts, REST API)
```

## Edition: Community (CE)

The image is **`chatwoot/chatwoot:v4.19.1-ce`** — the Community build. Upstream
publishes two tags per release: `vX.Y.Z` (which ships the `enterprise/` tree) and
`vX.Y.Z-ce` (which strips it). Verified in the images rather than assumed:

```
chatwoot/chatwoot:v4.19.1     -> enterprise/ PRESENT
chatwoot/chatwoot:v4.19.1-ce  -> enterprise/ ABSENT (stripped CE build)
```

`-ce` is the tag to keep: the licence-gated features are not ours to run, and the
whole stack (110 tables, health 200, the overlay selftest's 8 checks) was verified
on the CE image. Bumping Chatwoot means changing this tag and the vendored commit
in `../chatwoot/UPSTREAM.md` together.

## What is where

| Path | What it is | Edited by us? |
| --- | --- | --- |
| `../chatwoot/` | Upstream Chatwoot v4.19.1, vendored byte-for-byte. See `../chatwoot/UPSTREAM.md` for the exact commit. | **No** |
| `chatwoot-cortoba/` | Our overlay: console configuration + the historical importer. | Yes |
| `../artifacts/api-server/src/modules/chatwoot/` | The bridge: files each supplier reply under the pricing request it answers. | Yes |

The upstream tree is **never edited**. Everything we add is in this directory, so
bumping Chatwoot is a change of one tag in the `Dockerfile` and one line in
`../chatwoot/UPSTREAM.md`.

## Running it

```bash
cd chatwoot-cortoba
cp .env.example .env          # then set POSTGRES_PASSWORD and SECRET_KEY_BASE
docker compose up -d          # this is the WHOLE install
docker compose exec web bundle exec rails cortoba:selftest      # verifies the overlay
```

`docker compose up -d` is the whole install. A one-shot **`migrate`** service
prepares the schema, web and worker wait for it to exit successfully, and it
**verifies its own work** — it asks the database for its table count and exits
non-zero if the schema is not really there:

```
[migrate] preparing the Chatwoot schema
[migrate] tables present: 110
[migrate] schema ready
```

All three roles run the **same** `bin/entrypoint.sh` that Render calls, so a
local install and a deploy execute identical commands and cannot drift:

```bash
sh bin/entrypoint.sh migrate   # schema + verification, then exit
sh bin/entrypoint.sh web       # Puma — the ONE migrator
sh bin/entrypoint.sh worker    # Sidekiq — WAITS for the schema, never migrates
```

**Exactly one process migrates.** Two processes preparing a *fresh* database at
the same time race, and the loser dies mid-way through `schema.rb`:

```
PG::DuplicateObject: constraint "fk_rails_c3b3935057" for relation
  "active_storage_attachments" already exists
```

Reproduced against a clean pgvector database by starting web and worker together.
So `web` migrates and `worker` polls until the table count is real before it
starts. On compose the one-shot `migrate` service plays that role instead.

This replaced a two-command install (`up -d --build` then
`exec web rails db:chatwoot_prepare`) that was **broken as documented**: web and
worker booted before the schema existed and crash-looped on
`relation "installation_configs" does not exist` until the second command was
run by hand. If `migrate` fails on a half-prepared volume, start over cleanly:

```bash
docker compose down -v && docker compose up -d
```

Open <http://localhost:3000> and create the first account in the browser. The
overlay's conversation attributes (`cortoba_rfq_no`, `cortoba_owner_name`) are
provisioned **automatically when that account is created** — an account-creation
hook does it, so there is nothing to run afterwards.

`cortoba:attributes` exists for the case where the hook was missed (e.g. an
account created while the overlay was not loaded). It refuses to run when no
account exists yet rather than reporting success for doing nothing:

```bash
docker compose exec web bundle exec rails cortoba:attributes   # idempotent
```

| Service | Role |
| --- | --- |
| `migrate` | One-shot schema preparation + verification, then exits |
| `web` | Rails — the console UI and REST API |
| `worker` | Sidekiq — background jobs |
| `postgres` | **pgvector/pgvector:pg16** — Chatwoot needs the `vector` extension |
| `redis` | Cache + Sidekiq queue |

### Two configuration traps, both measured

1. **`SECRET_KEY_BASE` is mandatory in production.** Without it Rails aborts at
   boot with `Missing secret_key_base for 'production' environment`. Generate
   one with `openssl rand -hex 64`.
2. **Plain `postgres` does not work.** `db:chatwoot_prepare` fails with
   `extension "vector" is not available`; Chatwoot's own compose file uses
   `pgvector/pgvector:pg16`, and so do we.

### Why `db:chatwoot_prepare` is never trusted on its own

It **exits 0 even when it creates nothing.** On a database it considers
half-prepared it short-circuits without applying the schema, so a bare
`... && echo ok` reports a successful install for a database the app cannot boot
against. That is why the `migrate` service reads the table count back from the
database and fails closed when it cannot parse one. It is the same rule the rest
of this repository applies: a capability must be judged by its outcome, not by
its exit code.

## Database isolation

Chatwoot gets its **own** PostgreSQL container and volume. It never receives
Cortoba's `DATABASE_URL` and never reads Cortoba's tables. Cortoba stays the
source of truth for suppliers, pricing requests, purchase orders and employees;
Chatwoot owns conversations, messages and attachments. The two are joined by the
bridge's REST calls, not by a shared schema.

## What the overlay does

### 1. Conversation custom attributes (`lib/cortoba/custom_attributes.rb`)

Declares two conversation attributes so the console shows which pricing request a
thread belongs to and which employee owns it — without them a supplier thread has
no owner, which is the problem this integration exists to solve.

Idempotent by construction (find-or-create on the same triple Chatwoot indexes
uniquely) and it **never overwrites** an existing definition, so a label an
operator renamed in the UI survives every deploy.

### 2. Historical import (`lib/cortoba/importer.rb`)

Imports past WhatsApp threads with their **original timestamps and message ids**.

**Why this is inside Chatwoot and not a REST call from Cortoba.** The REST API
stamps `created_at` itself and cannot set a message id or choose a storage key,
so a faithful historical import is impossible from outside. Writing through
Chatwoot's own models is the only way, and it is the one thing this overlay does
that Cortoba cannot.

```bash
# dry run (the default) — reports what would happen, writes nothing
docker compose exec -T web bundle exec rails cortoba:import_file[/tmp/thread.json]
# real import
docker compose exec -T -e FORCE=1 web bundle exec rails cortoba:import_file[/tmp/thread.json]
```

Properties, each verified against the running stack:

| Property | Verified |
| --- | --- |
| Dry run writes nothing | dry run reported `+1 conversation, +3 messages`, contacts stayed `0` |
| Original timestamps preserved | imported rows kept `09:15:00`, `09:20:00`, `11:00:00` |
| Idempotent | three imports of the same file → `1 contact / 1 conversation / 3 messages` |
| Attachments imported | 209-byte PDF stored with `file_type=3`, `byte_size=209` |
| Attachment idempotent | re-import → `attachments: +0`, count stayed `1` |
| Ownership recorded | `custom_attributes` = `{cortoba_rfq_no, cortoba_owner_name}` |
| Non-destructive | inserts only into Chatwoot's own tables; never deletes |

**Message identity uses `messages.source_id`.** Not `external_source_ids`:
`Message` declares `store :external_source_ids, coder: JSON`, which serialises an
assigned Hash into a JSON *string* in the jsonb column, so a `->> 'key'` lookup
never matches and a re-import silently duplicates every message. `source_id` is
the indexed text column Chatwoot's own WhatsApp integration uses for the inbound
message id.

## What the overlay deliberately does NOT do

**The business rules are not re-implemented here.** Which pricing request a reply
answers, which employee owns a request, and when to ask a supplier to choose are
decided in **one** place: `artifacts/api-server/src/modules/chatwoot/bridge.ts`,
where the WhatsApp gateway is. A second copy of those rules inside this Ruby
overlay would be the "two copies of one truth" defect this repository has paid
for repeatedly.

The overlay only does what can **only** be done inside Chatwoot: console
configuration and a faithful historical import.

## Verifying a deployment

```bash
docker compose ps                                   # all four services healthy
curl -fsS localhost:3000/health                     # {"status":"woot"}
docker compose exec web bundle exec rails cortoba:selftest
```

`cortoba:selftest` checks phone canonicalisation (six spellings of one number
must resolve to one value — otherwise a returning supplier is imported twice) and
that the attribute keys resolve.

## Operational notes

- **`ENABLE_ACCOUNT_SIGNUP=false`.** Employees sign in to Cortoba; they never get
  a Chatwoot password. Agents are provisioned from Cortoba's employee list.
- **`DEFAULT_LOCALE=ar`** — the console opens in Arabic, matching the portal.
- **`FORCE_SSL=false`** is correct for a local stack. Set it to `true` behind TLS
  in production, or the session cookie will not be marked secure.
- The worker restarts until the database is prepared. That is expected on a first
  run, not a fault.

## Deploying on Render

`render.yaml` in this directory is a complete Blueprint. It creates **four new
resources** and touches nothing that already exists — in particular the
`cortoba-rfq` service and `cortoba-rfq-db` are never referenced, because Chatwoot
gets its **own** database. Chatwoot writing into the operational schema would be
unacceptable, and so would a migration of ours running against Chatwoot's.

| Resource | Type | Plan | Why |
| --- | --- | --- | --- |
| `cortoba-chatwoot` | Web (Docker) | starter | Puma — console UI + REST API |
| `cortoba-chatwoot-worker` | Worker (Docker) | starter | Sidekiq — webhooks, imports, jobs |
| `cortoba-chatwoot-redis` | Key Value | starter | Sidekiq queue; persistence on |
| `cortoba-chatwoot-db` | Postgres 16 | basic-256mb | Chatwoot's own data |

**`pgvector` is the requirement that decides whether this works at all.**
Upstream `db/schema.rb` runs `enable_extension "vector"`, so a Postgres without
the extension fails at `db:chatwoot_prepare` with `extension "vector" is not
available`. Render's managed Postgres ships it — verified against the live
instance, not assumed:

```sql
SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector';
--  vector | 0.8.7
```

### Deploy steps

1. Render dashboard → **New** → **Blueprint** → pick this repository. Render
   reads `chatwoot-cortoba/render.yaml`.
2. It prompts for the `sync: false` values. Generate the two secrets first:

   ```bash
   openssl rand -hex 64     # → SECRET_KEY_BASE
   openssl rand -hex 24     # → the Postgres password, if you are prompted
   ```

   Set `FRONTEND_URL` to the URL Render gives `cortoba-chatwoot`
   (`https://cortoba-chatwoot.onrender.com`), and `CORTOBA_APP_URL` to
   `https://cortoba-rfq.onrender.com`.
3. Wait for the deploy. The **pre-deploy** step runs the migration and fails the
   deploy if the schema is not really there — a green deploy means the schema
   exists, not merely that a command exited 0.
4. Open the console, create the first account, then create an **API inbox**
   (Settings → Inboxes → Add → API). The overlay provisions the conversation
   attributes automatically when the account is created.
5. Copy that inbox's **API access token** and its **account id**, plus a
   **Platform App** token (Console → Profile → Access Tokens), and set the
   `CHATWOOT_*` variables on the **cortoba-rfq** service — the bridge is inert
   until they are present (`isChatwootConfigured` requires URL + account id +
   token):

   | Variable on `cortoba-rfq` | Value |
   | --- | --- |
   | `CHATWOOT_URL` | `https://cortoba-chatwoot.onrender.com` |
   | `CHATWOOT_ACCOUNT_ID` | the account id |
   | `CHATWOOT_API_TOKEN` | the API inbox token |
   | `CHATWOOT_INBOX_ID` | the API inbox id |
   | `CHATWOOT_PLATFORM_TOKEN` | the platform token (SSO + agent provisioning) |
   | `CHATWOOT_WEBHOOK_SECRET` | a shared secret for the agent-reply webhook |

   `CHATWOOT_URL` alone does not enable anything: without an account id and a
   token the bridge returns early, so Cortoba behaves exactly as it does today.

### Two things to decide before relying on it

- **Attachments and local disk.** `ACTIVE_STORAGE_SERVICE=local` puts uploads on
  the instance disk. A restart keeps them; a re-deploy may not. Moving to S3
  (or a Render disk) is the durable option — do that before suppliers start
  sending PDFs you intend to keep.
- **Meta stays pointed at Cortoba.** Chatwoot is wired on an **API inbox**. Do
  **not** add a WhatsApp channel to it: the Meta webhook is the single gateway
  that drives RFQ sending, PO dispatch and the representative bot, and pointing
  it at Chatwoot stops all three. `cortoba-chatwoot` must never appear in Meta's
  webhook configuration.
