# Rfq-Manager — Repository Notes

## Overview
Cortoba Supplies RFQ (Request for Quotation) management system. Monorepo (pnpm workspaces).

## Structure
- `artifacts/api-server/` — Express + Drizzle ORM backend (esbuild bundle → `dist/index.mjs`)
- `artifacts/rfq-portal/` — React + Vite SPA frontend
- `lib/db/` — `@workspace/db` Drizzle schema + pool (requires `DATABASE_URL`)
- `lib/api-spec/openapi.yaml` — OpenAPI spec; clients regenerated via **orval**
- `lib/api-client-react/` — generated React Query client
- `lib/api-zod/` — generated zod schemas

## API routing
- API mounted at `/api` (app.ts: `app.use("/api", router)`). SPA fallback serves `index.html` for unmatched routes.
- PO routes live at `/api/po` and `/api/po/:id` (NOT `/api/purchase-orders` despite the comment in routes/index.ts).
- `/api/healthz` is the unauthenticated liveness probe (returns `{"status":"ok"}`).
- Most routes are behind `requireAuth` (session-based, checks `req.session.employeeId`). Unauthenticated → `401 {"error":"Unauthorized"}`.
- Routes use `req.log` (pino-http). Test apps must stub `req.log` and `req.session`.

## Code generation workflow
1. Edit `lib/api-spec/openapi.yaml`.
2. Run orval to regenerate `lib/api-client-react/src/generated/*` and `lib/api-zod/src/generated/*`.
3. Build libs: `tsc --build` (root).
- **orval pitfall (duplicate schema names)**: a duplicate `components/schemas` key in `openapi.yaml` is a YAML "duplicated mapping key" error. orval reports this only as `Failed to resolve input: Please provide a valid string value` — **after** it has already `Cleaning output folder`, which deletes the committed generated files. Validate the YAML first with `js-yaml` (`node_modules/.pnpm/js-yaml@*/node_modules/js-yaml`) before running orval. When adding a new sub-item schema, name it distinctly (e.g. `CustomerRfqLineItem`, not `CustomerRfqItem`) to avoid colliding with existing `*Item` schemas.

## Commands
- Typecheck all libs: `tsc --build` (from repo root)
- Typecheck api-server: `tsc -p artifacts/api-server/tsconfig.json --noEmit`
- Typecheck portal: `tsc -p artifacts/rfq-portal/tsconfig.json --noEmit`
- api-server tests: `cd artifacts/api-server && ./node_modules/.bin/vitest run`
- api-server build: `node artifacts/api-server/build.mjs` (prebuild skips db push if no DATABASE_URL)
- portal build: `cd artifacts/rfq-portal && ./node_modules/.bin/vite build --config vite.config.ts`

## Testing conventions
- Tests in `artifacts/api-server/src/__tests__/` (vitest, `globals: true`, node env).
- Route tests mock `requireAuth`, `@workspace/db`, and side-effectful modules (email, google-sheets, communications, po-pdf) via `vi.mock` with **paths relative to the test file**.
- DB mocking: drizzle query builders are chainable + thenable. Use a `thenable(value, extraMethods)` helper (object with `.then` + extra methods like `.returning()`). `vi.clearAllMocks()` clears call history but keeps `vi.fn` implementations.
- Mock paths must resolve to the same absolute module as the source imports them. Test dir is `src/__tests__/routes/`; source dir is `src/modules/po/` (both 2 levels under `src/`), so `../../middlewares/auth` works from both.

## Deployment
- Render service `srv-d894ofmq1p3s73fh04vg` (cortoba-rfq), tracks `main` branch, autoDeploy=off.
- Build: `pnpm install --no-frozen-lockfile && pnpm --filter @workspace/rfq-portal run build && pnpm --filter @workspace/api-server run build`
- Start: `node artifacts/api-server/dist/index.mjs`
- Trigger manual deploy: `POST https://api.render.com/v1/services/<id>/deploys -d '{"clearCache":"clear"}'` with `Authorization: Bearer <RENDER_API>`.
- **Schema creation**: tables are created via `artifacts/api-server/src/shared/init-db.ts` (`CREATE TABLE IF NOT EXISTS ...` run on every startup) — NOT via `drizzle-kit push`. The `prebuild` push only runs when `DATABASE_URL` is set and is not relied upon. **Any new table MUST be added to `init-db.ts`** or it will not exist on Render and inserts will 500. The `lib/db/src/schema/*.ts` files define the Drizzle ORM objects used in code, but the DDL lives in `init-db.ts`.
- **Frontend error extraction**: the orval client (`lib/api-client-react/src/custom-fetch.ts`) throws `ApiError`, where the server JSON body is `err.data.error` (NOT `err.response.data.error` as with Axios). Use the shared `getApiErrorMessage(err)` helper (`artifacts/rfq-portal/src/lib/api-error.ts`) in mutation `onError` handlers so real server messages surface instead of a generic fallback. Older pages (suppliers) still use the broken Axios-style extractor — fix them when touched.

## Conventions
- Arabic UI (RTL) with English code/comments. Field labels in Arabic.
- PO statuses: `draft` → `sent`. Draft POs are fully editable; sent are immutable.
- Git: use provided GitHub token for push. Co-author commits with `openhands <openhands@all-hands.dev>`.
- Git identity: no global git config exists in this env — set `git config user.name "openhands"` and `git config user.email "openhands@all-hands.dev"` locally before first commit.
- Token caveat: the system-managed `$GITHUB_TOKEN` env var (a `ghu_` OAuth token) has **empty OAuth scopes** and is rejected by git push (403). Use the user-provided `ghp_` classic token literally in the remote URL (e.g. `https://melsofany:<ghp_token>@github.com/...`) for push + PR creation. Reset remote to credential-less URL afterward. The `create_pr` tool also fails (403) because it uses the `ghu_` token — create PRs directly via `curl` to `https://api.github.com/repos/<owner>/<repo>/pulls` with the `ghp_` token.

## Customer module (added in PR #9)
- DB: `lib/db/src/schema/customers.ts` — `customers` table (id, customerId, name, nickname, contactPerson, email, phone, address, taxId, notes, isActive, createdAt, updatedAt). Drizzle `push` (prebuild) creates the table on deploy when `DATABASE_URL` is set.
- API: `artifacts/api-server/src/modules/users/customers.ts` — `GET/POST /customers`, `GET/PATCH/DELETE /customers/:id`. Duplicate email/phone guarded on create + update. Delete is `requireRole("admin","manager")` and FK-aware (409 on linked records). Mounted via `modules/users/index.ts`.
- Frontend: `artifacts/rfq-portal/src/modules/customers/pages/{index,new,detail}.tsx` (list + search + delete confirm, add form, detail + inline edit + delete modal). Routes `/customers`, `/customers/new`, `/customers/:id` in `App.tsx`.
- Customers page pattern (in-place edit + delete) mirrors the suppliers module but drops categories/scores/bulk-import.

## Customer RFQ module (added in PR #11)
- DB: `lib/db/src/schema/customer_rfqs.ts` — `customer_rfqs` (id, internalNo, customerId→customers, customerName, customerRfqNo, numberAutoGenerated, entryDate, expiryDate, buyerName, status, notes, createdAt, updatedAt) + `customer_rfq_items` (id, customerRfqId→customer_rfqs ON DELETE CASCADE, partNo, lineItem, uom, qty NUMERIC(15,4), createdAt). Tables created via `init-db.ts` (NOT drizzle-kit push).
- API: `artifacts/api-server/src/modules/customer-rfq/routes.ts` — `GET/POST /customer-rfq`, `GET/PATCH/DELETE /customer-rfq/:id`. Mounted via `modules/customer-rfq/index.ts` → `routes/index.ts`. POST auto-generates `customerRfqNo` (`CRFQ-YYYY-NNNNNN`) when blank and sets `numberAutoGenerated=true`; `internalNo` is always generated. `customerId` resolved from a typed customer name (ilike match). `lineItem` spaces stripped server-side (`replace(/\s+/g,"")`). All routes behind `requireAuth`; PATCH is draft-only.
- Frontend: `artifacts/rfq-portal/src/modules/customer-rfq/pages/{index,new,detail}.tsx`. `new.tsx` has a `CustomerCombobox` (pick existing customer or type name), optional customer-RFQ-no with live auto-generate warning banner, date pickers, buyer, multi-row items (lineItem strips on input via `replace(/\s+/g,"")`, UOM `<datalist>`, qty). `detail.tsx` shows the auto-number warning (via `?warn=auto-number` query or the `numberAutoGenerated` flag). Routes `/customer-rfq`, `/customer-rfq/new`, `/customer-rfq/:id`.
- Tests: `artifacts/api-server/src/__tests__/routes/customer-rfq.test.ts` (9 tests; uses a `chainable(value, methods)` helper that is both thenable and chainable to model drizzle's await-anywhere builders).
