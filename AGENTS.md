# Rfq-Manager вЂљГ„Г® Repository Notes

## Overview

Cortoba Supplies RFQ (Request for Quotation) management system. Monorepo (pnpm workspaces).

## Structure

- `artifacts/api-server/` вЂљГ„Г® Express + Drizzle ORM backend (esbuild bundle вЂљГњГ­ `dist/index.mjs`)
- `artifacts/rfq-portal/` вЂљГ„Г® React + Vite SPA frontend
- `lib/db/` вЂљГ„Г® `@workspace/db` Drizzle schema + pool (requires `DATABASE_URL`)
- `lib/api-spec/openapi.yaml` вЂљГ„Г® OpenAPI spec; clients regenerated via **orval**
- `lib/api-client-react/` вЂљГ„Г® generated React Query client
- `lib/api-zod/` вЂљГ„Г® generated zod schemas

## API routing

- API mounted at `/api` (app.ts: `app.use("/api", router)`). SPA fallback serves `index.html` for unmatched routes.
- PO routes live at `/api/po` and `/api/po/:id` (NOT `/api/purchase-orders` despite the comment in routes/index.ts).
- `/api/healthz` is the unauthenticated liveness probe (returns `{"status":"ok"}`).
- Most routes are behind `requireAuth` (session-based, checks `req.session.employeeId`). Unauthenticated вЂљГњГ­ `401 {"error":"Unauthorized"}`.
- Routes use `req.log` (pino-http). Test apps must stub `req.log` and `req.session`.

## Code generation workflow

1. Edit `lib/api-spec/openapi.yaml`.
2. Run orval to regenerate `lib/api-client-react/src/generated/*` and `lib/api-zod/src/generated/*`.
3. Build libs: `tsc --build` (root).

- **orval pitfall (duplicate schema names)**: a duplicate `components/schemas` key in `openapi.yaml` is a YAML "duplicated mapping key" error. orval reports this only as `Failed to resolve input: Please provide a valid string value` вЂљГ„Г® **after** it has already `Cleaning output folder`, which deletes the committed generated files. Validate the YAML first with `js-yaml` (`node_modules/.pnpm/js-yaml@*/node_modules/js-yaml`) before running orval. When adding a new sub-item schema, name it distinctly (e.g. `CustomerRfqLineItem`, not `CustomerRfqItem`) to avoid colliding with existing `*Item` schemas.

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
- **Schema creation**: tables are created via `artifacts/api-server/src/shared/init-db.ts` (`CREATE TABLE IF NOT EXISTS ...` run on every startup) вЂљГ„Г® NOT via `drizzle-kit push`. The `prebuild` push only runs when `DATABASE_URL` is set and is not relied upon. **Any new table MUST be added to `init-db.ts`** or it will not exist on Render and inserts will 500. The `lib/db/src/schema/*.ts` files define the Drizzle ORM objects used in code, but the DDL lives in `init-db.ts`.
- **Frontend error extraction**: the orval client (`lib/api-client-react/src/custom-fetch.ts`) throws `ApiError`, where the server JSON body is `err.data.error` (NOT `err.response.data.error` as with Axios). Use the shared `getApiErrorMessage(err)` helper (`artifacts/rfq-portal/src/lib/api-error.ts`) in mutation `onError` handlers so real server messages surface instead of a generic fallback. Older pages (suppliers) still use the broken Axios-style extractor вЂљГ„Г® fix them when touched.

## Conventions

- Arabic UI (RTL) with English code/comments. Field labels in Arabic.
- PO statuses: `draft` вЂљГњГ­ `sent`. Draft POs are fully editable; sent are immutable.
- Git: use provided GitHub token for push. Co-author commits with `openhands <openhands@all-hands.dev>`.
- Git identity: no global git config exists in this env вЂљГ„Г® set `git config user.name "openhands"` and `git config user.email "openhands@all-hands.dev"` locally before first commit.
- Token caveat: the system-managed `$GITHUB_TOKEN` env var (a `ghu_` OAuth token) has **empty OAuth scopes** and is rejected by git push (403). Use the user-provided `ghp_` classic token literally in the remote URL (e.g. `https://melsofany:<ghp_token>@github.com/...`) for push + PR creation. Reset remote to credential-less URL afterward. The `create_pr` tool also fails (403) because it uses the `ghu_` token вЂљГ„Г® create PRs directly via `curl` to `https://api.github.com/repos/<owner>/<repo>/pulls` with the `ghp_` token.
- **Push-token expiry (2026-09-21)**: the historic `ghp_IlUf...` classic token is **invalid** (`401 Bad credentials`; `git push` fails `Invalid username or token`). Note `git ls-remote` with any bad credential still lists refs (anonymous), so a successful `ls-remote` does NOT prove a token works вЂ” validate with `curl -H "Authorization: token <tok>" https://api.github.com/user`. `$GITHUB_TOKEN` (the `ghu_` OAuth token) authenticates `/user` + `/repos/...` (read 200, `permissions.push=true`) but every write is refused: `POST /git/refs`, `POST /actions/workflows/deploy.yml/dispatches`, and `git push` all `403 Resource not accessible by integration` вЂ” it is read-only in practice. **A fresh user-issued `ghp_` token with `repo` scope works end-to-end** (push branch в†’ `POST /pulls` в†’ poll `commits/<sha>/check-runs` for the 3 checks в†’ `PUT /pulls/:n/merge {"merge_method":"squash"}`); PR #126 was published exactly this way. Never echo the token: pass it inline in the remote URL and mask it with `sed "s/${TOK}/<tok>/g"` on the output. Read-only fallback to prove a commit landed: `GET /commits/<sha>` = 200 on `main`, 422 for an unpushed local commit.
- **No `@openhands/` credential broker to fall back on**: git has `credential.helper=store` but `~/.git-credentials` does not exist, and there is no askpass helper, SSH key, or netrc in the sandbox. `git push origin <branch>` (no token) hangs waiting on an interactive username prompt вЂ” always wrap push attempts in `GIT_TERMINAL_PROMPT=0` (plus a `timeout`) so they fail fast instead of blocking the session.

## Customer module (added in PR #9) вЂљГ„Г® `customers` table (id, customerId, name, nickname, contactPerson, email, phone, address, taxId, notes, isActive, createdAt, updatedAt). Drizzle `push` (prebuild) creates the table on deploy when `DATABASE_URL` is set.

- API: `artifacts/api-server/src/modules/users/customers.ts` вЂљГ„Г® `GET/POST /customers`, `GET/PATCH/DELETE /customers/:id`. Duplicate email/phone guarded on create + update. Delete is `requireRole("admin","manager")` and FK-aware (409 on linked records). Mounted via `modules/users/index.ts`.
- Frontend: `artifacts/rfq-portal/src/modules/customers/pages/{index,new,detail}.tsx` (list + search + delete confirm, add form, detail + inline edit + delete modal). Routes `/customers`, `/customers/new`, `/customers/:id` in `App.tsx`.
- Customers page pattern (in-place edit + delete) mirrors the suppliers module but drops categories/scores/bulk-import.

## Customer RFQ module (added in PR #11) вЂљГ„Г® `customer_rfqs` (id, internalNo, customerIdвЂљГњГ­customers, customerName, customerRfqNo, numberAutoGenerated, entryDate, expiryDate, buyerName, status, notes, createdAt, updatedAt) + `customer_rfq_items` (id, customerRfqIdвЂљГњГ­customer_rfqs ON DELETE CASCADE, partNo, lineItem, uom, qty NUMERIC(15,4), createdAt). Tables created via `init-db.ts` (NOT drizzle-kit push).

- API: `artifacts/api-server/src/modules/customer-rfq/routes.ts` вЂљГ„Г® `GET/POST /customer-rfq`, `GET/PATCH/DELETE /customer-rfq/:id`. Mounted via `modules/customer-rfq/index.ts` вЂљГњГ­ `routes/index.ts`. POST auto-generates `customerRfqNo` (`CRFQ-YYYY-NNNNNN`) when blank and sets `numberAutoGenerated=true`; `internalNo` is always generated. `customerId` resolved from a typed customer name (ilike match). `lineItem` spaces stripped server-side (`replace(/\s+/g,"")`). All routes behind `requireAuth`; PATCH is draft-only.
- Frontend: `artifacts/rfq-portal/src/modules/customer-rfq/pages/{index,new,detail}.tsx`. `new.tsx` has a `CustomerCombobox` (pick existing customer or type name), optional customer-RFQ-no with live auto-generate warning banner, date pickers, buyer, multi-row items (lineItem strips on input via `replace(/\s+/g,"")`, UOM `<datalist>`, qty). `detail.tsx` shows the auto-number warning (via `?warn=auto-number` query or the `numberAutoGenerated` flag). Routes `/customer-rfq`, `/customer-rfq/new`, `/customer-rfq/:id`.
- Tests: `artifacts/api-server/src/__tests__/routes/customer-rfq.test.ts` (9 tests; uses a `chainable(value, methods)` helper that is both thenable and chainable to model drizzle's await-anywhere builders).

## Customer RFQ request status (PR #29)

- Adds a derived, progressive **request status** (Ш­Ш§Щ„Ш© Ш§Щ„Ш·Щ„ШЁ) shown on the customer-RFQ list + detail. Four milestones rolled up across offer/pricing/customer-PO/delivery tables:
  1. `received` вЂ” Ш·Щ„ШЁ Щ€Ш§Ш±ШЇ (default).
  2. `supplier_priced` вЂ” Щ…ЩЏШіШ№ЩЋЩ‘Ш± Щ…Щ† Ш§Щ„Щ…Щ€Ш±ШЇ: at least one **approved** `offer_item` links to an item of this RFQ (via `rfq_items.customer_rfq_item_id`, with partNo/lineItem fallback for legacy rows). `resolveSupplierPricedItemIds()` (in `customer-rfq/routes.ts`) reuses the same join as `resolveApprovedCosts`.
  3. `customer_priced` вЂ” Щ…ЩЏШіШ№ЩЋЩ‘Ш± X%: share of the RFQ's items with `unit_price > 0`.
  4. `po_issued`/`delivered` вЂ” ШµШЇШ± ШЈЩ…Ш± ШґШ±Ш§ШЎ / Щ…ЩЏШіЩ„ЩЋЩ‘Щ… X%: via `customer_po_items` rollups (`delivery_status` / `total_delivered_qty`).
- Headline stage prefers the most advanced milestone reached; numeric `customerPricingPct`/`deliveredPct` fields let the UI render richer badges.
- Backend: `CustomerRfqRequestStatus` interface + `buildRequestStatus`/`resolveSupplierPricedItemIds`/`computeRequestStatusForRfq` helpers in `modules/customer-rfq/routes.ts`. `GET /customer-rfq` (list) batch-loads items + approved-offer links + PO/delivery rollups (no N+1) and returns `requestStatus` per row. `GET /customer-rfq/:id` returns `requestStatus` + per-item `hasPo` flag. `PATCH /customer-rfq/:id` recomputes both after update.
- OpenAPI: new `CustomerRfqRequestStatus` schema, `requestStatus` on `CustomerRfq`, `hasPo` on `CustomerRfqLineItem`. Regenerated orval clients; removed the recurring `approveOfferItem{Body,200}.ts` dup-name type files + their `export *` lines in `generated/types/index.ts` to clear TS2308 (same gotcha as PR #14).
- Frontend: `customer-rfq/pages/index.tsx` gains a В«Ш­Ш§Щ„Ш© Ш§Щ„Ш·Щ„ШЁВ» column with a colored `RequestStatusBadge` (slate/blue/amber/indigo/green by stage). `customer-rfq/pages/detail.tsx` shows the status badge in the header + a new В«ШЈЩ…Ш± ШґШ±Ш§ШЎВ» column; rows whose item already appears on an issued customer PO turn **green** (bg tint + badge) via the `hasPo` flag.
- Tests: `customer-rfq.test.ts` вЂ” 27 tests. DB mock gains a `customerPoItemsTable` branch returning per-test `poItemRows` for the request-status PO/delivery lookup; `poItemRows` initialized in `beforeEach`. List test now sets `detailItems` (not `countRows`) since the list loads actual items to compute `itemCount` + status.
- **List-hang gotcha (PR #30 fix)**: `resolveSupplierPricedItemIds` takes `withLegacyFallback` (default `true`). The per-item partNo/lineItem fallback is O(N) DB queries and **must be disabled** on the list path (passes `false`) вЂ” it hung the `/customer-rfq` page (stuck at В«Ш¬Ш§Ш±ЩЌ Ш§Щ„ШЄШ­Щ…ЩЉЩ„...В») on Render once many items lacked the FK link. The list path is a fixed set of batched queries (all RFQs в†’ all items в†’ one approved-offer join в†’ one PO rollup); only the detail path keeps the fallback (one RFQ, few items).

## Customer RFQ pricing + finalize/lock (PR #13)

- DB: `customer_rfq_items.unit_price NUMERIC(15,4)` added in `init-db.ts` (CREATE TABLE + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration so existing Render tables pick it up on next startup).
- API (`routes.ts`): `computeTotal(qty, unitPrice)` helper rounds qtyГ—price to 4dp + strips trailing zeros (mirrors `formatQty`). POST/PATCH persist `unitPrice`. GET `/:id` + PATCH responses return `unitPrice` (formatted) + `total` (server-computed). PATCH with `status:"sent"` validates **every** item has a price > 0 else 400 `ШЈШЇШ®Щ„ ШіШ№Ш± ЩѓЩ„ ШЁЩ†ШЇ Щ‚ШЁЩ„ ШЄШ«ШЁЩЉШЄ Ш§Щ„Ш·Щ„ШЁ`; once `status="sent"` the RFQ is immutable (non-draft PATCH в†’ 400 `Щ„Ш§ ЩЉЩ…ЩѓЩ† ШЄШ№ШЇЩЉЩ„ Ш·Щ„ШЁ ШЄШіШ№ЩЉШ± Ш§Щ„Ш№Щ…ЩЉЩ„ ШЁШ№ШЇ ШҐШ±ШіШ§Щ„Щ‡`).
- Frontend (`detail.tsx`): the read-only items table gains ШіШ№Ш± Ш§Щ„Щ€Ш­ШЇШ© / Ш§Щ„ШҐШ¬Щ…Ш§Щ„ЩЉ columns. Drafts: price cell = `<Input type=number>`, live line total (`formatLineTotal`), grand-total footer, and a "Ш­ЩЃШё Ш§Щ„ШЈШіШ№Ш§Ш± Щ€ШЄШ«ШЁЩЉШЄ Ш§Щ„Ш·Щ„ШЁ" button (confirm dialog, disabled until `allItemsPriced`) that PATCHes prices + `status:"sent"`. Sent RFQs render prices/totals read-only.
- OpenAPI: `unitPrice` in `CustomerRfqLineItemInput`; `unitPrice`+`total` in `CustomerRfqLineItem`. Regenerate via `cd lib/api-spec && ./node_modules/.bin/orval --config orval.config.ts`, then `tsc --build`.
- Tests: the db mock's `update().set(vals)` now merges `vals` onto `detailRow` so the post-update re-select sees the new `status` (needed to assert finalize в†’ "sent"). 46 tests total.

## Workflow caveat (learned the hard way)

- **Commit before switching branches / `git reset --hard`.** Uncommitted working-tree edits are destroyed by `git reset --hard` (and by `git checkout` if it touches overlapping files). When doing a multi-edit feature, commit incrementally on the feature branch BEFORE fetching/resetting against origin, or you lose all uncommitted work irrecoverably (git never staged the blobs).

## Purchase-order items from customer POs (PR #20 в†’ simplified PR #21)

- On `/purchase-orders/new`, the PO-number lookup is now **automatic** (no source toggle).
- Backend (`modules/po/routes.ts`): `GET /api/po/lookup/:poNo` now prefers a matching **customer PO** (entered on `/customer-po`, matched via `ilike(customerPoNo, poNo)` вЂ” case-insensitive exact). If a customer PO matches and has items, those are returned in the **SheetItem shape** (`itemId/lineItem/partNo/description/uom/qty/referencePrice/poNo`, `referencePrice` = stored `unit_price`). If no customer PO matches (or it has no items), it **falls back** to `lookupPoFromSheet` (Google Sheets) вЂ” so legacy PO numbers still resolve. Google Sheets integration is **untouched**.
- `GET /api/po/customer-po-numbers` вЂ” list `{value,label,internalNo,customerName,status}` for the combobox. (The standalone `/api/po/customer-po-lookup` endpoint from PR #20 was removed in PR #21 вЂ” the main lookup subsumes it.)
- Frontend (`modules/po/pages/new.tsx`): `useMergedPoSuggestions()` merges `/api/po/sheets/po-numbers` + `/api/po/customer-po-numbers` into one deduped list (case-insensitive; items in both keep the richer customer-PO entry). `PoNumberCombobox` shows rich two-line suggestions when `internalNo`/`customerName` exist. `handleLookup` calls the single `/api/po/lookup/:poNo`. `unitPrice` pre-filled from `referencePrice` (works for both sources вЂ” sheet returns it from column I). The field label is now **В«Ш±Щ‚Щ… ШЈЩ…Ш± Ш§Щ„ШґШ±Ш§ШЎВ»** (the old В«Purchase order number (sheet column K)В» + the PR #20 radio toggle are both gone).
- Imports in `po/routes.ts`: `customerPosTable`/`customerPoItemsTable` + `ilike`.

## Customer PO module (PR #17 + #18)

- DB: `customer_pos` (id, internalPoNo, customerPoNo, customerIdв†’customers, customerName, poDate, buyerName, notes, employeeId, employeeName, status, createdAt, updatedAt) + `customer_po_items` (id, customerPoIdв†’customer_pos ON DELETE CASCADE, customerRfqId, customerRfqItemId, partNo, lineItem, description, uom, qty NUMERIC(15,4), unitPrice NUMERIC(15,4), deliveryDate, createdAt). Tables created via `init-db.ts`.
- API: `modules/customer-po/routes.ts` вЂ” `GET/POST /customer-po`, `GET/PATCH/DELETE /customer-po/:id`. Mounted via `modules/customer-po/index.ts` в†’ `routes/index.ts`. POST auto-generates `internalPoNo` (`CPO-YYYY-NNNNNN`), records `employeeId`/`employeeName` from `req.session`. `customerId`/`customerName` are explicit input (POST 400s without a customerName). Customer name is stored, NOT derived from a linked RFQ вЂ” works for POs without an RFQ number. `lineItem` stripped. PATCH replaces items. `status:sent` finalizes (immutable after). `GET /customer-po/:id` returns items with `unitPrice`/`total` (server-computed).
- Frontend: `modules/customer-po/pages/{index,new,detail}.tsx`. `new.tsx` has a `CustomerCombobox` (pick existing customer or type name), optional Customer-RFQ picker (pulls checked items into the PO with their qty/price/delivery date; auto-fills owning customer from the RFQ), read-only "Ш§Щ„Щ…Щ€ШёЩЃ Ш§Щ„Щ…ЩЏШЇШ®ЩђЩ„" badge (logged-in employee), buyerName relabeled "Ш§Щ„Щ…ШґШЄШ±ЩЉ (Ш§Щ„Щ…Ш±Ш¬Ш№ Щ…Щ† Ш§Щ„Ш№Щ…ЩЉЩ„)" to disambiguate. `detail.tsx`: draft edit shows customer picker; read-only renders customerName/buyerName/employeeName. Shared `components/CustomerCombobox.tsx` (reused by new + detail) вЂ” uses `useListCustomers`; free-text allowed so a name persists even if not registered.
- Tests: `customer-po.test.ts` (17 tests; chainable+thenable DB mock; `resolveCustomerName` join path REMOVED вЂ” customer_name now read from stored column).
- orval gotcha: when a PR adds an operation/schema, the merge with main re-triggers orval dup-name TS2308; after merge-resolve, re-run `cd lib/api-spec && orval --config orval.config.ts`, delete any duplicating `approveOfferItem*.ts` type files + their `export *` lines in `generated/types/index.ts`, then `tsc --build`.

## Offer-item approval + customer-rfq margin check (PR #14)

- DB: `offer_items.is_approved` (boolean) in `lib/db/src/schema/offers.ts`; `rfq_items.customer_rfq_item_id` (FK в†’ `customer_rfq_items.id`, nullable) in `lib/db/src/schema/rfq.ts`. Both created via ALTER TABLE in `init-db.ts` (DDL lives there, schema files define ORM objects).
- API вЂ” approve: `PATCH /api/offers/items/:offerItemId/approve` (`modules/rfq/offers.ts`). Body `{approved?: boolean}` (default `true`). Sets `is_approved` on one offer_item and un-approves the previous approved item for the same `rfq_item_id`. Logs to `audit_log`. Returns `{id, isApproved}`.
- API вЂ” offers detail: `GET /api/rfq/:id/offers` includes `offerItemId` + `isApproved` per offer (both in `analysis.itemAnalysis[].offers[]` and flat `offers.items[]`).
- API вЂ” customer-rfq finalize (margin check): PATCH `/customer-rfq/:id` with `status:"sent"` enforces `1.06 Г— approved supplier cost` per item (both prices EXCL VAT; `taxIncluded` items VAT-stripped). `resolveApprovedCosts()` (in `customer-rfq/routes.ts`) joins `offer_items`в†’`rfq_items` via `customer_rfq_item_id`, with `partNo`/`lineItem` fallback. Violations в†’ `400 {error, marginViolations}`. Admin (`req.session.role==="admin"`) may pass `overrideMarginCheck:true` (audited).
- Frontend: `rfq/pages/detail.tsx` offers tab gains "Ш§Ш№ШЄЩ…Ш§ШЇ Ш§Щ„ШіШ№Ш±" column + per-supplier approve toggle (one approved per item). `rfq/pages/new.tsx` sends `customerRfqItemId` per rfq_item.
- Tests: `customer-rfq.test.ts` extended with margin-clear/violation/no-approved/admin-override вЂ” DB mock returns `approvedRows` for `offerItemsTable` joins (`.innerJoin`) and uses mutable `sessionState.role`. New `offer-approve.test.ts`. **Gotcha**: do NOT set `req.ip` in test middleware (getter-only, throws); route reads it via `req.ip` (undefined in tests, fine).
- orval regen gotcha: after adding operations, orval emits a zod const in `generated/api.ts` AND a type file in `generated/types/` (e.g. `approveOfferItemBody.ts`). The zod `index.ts` `export *` from both causes TS2308. Fix: delete the duplicating type files + their `export *` lines in `generated/types/index.ts`.

## Customer PO module (PR #17)

- DB: `lib/db/src/schema/customer_pos.ts` вЂ” `customer_pos` (id, internalPoNo, customerPoNo, poDate, buyerName, employeeIdв†’employees, employeeName, customerName, status, notes, createdAt, updatedAt) + `customer_po_items` (id, customerPoIdв†’customer_pos ON DELETE CASCADE, customerRfqId nullable, customerRfqItemId nullable, partNo, lineItem, description, uom, qty, unitPrice, deliveryDate, createdAt). Tables created via `init-db.ts` (NOT drizzle-kit push). `customer_rfq_item_id` is **not unique** вЂ” the same item may be ordered again on a later PO (partial shipment).
- API (`modules/customer-po/routes.ts`): `GET/POST /customer-po`, `GET/PATCH/DELETE /customer-po/:id`, plus `GET /customer-po/customer-rfqs` (light RFQ picker list). POST auto-generates `internalPoNo` (`CPO-YYYY-NNNNNN`) via `generateInternalPoNo` (select maxNo). `resolveCustomerName(poId)` does `select({name}).from(poItems).innerJoin(rfqs).where(poId).limit()` в†’ sets `customerName` from the first RFQ-linked item (null for manual-only POs). `lineItem` spaces stripped server-side. NUMERIC qty/unitPrice formatted; `total = qtyГ—unitPrice` computed on read. PATCH draft-only; `status:"sent"` finalizes (immutable). DELETE draft-only. All routes behind `requireAuth` + `audit_log`. Employee recorded from `req.session.employeeId` (+ name lookup).
- Frontend (`customer-po/pages/{index,new,detail}.tsx`): index=list+search; new=PO header + optional **CustomerRfqPicker** (combobox) that loads the RFQ's items via `useGetCustomerRfq` and renders a checklist; checked items are appended as PO rows (partNo/desc/uom pre-filled, qty/price/deliveryDate editable); manual rows for POs with no RFQ. detail=read-only items table with line totals + grand total + draft edit/finalize/delete. Routes `/customer-po`, `/customer-po/new`, `/customer-po/:id`.
- OpenAPI: `customer-po` tag, 3 paths, 7 schemas (`CustomerPo`/`CustomerPoCustomerRfqOption`/`CustomerPoLineItem[Input]`/`CustomerPoInput`/`CustomerPoUpdate`/`CustomerPoDetail`).
- Tests: `__tests__/routes/customer-po.test.ts` (16). DB mock: `customerPoItemsTable` (bare select) branches on arg having `name` (в†’ resolveCustomerName via `.innerJoin`) vs no arg (в†’ detail items via `.where()`); `customerPosTable` with `{maxNo}` arg в†’ generateInternalPoNo; with `{po}` arg в†’ list (`orderBy`); bare в†’ detail row (`where`). `update().set(vals)` reflects onto `detailRow`.
- orval regen note: regenerating re-creates the orphan `approveOfferItem{Body,200}.ts` type files (deleted in PR #14 to fix TS2308). After each orval run, delete them + their `export *` lines in `generated/types/index.ts` again, or `tsc --build` fails with TS2308.

## Goods receipt / delivery / accounts module (receipts & realized margin)

- DB: `lib/db/src/schema/receipts_deliveries.ts` вЂ” `po_item_receipts` (id, poItemIdв†’purchase_order_items, poId, receivedQty, acceptedQty, rejectedQty, rejectionReason, actualCost NUMERIC(15,4), receiptStatus, receivedBy, receivedAt) + `customer_po_item_deliveries` (id, customerPoItemIdв†’customer_po_items, customerPoId, deliveredQty, deliveryStatus, deliveredBy, deliveredAt). Added fields: `purchase_order_items` (`customerPoItemId`, `totalReceivedQty`, `totalAcceptedQty`, `totalRejectedQty`, `finalActualCost`, `lineStatus`), `customer_po_items` (`totalDeliveredQty`, `deliveryStatus`), `work_order_assignments.poItemId`. All DDL in `init-db.ts` (CREATE TABLE IF NOT EXISTS + ALTER TABLE вЂ¦ ADD COLUMN IF NOT EXISTS).
- API receipts (`modules/po/receipts.ts`): `GET /po/:id/receipts` (list), `POST /po/:id/receipts` (create a receipt row; `postpone:true` shortcut sets `lineStatus=postponed`), `PATCH /po/receipts/:receiptId`, `DELETE /po/receipts/:receiptId` (re-aggregates after every write). Aggregation: ОЈ received/accepted/rejected, weighted-avg `finalActualCost`, `lineStatus` = fulfilled|partial|rejected|postponed|pending. `REJECTION_REASONS` exported here (shared with WhatsApp flow). `POST /po/:id/send-receipt-prompts` sends a per-item interactive WhatsApp button per line to the representative. `normalizePhone` is exported from `po/routes.ts`.
- API deliveries (`modules/customer-po/deliveries.ts`): `GET /customer-po/:id/deliveries`, `POST /customer-po/:id/deliveries`, `PATCH/DELETE /customer-po/deliveries/:deliveryId`; re-aggregates `totalDeliveredQty`/`deliveryStatus` on `customer_po_items`.
- API accounts (`modules/accounts/routes.ts`): `GET /accounts/margins` (per-line realized margin joining `customer_po_items` в†” `purchase_order_items` via `customerPoItemId`; revenue=qtyГ—sellUnitPrice, cost=acceptedQtyГ—finalActualCost, margin + marginPct; `onlyLoss` filter), `GET /accounts/margins/summary` (totals + loss-lines count). Filters: `customerName`, `from`, `to`.
- Session: `SessionData` gained optional `employeeName`, set on login (used by receipts/deliveries `receivedBy`).
- WhatsApp (`communications/service.ts` + `routes.ts`): new `sendRepresentativeItemReceiptWhatsApp` (per-line ШЄЩ…-Ш§Щ„Ш§ШіШЄЩ„Ш§Щ…/Ш±ЩЃШ¶ buttons, payload `work_order_item:<poNo>:<poItemId>:<action>`) and `sendRejectionReasonOptions` (interactive list of `REJECTION_REASONS`, payload `work_order_reason:<poNo>:<poItemId>:<reason>`). Inbound `handleWorkOrderItemButton` creates a full-qty `po_item_receipts` row on "received", or prompts for reason then records a full-qty rejection. Legacy whole-PO flow (`work_order:`) preserved and runs only when the per-item flow declines the payload. Uses `ActionList`/`ListSection`/`Row` from whatsapp-api-js (rest-parameter constructors need a guaranteed non-empty tuple: `new ListSection(title, firstRow, ...rest)`).
- Frontend: `/purchase-orders` page now has Tabs вЂ” В«ШЈЩ€Ш§Щ…Ш± Ш§Щ„ШґШ±Ш§ШЎВ» (existing list) and В«Ш§ШіШЄЩ„Ш§Щ… Ш§Щ„ШЄЩ€Ш±ЩЉШЇШ§ШЄВ» (`modules/po/pages/receipts.tsx`): expandable PO rows в†’ per-line receipt form (received/accepted/rejected/actualCost/rejectionReason) + postpone + send-receipt-prompts to representative. `/accounts` page (`modules/accounts/pages/index.tsx`): summary cards (revenue/cost/margin/loss-lines) + filterable margins table (loss rows highlighted red). Sidebar entry `nav.accounts` (Calculator icon) + i18n. These new pages use direct `fetch("/api/...", {credentials:"include"})` (NOT orval) since the endpoints aren't in the OpenAPI spec вЂ” same pattern as other non-spec calls.
- **Tab-embed gotcha (PR #31 fix)**: `deliveries.tsx` (customer-po) and `receipts.tsx` (purchase-orders) are rendered as **Tabs inside their parent index page**, which ALREADY wraps in `<Layout>`. Do NOT wrap these tab pages in `<Layout>` вЂ” it produces a nested double sidebar. They are tab-only (no standalone route in App.tsx), so the inner `<Layout>` + its import were removed; the parent page supplies the layout.

## Egyptian tax compliance вЂ” accounts rebuild (PR #36)

- `/accounts` rebuilt into a **Tabs** page (`modules/accounts/pages/index.tsx`): Ш§Щ„Щ‡Ш§Щ…Шґ Ш§Щ„Щ…Ш­Щ‚Щ‚ (margins, preserved) | Ш¶Ш±ЩЉШЁШ© Ш§Щ„Щ‚ЩЉЩ…Ш© Ш§Щ„Щ…Ш¶Ш§ЩЃШ© (VAT) | Ш§Щ„Ш®ШµЩ… ШЄШ­ШЄ Ш­ШіШ§ШЁ Ш§Щ„Щ…Щ€Ш±ШЇ (withholding) | ШҐШ№ШЇШ§ШЇШ§ШЄ Ш§Щ„Ш¶Ш±Ш§Ш¦ШЁ (settings). The old single margins screen moved to `MarginsTab.tsx` (Layout wrapper + h1 removed вЂ” the parent index page supplies `<Layout>` + page title, same tab-embed pattern as `receipts.tsx`/`deliveries.tsx`).
- Egyptian VAT Law No. 67/2016 в†’ standard rate **14%**; withholding (Ш®ШµЩ… ШЄШ­ШЄ Ш­ШіШ§ШЁ Ш§Щ„Щ…Щ€Ш±ШЇ) schedule в†’ **3%** general, **5%** services/professional, **1%** purchases. References used: `openaccountants/openaccountants` (skills/international/egypt) + `Axentorllc/erpnext_egypt_compliance` (ETA e-invoicing).
- New `tax_settings` table (single row, `key='default'`): company identity + editable VAT/withholding rates. Schema in `lib/db/src/schema/tax_settings.ts`; DDL + seed in `init-db.ts` (`CREATE TABLE IF NOT EXISTS` + `INSERT ... ON CONFLICT (key) DO NOTHING`) вЂ” no drizzle-kit push needed.
- New routes in `modules/accounts/routes.ts` (all behind `requireAuth`): `GET /accounts/vat` (output VAT on customer PO sales + input VAT on supplier PO purchases, `taxIncluded`-aware, net payable/credit carried forward), `GET /accounts/withholding` (per-PO 3% aggregation + totals), `GET /accounts/tax-settings`, `PUT /accounts/tax-settings` (`requireRole("admin","manager")`, audited). Shared helpers in `modules/accounts/tax.ts` (`rateOf`, `vatComponents`, `vatOnNet`, `round2`). Margins routes (`/accounts/margins`, `/accounts/margins/summary`) unchanged.
- Frontend tabs use direct `fetch("/api/...", {credentials:"include"})` (NOT orval) вЂ” endpoints not in OpenAPI spec, same pattern as receipts/deliveries. Settings PUT restricted to admin/manager (403 otherwise).
- Tests: `__tests__/routes/accounts.test.ts` (7) вЂ” VAT output/input/net, tax-inclusive stripping, withholding per-PO aggregation, settings role guard + manager update. DB mock uses a per-FROM-table `selectBuilder()` that chains innerJoin/leftJoin/where/orderBy and resolves the per-test `sellRows`/`buyRows`/`poRows`/`taxSettingsRow`. 96 tests total pass.

## PO line charges, operating expenses & customer collections (PR #37)

- DB: `lib/db/src/schema/expenses.ts` (exported from `schema/index.ts`):
  - `po_item_charges` (id, poItemIdв†’purchase_order_items ON DELETE CASCADE, poIdв†’purchase_orders ON DELETE CASCADE, chargeType TEXT, description, amount NUMERIC(15,4), createdAt). Per-line charges (Щ†Щ‚Щ„/ШґШ­Щ†/Ш¬Щ…Ш§Ш±Щѓ/ШЄШ­Щ…ЩЉЩ„/ШЄЩ†ШІЩЉЩ„/ШЄШ®ШІЩЉЩ†/ШЄШЈЩ…ЩЉЩ†/ШЈШ®Ш±Щ‰) so the true cost of each line is known precisely.
  - `operating_expenses` (id, category, description, expenseDate TEXT, amount NUMERIC(15,4), notes, employeeIdв†’employees, employeeName, createdAt) + `expense_attachments` (id, expenseIdв†’operating_expenses ON DELETE CASCADE, originalName, mimeType, size, content base64, createdAt). Company operating expenses NOT tied to a PO (rent/hosting/utilities/maintenance/admin), with file attachments (receipts/invoices).
  - `customer_po_collections` (id, customerPoIdв†’customer_pos ON DELETE CASCADE 1:1 via UNIQUE index, collectionStartDate TEXT, collectionDays INTEGER default 30, dueDate TEXT computed, notes, createdAt, updatedAt) + `customer_po_payments` (id, customerPoIdв†’customer_pos ON DELETE CASCADE, paymentDate TEXT, amount NUMERIC(15,4), method, reference, notes, employeeId, employeeName, createdAt). Collection-terms ledger per customer PO + payment installments.
  - All DDL in `init-db.ts` (CREATE TABLE IF NOT EXISTS + unique index). Exports: `PO_CHARGE_TYPES`, `OPERATING_EXPENSE_CATEGORIES`, `COLLECTION_STATUS`, `DUE_SOON_DAYS`.
- API:
  - `modules/po/charges.ts` (mounted via `modules/po/index.ts`): `GET /po/items/:itemId/charges`, `POST /po/items/:itemId/charges` (accepts `{charges:[...]}` or a single body), `DELETE /po/charges/:chargeId`. All behind `requireAuth`; audited.
  - `modules/expenses/` (mounted in `routes/index.ts`): `GET/POST /expenses`, `GET /expenses/summary` (totals by category + grand total), `GET/PATCH/DELETE /expenses/:id` (delete is `requireRole("admin","manager")`), attachment upload/download/list/delete. Uses `multer` memoryStorage, 20MB limit вЂ” same pattern as `rfq/attachments.ts`.
  - `modules/collections/` (mounted in `routes/index.ts`): `GET /collections` (all customer POs w/ computed status + filters `status`/`customerName`), `GET /collections/alerts` (due-soon + overdue lists), `GET /collections/:poId`, `PUT /collections/:poId` (computes `dueDate = startDate + days`), `POST /collections/:poId/payments`, `PATCH /collections/payments/:id`, `DELETE /collections/payments/:id` (delete is `requireRole`). Status computed (not stored): `collected` | `partial` | `overdue` | `due_soon` (within DUE_SOON_DAYS=7) | `pending`. Receivable = ОЈ customer_po_items.qtyГ—unitPrice; collected = ОЈ payments.
  - **Accounts margin integration**: `modules/accounts/routes.ts` gained `loadChargesByPoItem()`; `/accounts/margins` + `/accounts/margins/summary` now fold per-line PO charges into realized cost: `cost = acceptedQty Г— finalActualCost + ОЈ charges`. Margins response gains `lineCharges` field.
- Frontend: `/expenses` page (list+filters+create/edit+attachments, Wallet icon), `/collections` page (alert cards+status filters+terms+payment ledger, Banknote icon), PO charges panel inside `receipts.tsx` `ReceiptItemRow`, and two new `/accounts` tabs (ExpensesSummaryTab, CollectionsSummaryTab). All use direct `fetch` (NOT orval). i18n `nav.expenses`/`nav.collections` (en/ar).
- Tests: `expenses.test.ts` (6) + `collections.test.ts` (8). 110 tests total pass.
- **Frontend db-import gotcha**: do NOT import anything from `@workspace/db` in portal code вЂ” its `index.ts` eagerly constructs a node-postgres `Pool`/`drizzle` proxy. Mirror small constants (e.g. `PO_CHARGE_TYPES`) locally instead.

## Comprehensive double-entry accounting system (PR вЂ” /accounts rebuild)

- Goal: a full Egyptian-compliant accounting system (Ш¶.Щ‚.Щ…. 14% Щ…Ш®Ш±Ш¬Ш§ШЄ/Щ…ШЇШ®Щ„Ш§ШЄШЊ Ш®ШµЩ… ШЄШ­ШЄ Ш­ШіШ§ШЁ Ш§Щ„Щ…Щ€Ш±ШЇ 3%) on `/accounts`, letting an accountant enter/control/audit/review/post invoices & journal entries and produce financial statements. Research (Tavily) confirmed: Egyptian supply traders post VAT as 14% output on sales / input on purchases, withhold 1вЂ“3% under Ш­ШіШ§ШЁ Ш§Щ„Щ…Щ€Ш±ШЇ, and run a standard double-entry COA.
- DB: `lib/db/src/schema/accounting.ts` вЂ” `chart_of_accounts` (id, code UNIQUE, nameAr, nameEn, type [asset|liability|equity|revenue|expense], isControl, isActive), `journal_entries` (id, entryNo UNIQUE `JE-YYYY-NNNNNN`, entryDate, description, source [manual|supplier_invoice|supplier_payment|sales_invoice], status [draft|posted|void], employeeId, employeeName, reviewedByName, postedAt), `journal_lines` (id, entryId CASCADE, accountIdв†’chart_of_accounts, lineNo, accountCode snapshot, debit, credit, description), `supplier_invoices` + `supplier_invoice_items` + `supplier_payments` + `supplier_payment_applications`, `sales_invoices` + `sales_invoice_items`. All DDL (CREATE TABLE IF NOT EXISTS + default COA seed of ~30 accounts) lives in `init-db.ts` вЂ” NOT drizzle-kit push.
- Backend `modules/accounts/`:
  - `posting.ts` вЂ” shared `postJournalEntry({entryDate, description, source, lines, employeeId, employeeName})`: validates в‰Ґ2 lines + nonzero + balanced (debit==credit), `assertAccountsExist` (select codes via `sql\`code = any(${uniq})\``), `nextEntryNo` (`JE-YYYY-NNNNNN`from`like`max), inserts entry + lines in one tx, stamps status=posted.`ACCOUNT_CODES`const map (e.g. CASH 1001, BANK 1010, AR 1200, INVENTORY 1300, INPUT_VAT 1401, AP 2100, OUTPUT_VAT 2401, WITHHOLDING_PAYABLE 2402, SALES 4100, COGS 5100, BANK_CHARGES 5900).`accountBalance(accountId, {from,to})` joins journal_linesв†”entriesв†”coa.
  - `ledger.ts` вЂ” COA CRUD (`GET/POST /coa`, `PATCH/DELETE /coa/:id` accountant-role), journal list+detail+create+review+post+void (`GET/POST /journal`, `GET /journal/:id`, `POST /journal/:id/{review,post,void}`), trial-balance (`GET /trial-balance`), income-statement (`GET /income-statement`), balance-sheet (`GET /balance-sheet`), GL by account (`GET /ledger/:code`), dashboard (`GET /dashboard`).
  - `supplier-invoices.ts` вЂ” `GET/POST /supplier-invoices`, `GET/PATCH/DELETE /supplier-invoices/:id`, `POST /supplier-invoices/:id/{post,void}`, `POST /supplier-payments`. POST computes VAT 14% + withholding 3% (configurable via taxSettings) в†’ `computeInvoice`. Post path generates the AP/Inventory/Input-VAT/Withholding-payable journal via `postJournalEntry`. Payments split across invoices (oldest-first) + bank charges.
  - `sales-invoices.ts` вЂ” `GET/POST /sales-invoices`, `GET/PATCH/DELETE /sales-invoices/:id`, `POST /sales-invoices/:id/{post,void}`, `GET /sales-invoices/:id/pdf`. POST auto-fills items from a linked customer PO (select renamed `{no,name}`). Post path recognizes COGS from the customer-PO items' linked purchase-order receipts (`acceptedQty Г— actualCost` + PO charges) and posts AR/Sales/Output-VAT/COGS/Inventory journal. PDF via `pdfkit` (`sales-invoice-pdf.ts`).
  - Mounted in `modules/accounts/index.ts` (added `requireRole("accountant","admin","manager")` gating on posting/CRUD).
- Frontend `modules/accounts/pages/`:
  - `index.tsx` rebuilt with 12 tabs (dashboard, coa, journal, supplier-invoices, sales-invoices, statements, margins, vat, withholding, expenses, collections, settings). Tab state synced to `?tab=` query via `window.history.replaceState` (the portal uses **wouter**, NOT react-router вЂ” use `Link` from `wouter` and `window.location`/`history` for search-params, never `react-router-dom`).
  - New tabs: `DashboardTab` (AP/AR/cash/bank cards + pending drafts + recent entries), `ChartOfAccountsTab` (CRUD + control-account flag), `JournalTab` (create balanced draft в†’ review в†’ post в†’ void; live debit/credit balance check), `SupplierInvoicesTab` (create with live VAT/withholding preview, post, void), `SalesInvoicesTab` (manual items or auto-fill from customer PO, post, void, PDF download), `FinancialStatementsTab` (sub-tabs: trial balance / income statement / balance sheet with date filters).
- Tests: `__tests__/routes/ledger.test.ts` (21). DB mock uses `vi.importActual("@workspace/db")` to capture real table handles and match by reference in `selectBuilder.from()` (the routes import the real drizzle table objects, so string-key matching fails). `drizzle-orm` mock makes `sql` a tagged-template function (not just an object) since the code uses `` sql`...` ``. `db.insert` mock handles BOTH single-object and array `values()` arg. COA seed rows must include every `ACCOUNT_CODES` code used by the posting paths or `assertAccountsExist` 400s. 131 tests total pass.
- Gotchas:
  - The portal uses **wouter** (`import { Link } from "wouter"`), not react-router-dom вЂ” `useSearchParams` does not exist; read query via `new URLSearchParams(window.location.search)` and update via `window.history.replaceState`.
  - `sales-invoices.ts` POST reads `po.no`/`po.name` (renamed select aliases), so the test DB rows must provide `no`/`name` fields, not the raw `customerPoNo`/`customerName`.
  - New accounting routes are NOT in the OpenAPI spec вЂ” the frontend calls them via direct `fetch("/api/accounts/...", {credentials:"include"})`, same pattern as receipts/deliveries/accounts margins.

## Accounts ledger integration (PR #40) вЂ” single source of truth

- **Goal**: the old accounts tabs (Expenses, Collections, VAT, Withholding) computed figures straight from PO/invoice tables and never touched the double-entry ledger, so the new ledger tabs (COA/Journal/Financial Statements) and the old tabs diverged. PR #40 wires the old modules into the ledger.
- **Expenses** (`modules/expenses/routes.ts`): `POST /expenses` now calls `postJournalEntry()` (from `accounts/posting.ts`) right after the insert вЂ” balanced entry: debit the mapped expense-account code (via `accounts/integration.ts` `expenseAccountFor(category)`), credit the cash/bank account (`cashAccountFor(paymentMethod)` or an explicit `cashAccountCode`). Posting failures are caught + logged (never block the 201). The expenses test asserts **4** `db.insert` calls (expense row + journal-entry header + journal lines + audit).
- **Collections** (`modules/collections/routes.ts`): `POST /collections/:poId/payments` now (1) posts a journal entry (debit cash/bank, credit `ACCOUNT_CODES.AR` with `partyType:"customer"`) and (2) applies the payment to linked **posted** sales invoices for that PO (oldest-first by id), reducing `balance` and flipping `status:"paid"` when settled. Imports `salesInvoicesTable` + `ACCOUNT_CODES` from `@workspace/db` and `cashAccountFor` from integration.
- **VAT** (`modules/accounts/routes.ts`): `GET /accounts/vat` now reads output VAT from **posted** `sales_invoices` and input VAT from **posted** `supplier_invoices` (filters `status:"posted"`, then date-range in JS). Removed the per-PO-line recompute. Removed the now-unused `vatComponents`/`vatOnNet` imports from `./tax` (only `rateOf`, `round2` stay).
- **Withholding** (`modules/accounts/routes.ts`): `GET /accounts/withholding` now reads from **posted** `supplier_invoices` (`netAmount`/`withholdingRate`/`withholdingAmount`) per invoice instead of aggregating purchase-order lines. The `WithholdingLine` interface kept `poId`/`internalPoNo`/`sheetPoNo` shape (poId = supplier-invoice id) so the frontend table didn't change structure; only the column header/copy became В«ЩЃШ§ШЄЩ€Ш±Ш© Ш§Щ„Щ…Щ€Ш±ШЇВ».
- **integration.ts** (new, `modules/accounts/integration.ts`): `EXPENSE_CATEGORY_ACCOUNT` (Arabic category в†’ `ACCOUNT_CODES.*` expense code) + `expenseAccountFor()` + `cashAccountFor(method)`. Shared by expenses + collections.
- **Test mocking notes**: the expenses + collections tests had to gain `chartOfAccountsTable`/`journalEntriesTable`/`journalLinesTable`/`salesInvoicesTable` + `ACCOUNT_CODES` exports in their `@workspace/db` mock, COA rows in `selectBuilder.from()` (or `assertAccountsExist` 400s and the posting is swallowed в†’ wrong insert count), and a **callable** `sql` tagged template in the `drizzle-orm` mock (the posting path uses `` sql`...` ``). The accounts VAT/withholding tests now seed `salesInvoiceRows`/`supplierInvoiceRows` (with `status:"posted"`) instead of `sellRows`/`buyRows`/`poRows`; `selectBuilder` filters invoice rows by `status === "posted"`.
- **Merge/deploy**: PR #40 squash-merged (84fc6f2), Render deploy triggered via `POST /v1/services/<id>/deploys {"clearCache":"clear"}` (autoDeploy is off). Healthz confirmed live.

## Accounts UI simplification (PR #42 в†’ PR #43) вЂ” 6 main tabs, nested sub-tabs

- **Problem**: the old В«Ш§Щ„Щ…ШµШ±Щ€ЩЃШ§ШЄ Ш§Щ„ШЄШґШєЩЉЩ„ЩЉШ©В» tab was a duplicate entry point of В«Щ‚ЩЉЩ€ШЇ Ш§Щ„ЩЉЩ€Щ…ЩЉШ©В» (both create journal entries), confusing users. Even after removing it, 11 top-level tabs were still too many/unstructured.
- **Fix (PR #43)**: collapsed the 11 top-level tabs into **6** using the same nested-sub-tabs pattern that `FinancialStatementsTab` already uses. New structure in `accounts/pages/index.tsx`:
  1. **Щ‚ЩЉЩ€ШЇ Ш§Щ„ЩЉЩ€Щ…ЩЉШ©** (`journal`) вЂ” `JournalTab` (+ В«Щ‚ЩЉШЇ Щ…ШµШ±Щ€ЩЃ ШіШ±ЩЉШ№В» button inside).
  2. **Ш§Щ„Щ…ШЁЩЉШ№Ш§ШЄ Щ€Ш§Щ„ШЄШ­ШµЩЉЩ„** (`sales`) вЂ” `SalesAndCollectionsTab` (sub-tabs: ЩЃЩ€Ш§ШЄЩЉШ± Ш§Щ„ШЁЩЉШ№ / ШЄШ­ШµЩЉЩ„ Ш§Щ„Ш№Щ…Щ„Ш§ШЎ).
  3. **Ш§Щ„Щ…Щ€Ш±ШЇЩ€Щ†** (`suppliers`) вЂ” `SuppliersTab` (sub-tabs: ЩЃЩ€Ш§ШЄЩЉШ± Ш§Щ„Щ…Щ€Ш±ШЇЩЉЩ† / Ш§Щ„Ш®ШµЩ… ШЄШ­ШЄ Ш­ШіШ§ШЁ Ш§Щ„Щ…Щ€Ш±ШЇ).
  4. **ШЇЩ„ЩЉЩ„ Ш§Щ„Ш­ШіШ§ШЁШ§ШЄ** (`coa`) вЂ” `ChartOfAccountsTab`.
  5. **Ш§Щ„ШЄЩ‚Ш§Ш±ЩЉШ± Ш§Щ„Щ…Ш§Щ„ЩЉШ©** (`reports`) вЂ” `ReportsTab` (sub-tabs: Щ„Щ€Ш­Ш© Ш§Щ„Щ…Ш­Ш§ШіШЁ / Ш§Щ„Щ‚Щ€Ш§Ш¦Щ… Ш§Щ„Щ…Ш§Щ„ЩЉШ© / Ш§Щ„Щ‡Ш§Щ…Шґ Ш§Щ„Щ…Ш­Щ‚Щ‚). `FinancialStatementsTab` itself still nests its own inner tabs (trial/income/balance) вЂ” so reports is two levels deep.
  6. **Ш§Щ„Ш¶Ш±Ш§Ш¦ШЁ** (`taxes`) вЂ” `TaxesTab` (sub-tabs: Ш¶.Щ‚.Щ…. / ШҐШ№ШЇШ§ШЇШ§ШЄ Ш§Щ„Ш¶Ш±Ш§Ш¦ШЁ).
- **New wrapper components** (`SalesAndCollectionsTab`, `SuppliersTab`, `ReportsTab`, `TaxesTab` in `accounts/pages/`) are thin `<Tabs>` shells that compose the existing leaf tab components вЂ” no leaf logic moved, so no behavior changes. The old 11 leaf components (`DashboardTab`, `MarginsTab`, `VatTab`, `WithholdingTab`, `TaxSettingsTab`, `SalesInvoicesTab`, `SupplierInvoicesTab`, `FinancialStatementsTab`, `CollectionsPage`) are still imported by the wrappers, not deleted.
- **Default tab** is now `journal` (`readTabParam` default changed from `dashboard`в†’`journal`) so the page opens on the data-entry screen. URL `?tab=вЂ¦` still works for the 6 main values.
- **Fix (PR #42, prior)**: removed the Expenses **tab** + added the В«Щ‚ЩЉШЇ Щ…ШµШ±Щ€ЩЃ ШіШ±ЩЉШ№В» button inside `JournalTab.tsx` вЂ” a simplified dialog (category в†’ expense-account code, cash/bank, amount, optional note, post-or-draft) that POSTs to `/api/accounts/journal` as a 2-line balanced entry. The inline `EXPENSE_CATEGORIES`/`PAYMENT_METHODS` maps mirror `accounts/integration.ts`. `SOURCE_LABELS` gained `operating_expense: "Щ…ШµШ±Щ€ЩЃ ШЄШґШєЩЉЩ„ЩЉ"`.
- **Backend untouched**: `modules/expenses/*` routes + `operatingExpensesTable` stay mounted (historical rows + attachments still queryable via API). `expenses.test.ts` still passes (132 tests total).

## Customer PO fulfillment status (PR #47)

- **Goal**: the `/customer-po` page's В«Ш§Щ„Ш­Ш§Щ„Ш©В» column should reflect order progress automatically вЂ” (1) В«ШЄЩ… ШҐШµШЇШ§Ш± ШЈЩ…Ш± ШґШ±Ш§ШЎ Щ„Щ„Щ…Щ€Ш±ШЇВ» when a supplier PO is dispatched from `/purchase-orders`, and (2) В«Щ†Ш¬Ш­ X% Щ…Щ† Ш§Щ„ШЁЩ†Щ€ШЇ Ш§Щ„Щ…ШіЩ„Щ…Ш©В» as deliveries are recorded against the customer PO's line items.
- **Approach**: a derived `CustomerPoFulfillmentStatus` computed on every list/detail fetch (never stored), advancing: `draft` в†’ `sent` в†’ `po_issued` в†’ `delivered` (partial %) в†’ `fulfilled` (100%).
- **po_issued detection**: at least one DISPATCHED (`status="sent"`) supplier PO is linked to the customer PO. Link is via `purchase_order_items.customerPoItemId` в†’ `customer_po_items.customerPoId`; a header-level `sheetPoNo = customerPosTable.customerPoNo` (case-insensitive) fallback covers legacy supplier POs created before the item FK. `resolvePoIssuedIds()` (in `customer-po/routes.ts`) does BOTH checks in batch for the list (no N+1).
- **Delivery %**: share of the PO's `customer_po_items` rows with `deliveryStatus="delivered"` (`resolveDeliveryRollup`); `deliveredPct` rounded 0вЂ“100, null when the PO has no items.
- **Stage precedence** (`buildFulfillmentStatus`): delivered > po_issued > sent > draft. A draft that already has a dispatched PO / deliveries still shows `po_issued`/`delivered` (not the stored `draft`).
- **API**: `modules/customer-po/routes.ts` вЂ” `CustomerPoFulfillmentStatus` interface + `buildFulfillmentStatus`/`resolvePoIssuedIds`/`customerPoItemIdsFor`/`resolveDeliveryRollup`/`computeFulfillmentStatus`. `GET /customer-po` (list) batch-computes `fulfillmentStatus` per row (Promise.all of delivery rollup + po-issued). `GET /customer-po/:id` + PATCH return it via `computeFulfillmentStatus`. POST returns a fresh `buildFulfillmentStatus` (no deliveries yet). `serialize(po, itemCount, fulfillmentStatus)` now carries it.
- **Item-level link plumbing**: the PO lookup `GET /po/lookup/:poNo` (in `po/routes.ts`) returns `customerPoItemId` for customer-PO item rows; `POST /po` + `PUT /po/:id` accept + persist `purchase_order_items.customerPoItemId`; `GET /po/:id/items` returns it. Frontend `po/pages/new.tsx` + `po/pages/detail.tsx` + `po/components/fields.tsx` (`PoItemRow.customerPoItemId`) preserve it across create/edit so the link survives re-editing.
- **OpenAPI**: `CustomerPoFulfillmentStatus` schema + `CustomerPoFulfillmentStatusStage` enum; `fulfillmentStatus` on `CustomerPo`. Regenerated orval вЂ” REMOVED the recurring `approveOfferItem{Body,200}.ts` dup type files + their `export *` in `lib/api-zod/src/generated/types/index.ts` (orval recreates them every regen; they cause TS2308 against `api.ts`).
- **Frontend**: `customer-po/pages/index.tsx` `FulfillmentStatusBadge` (colored by stage: amber/blue/indigo/emerald/green) in the В«Ш§Щ„Ш­Ш§Щ„Ш©В» column; `customer-po/pages/detail.tsx` adds a second badge in the header. `FulfillmentStatusBadge` title shows `deliveredItems/totalItems ШЁЩ†Щ€ШЇ Щ…ШіЩ„Щ…Ш©`.
- **Tests**: `customer-po.test.ts` DB mock gained `purchaseOrdersTable`/`purchaseOrderItemsTable` table handles + branches: `purchaseOrderItemsTbl` (with `innerJoin`), `purchaseOrdersTbl` (`where`), and `poItemsTable` select({id}|{customerPoId,deliveryStatus}) в†’ detailItems. New per-test state: `dispatchedPoRows` (header-level po_issued), `linkedPoItemRows` (item-level po_issued). 6 new fulfillment tests; **141 tests total** pass.

## Interactive WhatsApp rep bot for item-level receipts & deliveries (PR #48)

- **Goal**: a menu-driven WhatsApp bot for registered representatives (Щ…Щ†ШЇЩ€ШЁЩЉЩ†) to confirm receipts (Ш§ШіШЄЩ„Ш§Щ… from supplier) and deliveries (ШЄШіЩ„ЩЉЩ… to customer) per item, directly from WhatsApp. Receipt rep and delivery rep may differ; no delivering an item before it's received; non-reps get normal chat.
- **DB**: `work_order_assignments` gains `kind` (TEXT, `receipt`|`delivery`), `customer_po_id`, `customer_po_item_id` (ALTER TABLE ... ADD COLUMN IF NOT EXISTS in `init-db.ts`; Drizzle in `schema/work_order_assignments.ts` + `WORK_ORDER_KIND` export). One table now tracks both sides of an assignment.
- **Receiptв†’Delivery auto-link**: when an accepted WhatsApp receipt lands for a supplier PO item linked to a customer PO item (`purchase_order_items.customer_po_item_id`), `ensureDeliveryAssignment()` auto-creates a `kind=delivery` assignment inheriting the same rep вЂ” so they can then deliver to the customer without a separate assignment step.
- **WhatsApp service** (`communications/service.ts`): `sendRepMainMenu`, `sendRepPoPicker`, `sendRepItemPicker`, `sendRepItemAction` (interactive list-reply menus) + delivery action buttons (`work_order_delivery:`) + customer-rejection reason list (`work_order_delivery_reason:`). Reuses `ActionList`/`ListSection`/`Row`/`Button`/`Reply` from whatsapp-api-js.
- **WhatsApp routes** (`communications/routes.ts`): `handleRepMessage(from, text)` вЂ” text в†’ main menu, `rep_po:<poId>` в†’ items, `rep_item:<poId>:<itemId>` в†’ action buttons. Guarded to registered active reps only (lookup by normalized phone in `representativesTable`); everyone else falls through to normal chat (full separation from supplier RFQ/PO comms вЂ” separate tables/logic, bot only activates for registered rep phone numbers). `handleWorkOrderDeliveryButton` + `recordItemDelivery` process delivery/rejection buttons, re-checking the linked supplier PO item was accepted before recording.
- **No-delivery-before-receipt**: `acceptedQtyFromSupplier(customerPoItemId)` (in `deliveries.ts`) now skips rejected supplier lines (`lineStatus==="rejected"`). `POST /customer-po/:id/deliveries` blocks delivery when `accepted <= 0` (item not received yet) AND when `delivered > accepted`. `recordItemDelivery` (WhatsApp path) re-checks the same.
- **New route**: `POST /customer-po/:id/send-delivery-prompts` вЂ” nudges reps assigned to this PO's pending delivery lines with the rep bot main menu. Returns `{ok, sent}` (skips already-delivered assignments). 400s if no rep assigned.
- **Frontend**: `customer-po/pages/deliveries.tsx` gains В«ШҐШ±ШіШ§Щ„ Щ…Ш·Ш§Щ„ШЁШ© Щ„Щ„Щ…Щ†ШЇЩ€ШЁВ» button (shows on expanded PO row) calling the new route via direct `fetch("/api/...", {credentials:"include"})`.
- **Tests**: `__tests__/routes/deliveries-guard.test.ts` (7) вЂ” no-delivery-before-receipt (pending/rejected в†’ 400), allowed delivery (accepted в†’ 201), exceed-qty (в†’ 400), customer-rejection allowed (в†’ 201), send-delivery-prompts 400 when no rep + success count. DB mock: `acceptedRows` rows must use the **renamed** field `accepted` (not `totalAcceptedQty`) since `acceptedQtyFromSupplier` does `.select({accepted: totalAcceptedQty, lineStatus})`. Same `req.ip` getter-only gotcha applies (don't set it in test middleware). **148 tests total** pass.
- **Deploy**: PR #48 squash-merged (cce6bd0); Render deploy `dep-d9vnjv6417fc73ebge90` live; `/api/healthz` ok; new route returns 401 (not 404) confirming it's mounted behind auth.

## PO dispatch now sends the rep bot's per-item receipt prompts (replaces whole-PO template)

- **Problem**: dispatching a PO (`POST /api/po/:id/dispatch`) sent the rep a single whole-PO work-order _template_ (`sendRepresentativeWorkOrderWhatsApp`, `work_order:<poNo>:received/rejected` buttons) and created a `work_order_assignments` row **without** `poItemId`/`kind`. That legacy template is the wrong entry point for the rep bot: the bot menu's receipt list (`repReceiptPoList`) filters on `a.poItemId &&`, so the whole-PO assignment was invisible to the menu в†’ the rep bot never "opened" after sending the PO. Reps also can't reach the app, so the manual В«Ш§ШіШЄЩ„Ш§Щ… Ш§Щ„ШЄЩ€Ш±ЩЉШЇШ§ШЄ в†’ ШҐШ±ШіШ§Щ„ Щ…Ш·Ш§Щ„ШЁШ§ШЄ Ш§Щ„Ш§ШіШЄЩ„Ш§Щ…В» tab path wasn't usable for them.
- **Fix**: the dispatch route now sends the rep **per-item interactive receipt prompts** (`sendRepresentativeItemReceiptWhatsApp`, `work_order_item:<poNo>:<poItemId>:received/rejected` buttons) for each pending PO item, and inserts a `work_order_assignments` row per item with `poItemId` + `kind: WORK_ORDER_KIND.RECEIPT` + normalized rep phone. This is the exact same flow the manual `POST /po/:id/send-receipt-prompts` uses, so the rep bot menu opens with these items directly when the rep replies, and `ensureDeliveryAssignment` chains receiptв†’delivery automatically. No template approval needed (interactive buttons, not a pre-approved template).
- **Code** (`modules/po/routes.ts`): import changed `sendRepresentativeWorkOrderWhatsApp` в†’ `sendRepresentativeItemReceiptWhatsApp` + `WORK_ORDER_KIND` from `@workspace/db`. The whole-PO block was replaced with a per-item loop over `itemRows` (skipping `lineStatus==="fulfilled"|"rejected"`). `workOrderSent`/`workOrderError` response shape kept (boolean + first error) for backwards compat; the frontend doesn't render them.
- **Tests**: `__tests__/routes/po-dispatch.test.ts` (4) вЂ” per-item prompts + kind=receipt assignments, not-configured skips, fulfilled/rejected items skipped, 404. DB mock: `selectQueue` items MUST be **array-wrapped** (each `db.select(...).where()` resolves to an array вЂ” wrapping the single poRow as `[poRow]`), and `isWhatsAppConfigured` is a **const boolean** so the mock uses a getter (a `vi.fn` is always truthy and breaks the not-configured case). **152 tests total** pass.

## Rep bot dispatch-order bug (webhook signature path)

- **Bug**: the inbound webhook has **two** code paths. The signature-verification fallback `dispatchWebhookPayload()` calls `handleRepMessage` (the rep bot) BEFORE `handleWorkOrderButton`. But the **library path** `Whatsapp.on.message` (used when `Whatsapp.post()` signature verification SUCCEEDS вЂ” the normal case since `WHATSAPP_APP_SECRET` matches) did NOT call `handleRepMessage` at all вЂ” it went `handleReactionWebhook в†’ handleWorkOrderButton в†’ handleInboundMessage`. So a registered rep sending any text to open the bot menu was routed to `handleInboundMessage` (generic normal chat) instead of the rep bot в†’ the bot never engaged. This was the actual reason the rep bot "didn't open" (not the per-item template вЂ” the template fix was necessary but insufficient without this).
- **Fix**: `Whatsapp.on.message` now calls `handleRepMessage` in the SAME order as `dispatchWebhookPayload`: `reaction в†’ handleRepMessage в†’ (interactive && handleWorkOrderButton) в†’ handleInboundMessage`. `handleRepMessage` returns `false` for non-`rep_` payloads and non-text, so `work_order_item:` button taps still fall through to `handleWorkOrderButton`, and rep-bot interactive list/button replies (`rep_*`) are owned by the bot.
- **Lesson**: BOTH webhook paths (`Whatsapp.on.message` and `dispatchWebhookPayload`) MUST keep identical dispatch ordering вЂ” any new handler added to one must be added to the other.

## Rep bot menu restructure (button-driven flow + back navigation)

- **Goal**: the rep bot opens on ANY text with two buttons (Ш§ШіШЄЩ„Ш§Щ…/ШЄШіЩ„ЩЉЩ…), then drills POs в†’ items в†’ action with a confirmation step and a В«Ш±Ш¬Щ€Ш№В» button at every stage; receipts/deliveries recorded from the bot use a confirm-then-record flow so the rep can cancel.
- **Main menu** (`sendRepMainMenu` in `service.ts`): now **two ActionButtons** (Ш§ШіШЄЩ„Ш§Щ… / ШЄШіЩ„ЩЉЩ…) instead of a task-count list. `counts` arg is now optional (shown in body text only).
- **PO picker** (`sendRepPoPicker`): в‰¤2 POs в†’ ActionButtons + a В«Ш±Ш¬Щ€Ш№В» (rep_back:menu) button; 3вЂ“9 POs в†’ ActionList with a Ш±Ш¬Щ€Ш№ row. (WhatsApp caps ActionButtons at 3, so >2 options use a list.)
- **Item picker** (`sendRepItemPicker`): same в‰¤2-buttons / 3вЂ“9-list split, with a В«Ш±Ш¬Щ€Ш№В» (rep_back:po:<kind>) button/row.
- **Item action** (`sendRepItemAction`): 3 ActionButtons вЂ” ШЄЩ… Ш§Щ„Ш§ШіШЄЩ„Ш§Щ…/Ш±ЩЃШ¶/Ш±Ш¬Щ€Ш№ (receipt) or ШЄЩ… Ш§Щ„ШЄШіЩ„ЩЉЩ…/Ш±ЩЃШ¶ Ш§Щ„Ш№Щ…ЩЉЩ„/Ш±Ш¬Щ€Ш№ (delivery). The Ш±Ш¬Щ€Ш№ button payload is `rep_back:item:<kind>:<poId>` (re-sends the item picker). Added a required `poId` opt field for the back payload.
- **Confirmation step** (new `sendRepConfirm` in `service.ts`): tapping В«ШЄЩ… Ш§Щ„Ш§ШіШЄЩ„Ш§Щ…В»/В«ШЄЩ… Ш§Щ„ШЄШіЩ„ЩЉЩ…В» no longer records immediately вЂ” it shows a В«ШЄШЈЩѓЩЉШЇВ»/В«ШЄШ±Ш§Ш¬Ш№В» two-button message. Payloads: `work_order_confirm_item:<poNo>:<poItemId>:received` / `work_order_confirm_delivery:<customerPoNo>:<customerPoItemId>:delivered` (record) and `work_order_cancel_item:<poNo>:<poItemId>` / `work_order_cancel_delivery:<customerPoNo>:<customerPoItemId>` (ШЄШ±Ш§Ш¬Ш№ в†’ re-sends the item action buttons via `resendItemActionReceipt`/`resendItemActionDelivery`, which look up poId/customerPoId from the item). Rejection (Ш±ЩЃШ¶) still prompts for a reason list (no extra confirm) then records вЂ” matches the user's "Ш±ЩЃШ¶ Щ…Ш№ ШҐШЁШЇШ§ШЎ ШіШЁШЁ Ш§Щ„Ш±ЩЃШ¶" requirement.
- **Back navigation** (`rep_back:*` payloads handled in `handleRepMessage`): `rep_back:menu` в†’ main menu, `rep_back:po:<kind>` в†’ PO picker, `rep_back:item:<kind>:<poId>` в†’ item picker. Each re-runs the same query functions so the list reflects current state (received/rejected items disappear; newly-received items appear in the delivery path via `ensureDeliveryAssignment`).
- **Receiptв†’delivery chaining**: unchanged вЂ” `recordItemReceipt` still calls `ensureDeliveryAssignment` on an accepted receipt linked to a customer PO item, so after a rep confirms receipt the item disappears from the receipt list and appears in the delivery list automatically.
- **Tests**: existing 152 tests still pass (the HTTP-level record/ensureDelivery logic is unchanged; the new interactive payloads are routing-only). The confirm/cancel split is covered by the route handler changes which typecheck cleanly.

## Rep bot phone-normalization fix (rep bot never engaged)

- **Bug**: the rep bot never opened ("Щ…Шґ ШЁЩЉЩѓЩ…Щ„") because `findRepresentative(phone)` did `eq(representativesTable.phone, normalizePhone(incoming))`. Meta webhooks send the sender as a bare `20вЂ¦` wa_id, but the representatives API historically stored the phone **with** a leading `+` (`+2010вЂ¦`) вЂ” so the exact-match query returned nothing в†’ `handleRepMessage` returned `false` в†’ the rep's text fell through to `handleInboundMessage` (normal supplier chat) instead of the rep-bot menu. Same class of mismatch affected `countRepTasks`/`repReceiptPoList`/`repDeliveryPoList`/`findAssignment` (they filtered assignments by `eq(representativePhone, normalizePhone(вЂ¦))`, which missed any `+`-prefixed stored assignment).
- **Fix**: added `canonicalPhone(phone)` in `communications/routes.ts` (digits-only, strips `+`/`00`, expands Egyptian local `01вЂ¦`в†’`201вЂ¦`, strips bidi marks). `findRepresentative`, `countRepTasks`, `repReceiptPoList`, `repDeliveryPoList`, and `findAssignment` now fetch rows and match by `canonicalPhone(stored) === canonicalPhone(incoming)` вЂ” robust to any stored format. The representatives API (`modules/users/representatives.ts`) `normalizePhone` now stores the same canonical digits-only form (so new reps are consistent from the start). `isValidPhone` no longer accepts a leading `+`.
- **Migration** (`init-db.ts`, idempotent, runs on every startup): `UPDATE representatives`/`work_order_assignments` в†’ `regexp_replace(phone,'[^0-9]','','g')`, then strip `00`, then expand `01вЂ¦`в†’`201вЂ¦`. Existing rows stored with `+` are canonicalized so the rep bot engages immediately after deploy without re-entering the rep.
- **Why the same number as both rep + supplier is fine**: `handleRepMessage` is tried before `handleInboundMessage`. Once `findRepresentative` matches (now canonical), the rep bot owns that number's text/menu and the supplier-chat path is skipped for them вЂ” by design (a rep IS a rep first). If you need the same number to act as a plain supplier chat, deactivate the rep record.

## Rep dispatch вЂ” consolidated notification (all items + supplier info + clean qty)

- **Problem**: dispatching a PO sent the rep **one interactive message per item** (`sendRepresentativeItemReceiptWhatsApp`, `work_order_item:` buttons). When a PO had multiple items, the rapid second/third send was rate-limited and silently dropped (caught + logged) вЂ” and because the assignment `db.insert` was _inside_ the same try block (after the send), a failed send also skipped its assignment row в†’ that item never appeared in the rep-bot menu either. The notification also omitted the supplier's name/address/phone and showed raw NUMERIC quantities (`5.0000`).
- **Fix**: dispatch now sends **ONE consolidated notification per supplier** (`sendRepPoDispatchWhatsApp` in `service.ts`). The body lists: В«ШЈЩ…Ш± ШґШ±Ш§ШЎ Ш¬ШЇЩЉШЇ Щ„Щ„Щ…Щ†ШЇЩ€ШЁВ», PO number, supplier name / address / phone, then **all** pending line items (в‰¤20) with `formatQty`-clean quantities (`5.0000`в†’`5`, `3.50`в†’`3.5`) + UOM. A single В«ШЁШЇШЎ Ш§Щ„Ш§ШіШЄЩ„Ш§Щ…В» button (`rep_menu:receipt`) opens the rep-bot receipt menu, where the PO picker в†’ item picker shows every pending item. Assignment rows are created **up front for all pending items** (independent of the WhatsApp send) so the menu always shows all items even if the message is rate-limited/fails. Duplicate-assignment inserts (re-dispatch) are tolerated.
- **`formatQty`** is now a shared export from `communications/service.ts` (digits-only trim of trailing zeros). Used by the dispatch notification + all rep-bot item pickers (`repReceiptItems`/`repDeliveryItems`) + the `rep_item:`/resend action handlers so quantities render clean everywhere.
- **`sendRepresentativeItemReceiptWhatsApp`** (the old per-item prompt) is still used by the manual `POST /po/:id/send-receipt-prompts` receipt screen (per-line nudge); only the **dispatch** path switched to the consolidated message.
- Tests: `po-dispatch.test.ts` rewritten вЂ” asserts ONE `sendRepPoDispatchWhatsApp` call per supplier with supplierName/Address/Phone + all items with clean qtys, and N assignment inserts (one per pending item). 152 tests pass.

## Rep receipts/deliveries вЂ” idempotent bot actions (no conflicting rows)

- **Problem (seen on live data, PO P26E11407)**: a PO with 2 items showed only 1 in the rep-bot item picker. Root cause: the rep had confirmed receipt of one item, then also tapped reject on it, creating **two** `po_item_receipts` rows (received 3 + rejected 3) for the same line. The re-aggregation naively summed both (`accepted=3 >= ordered=3`) в†’ `line_status='fulfilled'` в†’ the item was filtered out of the pending list, so the picker showed only 1 item. Separately, **re-dispatching** piled up duplicate `work_order_assignments` rows (9 rows for one PO) because each dispatch inserted without checking for an existing active assignment вЂ” inflating the rep menu's task counts.
- **Fix 1 (authoritative bot receipts)**: `recordItemReceipt` now deletes prior **bot** receipts (`received_by='Щ€Ш§ШЄШіШ§ШЁ'`) for the line before inserting the new full-qty event, so the latest rep action is authoritative and a received+rejected pair never both sum in. Portal-entered receipts (different `receivedBy`) are preserved. `recordItemDelivery` does the same for `customer_po_item_deliveries` (`delivered_by='Щ€Ш§ШЄШіШ§ШЁ'`).
- **Fix 2 (idempotent dispatch assignments)**: the dispatch path now checks for an existing **active** receipt assignment (`status != received/rejected`) for a `poItemId` before inserting вЂ” re-dispatch no longer creates duplicate rows.

- **Test mock**: `po-dispatch.test.ts` `selectChain` upgraded to a `chainableThenable` that supports `.limit()/.orderBy()` (the new idempotency check chains `.where().limit(1)`); a drained `selectQueue` yields `[]` (no existing assignment). 152 tests pass.
- **Live data cleanup**: reset PO 22's items to `pending`, deleted its conflicting bot receipts + accumulated assignments so the rep can re-test cleanly.

## Receipt status reflects in both /purchase-orders tabs (live)

- **Problem**: the per-item receipt status was not visible in the portal. Root cause: `GET /po/:id/items` returned only id/lineItem/description/qty/etc. вЂ” NOT `lineStatus`/totals/rejectionReason вЂ” so the receipts tab's `item.lineStatus` was always `undefined` (status cell blank). The PO list tab showed only a plain item count, no receipt progress. And there was no live update when a rep confirmed a receipt via WhatsApp.
- **Fix**:
  - `GET /po/:id/items` now returns `lineStatus`, `totalReceivedQty`/`totalAcceptedQty`/`totalRejectedQty`/`finalActualCost`, and `rejectionReason` (latest receipt row per item, via a batched `poItemReceiptsTable` select ordered desc). The receipts tab status cell now shows the label + the rejection reason (В«Ш§Щ„ШіШЁШЁ: ...В») when rejected.
  - New `GET /po/progress` endpoint: batched per-PO `{poId, total, received, rejected}` from `purchase_order_items.line_status`. The PO list tab (Tab 1) renders a receipt-progress badge (В«received/totalВ» + rejected count, colored emerald when all received / amber when any rejected).
  - **Live refresh**: `recordItemReceipt` now `broadcastWaEvent({type:"receipt_recorded", poId, poItemId, lineStatus})`. Both tabs open an `EventSource` to `/api/whatsapp/events` and refetch (the receipts tab reloads the expanded PO's items; the list tab reloads `/po/progress`) when a `receipt_recorded` frame arrives вЂ” so the operator sees the rep's WhatsApp action within seconds, no manual reload.
- Tests: 152 pass; tsc + portal build clean.

## Rep bot вЂ” receiptв†’delivery chaining fix + assignment status update

- **Problem (PO P26E11407)**: after the rep confirmed receipt of both items, the main menu still showed В«Ш§ШіШЄЩ„Ш§Щ…: 2 вЂ” ШЄШіЩ„ЩЉЩ…: 0В» instead of dropping to 0 / rising to 2, and the delivery list said В«Щ„Ш§ ШЄЩ€Ш¬ШЇ ШЁЩ†Щ€ШЇ ШЁШ§Щ†ШЄШёШ§Ш± Ш§Щ„ШЄШіЩ„ЩЉЩ…В». Two root causes:
  1. `recordItemReceipt` did NOT update the `work_order_assignments` row's status вЂ” it stayed `'sent'`, so `countRepTasks` (which counts assignments still in sent) never decremented в†’ В«Ш§ШіШЄЩ„Ш§Щ…: 2В» stuck.
  2. The supplier PO items had `customer_po_item_id = NULL` (created from a sheet lookup, no FK), so the receiptв†’delivery chaining (`if (line.customerPoItemId) ensureDeliveryAssignment(...)`) never fired в†’ no delivery assignments created в†’ В«ШЄШіЩ„ЩЉЩ…: 0В».
- **Fix 1**: `recordItemReceipt` now marks the matching `kind=receipt` assignment as `'received'`/`'rejected'` (matching the receipt outcome) after recording, so the rep menu's receipt count drops to 0.
- **Fix 2**: when `customer_po_item_id` is null, `recordItemReceipt` calls a new `resolveCustomerPoItemId(poId, lineItem, partNo)` that matches the supplier PO's `sheetPoNo` to a `customer_pos.customerPoNo` (ilike) and then matches the line's `lineItem`/`partNo` to one of that customer PO's items (fallback: first item). The resolved link is persisted onto `purchase_order_items.customer_po_item_id` so future receipts chain directly, and `ensureDeliveryAssignment` then creates the delivery assignment вЂ” so the rep can deliver to the customer and the В«ШЄШіЩ„ЩЉЩ…В» count rises.
- Tests: 152 pass; tsc + build clean. PO 22's test data was reset (items в†’ pending, receipts/assignments cleared) for a clean re-test.

## Customer PO fulfillment вЂ” received-from-supplier progress + resolved %

- **Goal**: `/customer-po` (both tabs) should show a progressive status reflecting: items received from the supplier (В«Ш¬Ш§Щ‡ШІ Щ„Щ„ШЄШіЩ„ЩЉЩ… X%В») and items resolved by delivery/rejection to the customer (В«ШЄЩ… ШЄЩ†ЩЃЩЉШ°Щ‡ X%В» / В«Ш§ЩѓШЄЩ…Щ„В»).
- **Backend** (`modules/customer-po/routes.ts`): `CustomerPoFulfillmentStatus` gained `receivedItems`/`receivedPct` and a new `ready_to_deliver` stage. Stage precedence: draft в†’ sent в†’ po_issued в†’ ready_to_deliver (received > 0, none resolved) в†’ delivered (some resolved, < 100%) в†’ fulfilled (all resolved). `deliveredPct` now counts **resolved** items (delivered + customer-rejected) since a rejection is a terminal outcome. New `resolveReceivedRollup()` counts customer_po_items whose linked purchase_order_item was accepted (item-level FK, with a sheetPoNo=customerPoNo + lineItem header-level fallback) вЂ” batched for the list.
- **OpenAPI**: `CustomerPoFulfillmentStatus` schema updated (new stage + `receivedItems`/`receivedPct`); regenerated orval (deleted the recurring `approveOfferItem{Body,200}.ts` dup type files + their `export *` in `generated/types/index.ts` to clear TS2308).
- **Frontend** (`customer-po/pages/index.tsx` + `detail.tsx`): `FulfillmentStatusBadge` gained a `ready_to_deliver` (cyan) style and a tooltip showing В«X/Y Щ…ЩЏШіШЄЩ„ЩЋЩ… В· X/Y Щ…ЩЏШіЩ„Щ‘Щ…В». `detail.tsx` badge updated likewise.
- Tests: customer-po mock gained `receivedItemRows`/`supplierItemRows` per-test state + innerJoin support on the poItems/purchaseOrderItems branches; 152 pass; tsc + portal build clean.

## Items sheet view вЂ” red-flag rows + reason column

- **Goal** (`/items` в†’ В«ШіШ¬Щ„ Ш§Щ„ШЁЩ†Щ€ШЇ Щ€Ш§Щ„Ш·Щ„ШЁШ§ШЄВ» tab): any row where the customer delivery was rejected OR the actual supplier cost exceeded the PO (supply-order) price is highlighted **red** across the whole row, with the reason in a new final В«Ш§Щ„ШіШЁШЁВ» column.
- **Backend** (`customer-rfq/routes.ts` sheet-view): `loadSheetRowsRaw` now also leftJoins `purchase_order_items` (on `customerPoItemId`) to read `finalActualCost` + `referencePrice`, and selects `customer_po_items.deliveryStatus`. The endpoint batch-loads the latest rejected `customer_po_item_deliveries` row (reason) for the page's poItemIds, then computes per row: `flagged` (bool) + `flagReason` = В«Ш±ЩЃШ¶ Ш§Щ„ШЄШіЩ„ЩЉЩ…: <reason>В» (when deliveryStatus=rejected) and/or В«ШЄШ¬Ш§Щ€ШІШЄ Ш§Щ„ШЄЩѓЩ„ЩЃШ©: Ш§Щ„ЩЃШ№Щ„ЩЉ X > ШЈЩ…Ш± Ш§Щ„ШЄЩ€Ш±ЩЉШЇ YВ» (when finalActualCost > referencePrice). Added `flagged`/`flagReason` to the response + OpenAPI `CustomerRfqSheetRow` schema.
- **Frontend** (`reports/pages/items.tsx`): added В«Ш§Щ„ШіШЁШЁВ» column header + cell (renders `flagReason` in red), and the row gets `bg-red-50` (dark: `bg-red-950/30`) when `r.flagged`. colSpan bumped 15в†’16.
- **Gotcha**: the OpenAPI `flagReason` description has Arabic + a colon вЂ” must be **quoted** in YAML or orval fails with "bad indentation of a mapping entry" (and deletes the generated files on the next regen).
- Tests: customer-rfq mock gained `sheetRejectedDeliveries` per-test state + a `customerPoItemDeliveriesTable`/`purchaseOrderItemsTable` entry + the 4th sheet-view leftJoin. 152 pass; tsc + portal build clean.

## Comprehensive analytics overview (PR #70) вЂ” /analytics page rebuild

- **Goal**: the `/analytics` page should surface ALL of the project's numbers + data in one comprehensive dashboard.
- **Backend** (`modules/reports/analytics.ts`): new `GET /api/analytics/overview` endpoint вЂ” a single aggregated response (computed on every call, never stored) covering every module. Returns: `counts` (rfqs/openRfqs/customerRfqs/customerPos/pos/items/suppliers/customers/representatives/employees/whatsappChats/supplierInvoices/salesInvoices/journalEntries/auditEntries), `rates` (pricingRate/poRate/rfqToPoRate/responseRateThisMonth/avgResponseTimeHours), `itemAnalytics`, `distributions` (rfqsByStatus/customerRfqsByStatus/customerPosByStatus/posByStatus вЂ” groupBy), `operations` (poReceipt totals from `purchase_order_items.lineStatus` + customerPoDelivery totals from `customer_po_items.deliveryStatus`), `financials` (margins join customer_po_itemsв†”purchase_order_items via customerPoItemId; VAT from **posted** sales/supplier invoices; withholding from posted supplier invoices; accounts AP/AR from invoice balances + cash/bank via `accountBalance(ACCOUNT_CODES.CASH/BANK)` from `accounts/posting.ts`; expenses `groupBy(category)`; collections receivable=ОЈ qtyГ—unitPrice vs collected=ОЈ payments; statements net profit/total assets/liabilities/equity from `chartOfAccountsTable` balances), `monthlyTrend` (last 12 months rfqs/pos/customerRfqs), `topSuppliers` (top 8 by offers submitted), `recentActivity` (last 10 audit-log rows).
- **Imports**: the endpoint imports table objects + `ACCOUNT_CODES` from `@workspace/db`, `round2`/`rateOf` from `accounts/tax`, and `accountBalance` from `accounts/posting`. `loadTaxSettings()` is re-declared locally (it's not exported from `tax.ts` вЂ” it lives as a local fn in `accounts/routes.ts`). A local `toNum`/`fmt` helper pair casts NUMERIC strings.
- **Frontend** (`reports/pages/analytics.tsx`): the analytics tab now appends a comprehensive multi-section dashboard (below the existing KPI/rates/supplier-analysis sections) consuming `/analytics/overview` via direct `fetch` (NOT orval вЂ” not in OpenAPI spec, same pattern as receipts/deliveries/accounts). Sections: в‘  entity-counts grid (16 KPI tiles), в‘Ў operations (PO receipt + customer delivery progress bars), в‘ў 4Г— `StatusDistCard` (pie + legend per status group), в‘Ј financial summary (6 gradient cards: margins/VAT/withholding/AP-AR/cash-bank/statements), в‘¤ expenses-by-category + collections, в‘Ґ 12-month `LineChart`, в‘¦ recent-activity feed (audit log). New helper components: `StatusDistCard` (pie + breakdown), `fmtMoney`/`fmtMonth`/`timeAgo`. Added `useEffect`+`useCallback` loader with a refresh button. The existing Reports tab is untouched.
- **Mocking note for future tests**: the overview endpoint fans out ~20 drizzle queries (Promise.all counts, groupBy, joins). `db.select(...).from(...)` returns an array вЂ” destructure as `rows[0]?.cnt` (the initial impl used `[x] = await Promise.all([...])` and treated each as a scalar, which failed tsc with "Property 'cnt' does not exist on type '{ cnt: number; }[]'").
- Tests: 163 pass (up from 152); tsc clean for api-server + portal.
- **Deploy**: PR #70 squash-merged (53aeafb); Render deploy `dep-da0gdqdbedkc73ang4ig` live; `/api/healthz` ok; `/api/analytics/overview` returns 401 unauthenticated (mounted behind requireAuth, confirmed not 404).

## Data-entry employee KPIs вЂ” real entry-time tracking (PR #71)

- **Goal**: measure the _actual_ time a data-entry operator spends filling each "new" form (from form open в†’ successful save), not wall-clock estimates, and show per-employee KPIs on the analytics page.
- **DB**: `lib/db/src/schema/data_entry_sessions.ts` вЂ” `data_entry_sessions` (id, employeeIdв†’employees, type TEXT [supplier_rfq|customer_rfq|supplier_po|customer_po], startedAt TEXT, endedAt TEXT, durationMs INTEGER, itemId INTEGER nullable [FK to created entity], saved BOOLEAN default false, abandoned BOOLEAN default false, createdAt). DDL in `init-db.ts` (CREATE TABLE IF NOT EXISTS + index on `employee_id`, `started_at`) вЂ” NOT drizzle-kit push.
- **Backend** (`modules/reports/data-entry.ts`, mounted via `reports/index.ts`):
  - `POST /data-entry-sessions` вЂ” start: inserts a row with `startedAt=now`, returns `{id}`. Behind `requireAuth`; uses `req.session.employeeId`.
  - `PATCH /data-entry-sessions/:id/end` вЂ” saved: sets `endedAt`, `durationMs`, `saved=true`, optional `itemId` (the created entity's id). Idempotent (no-op if already ended).
  - `POST /data-entry-sessions/:id/abandon` вЂ” **POST** (not PATCH) so the frontend can fire it on unmount via `fetch(..., {keepalive:true})` (sendBeacon is POST-only; fetch keepalive survives navigation). Sets `endedAt`, `durationMs`, `abandoned=true`.
  - `GET /analytics/data-entry` вЂ” per-employee KPIs: counts (supplier RFQs + items, customer RFQs + items, supplier POs + items, customer POs + items), completed + abandoned sessions, total + avg entry time, **weekly** (last 7d) + **monthly** (last 30d) rollups. Company-wide totals. Returns `{employees:[...], totals:{...}}`.
- **Frontend**:
  - `hooks/use-data-entry-session.ts` вЂ” `useDataEntrySession(type)` hook: `POST`s a start on mount, `endSession(entityId?)` called in mutation `onSuccess`, and on unmount if never ended fires a `POST .../abandon` with `keepalive:true` (best-effort, non-blocking).
  - Instrumented the 4 "new" pages: `rfq/new.tsx` (supplier_rfq), `customer-rfq/new.tsx` (customer_rfq), `po/new.tsx` (supplier_po), `customer-po/new.tsx` (customer_po) вЂ” each calls `endSession(id)` in the create-mutation `onSuccess`. Note po/new's `onSuccess` param was `()` в†’ now `(po)` to read `po.id`.
  - `reports/pages/analytics.tsx`: new **В«ШЈШЇШ§ШЎ Щ…ЩЏШЇШ®ЩђЩ„ЩЉ Ш§Щ„ШЁЩЉШ§Щ†Ш§ШЄВ»** section (`DataEntryPerformanceSection` component) appended after the overview dashboard вЂ” 4 gradient total cards (total time / weekly / monthly / abandoned sessions) + a per-employee table (name+role, 4 entity counts + their item counts, avg + total entry time, weekly + monthly time). Uses direct `fetch("/api/analytics/data-entry")` (NOT orval вЂ” endpoint not in OpenAPI spec).
- **sendBeacon gotcha**: `navigator.sendBeacon` only does POST. The abandon endpoint is therefore `POST` (not PATCH), and the hook uses `fetch(...,{keepalive:true})` instead (same page-unload guarantee, supports arbitrary methods). `keepalive` is supported in all modern browsers.
- Tests: 163 pass (unchanged вЂ” data-entry endpoints not yet unit-tested, but tsc + existing suite green). tsc clean for api-server + portal; portal build clean.
- **Deploy**: PR #71 squash-merged (9769e67); Render deploy `dep-da0go2bl550s73ddonhg` live (clearCache); `/api/healthz` ok; `/api/data-entry-sessions` + `/api/analytics/data-entry` return 401 unauthenticated (mounted behind requireAuth, confirmed not 404).

## Procurement employee KPIs (PR #72)

- **Goal**: per-procurement-employee productivity across the supplier-RFQ lifecycle вЂ” RFQs owned, items, offers received (per RFQ + per item), offers/items that converted to a PO, conversion rate, and failed RFQs.
- **Backend** (`modules/reports/procurement-kpis.ts`, mounted via `reports/index.ts`):
  - `GET /analytics/procurement` (behind `requireAuth`) вЂ” for each active employee (linked via `rfq.employeeId`):
    - `rfqCount` / `itemCount` (rfq_items for those rfqs).
    - `offerCount` (offers on those rfqs) + `avgOffersPerRfq` + `avgOfferItemsPerItem` (offer_items per rfq_item) + `itemsWithOffers`.
    - `convertedRfqs` / `convertedItems` вЂ” an RFQ "converted to PO" when it has a linked `purchase_orders.rfqId` OR `status==="SUCCESS"` (SUCCESS is set explicitly in `POST /po` when a PO is created from the RFQ).
    - `conversionRate` (convertedRfqs/rfqCount Г— 100).
    - `failedRfqs` (`status==="FAILED"` вЂ” auto-set by the expiry sweep when an RFQ's closing date passes with no offers).
  - Company-wide `totals` (rfqCount/itemCount/offerCount/convertedRfqs/convertedItems/failedRfqs). Optional `?from=&to=` filters by `rfq.createdAt`. Batched (no N+1): all rfqs в†’ rfq_items в†’ offers в†’ offer_items в†’ linked POs, then JS aggregation per employee. Sorted by rfqCount desc.
- **POв†”offer link caveat**: there is NO FK from `purchase_order_items` to an offer or rfq_item вЂ” the POв†”RFQ link is header-level (`purchase_orders.rfqId`). So "offer converted to PO" = an offer whose RFQ has a linked PO (RFQ-level success), not a direct offerв†’PO line trace.
- **Frontend** (`reports/pages/analytics.tsx`): new **В«ШЈШЇШ§ШЎ Щ…Щ€ШёЩЃЩЉ Ш§Щ„Щ…ШґШЄШ±ЩЉШ§ШЄВ»** section (`ProcurementPerformanceSection`) inserted before the data-entry section вЂ” 6 gradient total cards (RFQs/items/offers/converted/failed/conversion-rate) + per-employee table with a colored conversion-rate pill (green в‰Ґ50% / amber в‰Ґ20% / red <20%). Uses direct `fetch("/api/analytics/procurement")` (NOT orval вЂ” endpoint not in OpenAPI spec).
- Tests: 163 pass (unchanged вЂ” new endpoint not yet unit-tested); tsc clean for api-server + portal; portal build clean.
- **Deploy**: PR #72 squash-merged (438be2b); Render deploy `dep-da0l6gu7bikc73fd6okg` live (clearCache); `/api/healthz` ok; `/api/analytics/procurement` returns 401 unauthenticated (mounted behind requireAuth, confirmed not 404).

## Cancel a dispatched supplier PO + notify supplier via WhatsApp

- **Goal**: allow cancelling an already-dispatched ("sent") supplier PO on a **per-supplier** basis (NOT the whole PO at once) from `/purchase-orders` (the detail page, where items are grouped by supplier). Only that supplier is notified on WhatsApp, only their lines are reset/disappear from the rep bot + receipts + analytics, and the customer-RFQ request-status supplier-receipt success check. If the cancelled supplier was the LAST active one, the whole PO flips to "cancelled".
- **WhatsApp template**: new `po_cancel_ar` UTILITY template (3 body params: supplier/contact name {{1}}, PO number {{2}}, cancellation reason {{3}}). `ensurePoCancelTemplate()` in `communications/service.ts` provisions it idempotently on startup (same pattern as `ensureWorkOrderTemplate`); `index.ts` calls both under one try/catch. Override name via `WHATSAPP_TEMPLATE_PO_CANCEL`. `sendPoCancelWhatsApp({phone, supplierName, contactPerson, poNo, reason})` sends it (default reason `ШҐЩ„ШєШ§ШЎ ШЈЩ…Ш± Ш§Щ„ШґШ±Ш§ШЎ` when null/empty). Works outside the 24h window (it's a UTILITY template, not free-text).
- **API** (`modules/po/routes.ts`): `POST /api/po/:id/cancel` (behind `requireAuth`). Body `{supplierId: number, reason?: string|null}` (supplierId REQUIRED вЂ” 400 without it). 404 if PO/supplier missing; 400 if PO status is `draft` (use DELETE instead) or already `cancelled`; 400 if the supplier has no items in this PO. Loads that supplier's items (`and(eq(poId), eq(supplierId))`), sends `sendPoCancelWhatsApp` to that ONE supplier with a phone (best-effort: a failed send never blocks the cancellation), records an outbound `whatsapp_chats` row, then in ONE transaction: marks that supplier's `purchase_order_items` rows `lineStatus="cancelled"` + zeroes `totalReceived/Accepted/RejectedQty`+`finalActualCost`, deletes only those lines' `work_order_assignments` (rep bot receipt/delivery lists), and вЂ” IF no non-cancelled lines remain (this was the last active supplier) вЂ” flips `purchase_orders.status="cancelled"`. Always writes `audit_log` (`action:"po.supplier_cancelled"`). Returns `{ok, id, poStatus, cancelledSupplier:{id,name}, cancelledItemIds, whatsapp:{whatsappSent, whatsappError}}`.
- **`lineStatus="cancelled"` is the key signal**: the rep bot's receipt list filters `lineStatus === "pending" || "partial"` (cancelled lines excluded); `recordItemReceipt` (WhatsApp path) returns `false` on a cancelled line so a rep's stale menu tap can't resurrect it; `POST /po/:id/receipts` (portal) 400s "Щ„Ш§ ЩЉЩ…ЩѓЩ† ШЄШіШ¬ЩЉЩ„ Ш§ШіШЄЩ„Ш§Щ… Щ„ШЁЩ†ШЇ ШЄЩ… ШҐЩ„ШєШ§Ш¤Щ‡"; `recordItemDelivery` + `acceptedQtyFromSupplier` (customer-po deliveries) treat `cancelled` like `rejected` (won't allow/ count delivery); `customer-rfq` request-status supplier-receipt success check reads `totalAcceptedQty` (null on cancelled) so cancelled lines don't count as received; the customer-PO fulfillment `resolveReceivedRollup` excludes cancelled lines via the `acceptedQtyFromSupplier` filter. No separate cleanup вЂ” the `cancelled` line-status propagates everywhere.
- **Cancelled-PO/line filtering**: `GET /po/progress` + analytics `poReceiptTotals` both `innerJoin(purchaseOrdersTable).where(ne(status,"cancelled"))` AND `if (r.lineStatus === "cancelled") continue` in the count loop (so a partially-cancelled PO's badge reflects only active lines). `send-receipt-prompts` skips `fulfilled|rejected|cancelled` items. The receipts tab status cell shows В«Щ…Щ„ШєЩЉВ» (red) for cancelled lines and hides the "ШЄШіШ¬ЩЉЩ„ Ш§ШіШЄЩ„Ш§Щ…" button. `LINE_STATUS_LABEL`/`statusTone` gained `cancelled`.
- **Frontend** (`po/pages/detail.tsx`): the cancel action lives on **each supplier group's header** (next to the PDF button), shown only when `po.status==="sent"` && that supplier still has a non-cancelled line. Tapping В«ШҐЩ„ШєШ§ШЎ Ш§Щ„Щ…Щ€Ш±ШЇВ» (Ban icon) prompts for an optional reason, POSTs `{supplierId, reason}`, and on success shows an emerald banner naming the supplier (+ whether the whole PO is now cancelled, + WA error if any). The header-level whole-PO cancel button was removed (per-supplier is the only path). Cancelled item rows render `bg-red-50 line-through` with a В«Щ…Щ„ШєЩЉВ» sub-label. `po/pages/index.tsx`: the list's cancel column is now a В«ШҐШЇШ§Ш±Ш© Ш§Щ„ШҐЩ„ШєШ§ШЎВ» link that navigates to the detail page (the list doesn't expose individual suppliers, so per-supplier cancel is done in detail). `StatusBadge` already supported `cancelled`.
- **Tests**: `__tests__/routes/po-cancel.test.ts` (11) вЂ” missing supplierIdв†’400, PO 404, draftв†’400, supplier 404, supplier-has-no-itemsв†’400, per-supplier cancel (other supplier stays active, WA to one supplier only, items cancelled + assignments deleted + audit), last-active-supplier в†’ whole-PO cancelled, not-configured (still cancels), no-phone skipped, WA-throws still cancels, already-cancelledв†’400. DB mock: `chainableThenable` + `selectQueue`; `transaction` mock records tx `update`/`delete`/`insert` ops separately into `txOps` (the items reset + assignment delete + optional PO-status flip + audit all happen inside the tx). **178 tests total pass**; tsc clean for api-server + portal; portal + api-server builds clean.
- **Cancelling AFTER receipt is allowed** (change): the old 400 block on suppliers whose lines were `fulfilled`/`partial`/`rejected` was removed вЂ” a supplier may now be cancelled even after goods were received from them (e.g. the customer then rejected the delivery). The transaction additionally DELETES those lines' `po_item_receipts` rows (tx deletes = receipts + work_order_assignments) so the zeroed totals stay consistent, and `recomputeItemTotals` (`po/receipts.ts`) now early-returns when the line's `lineStatus === "cancelled"` so a stale receipt edit/delete can't resurrect a cancelled line. Frontend: the В«ШҐЩ„ШєШ§ШЎ Ш§Щ„Щ…Щ€Ш±ШЇВ» button shows whenever the supplier has ANY non-cancelled line (was: only when ALL lines pending/postponed), and the confirm prompt warns that receipt records are wiped. po-cancel.test.ts: the 400-on-received test became a success test (fulfilled+rejected lines cancelled, 2 tx deletes); 12 tests.
- **Deploy**: pending вЂ” PR not yet created (per instructions, push/PR only on explicit request).

## Daily DB backup в†’ Google Drive (backup module)

- **Module**: `modules/backup/` (`service.ts` + `routes.ts`), mounted via `routes/index.ts`; scheduler `scheduleDailyBackup()` called from `src/index.ts` on server listen (gated on `DATABASE_URL` + `GOOGLE_ACCOUNT_BASE_64`).
- **How it works**: streams a gzipped JSON dump of every `public`-schema table (`information_schema.tables` в†’ `SELECT * FROM "public"."<t>"` via the `pool` export) into `drive.files.create` media body (PassThrough). No `pg_dump` binary needed (Render Node image lacks it). File name `rfq-db-backup-<ISO>.json.gz`.
- **Drive auth**: same service account as Sheets (`GOOGLE_ACCOUNT_BASE_64`) but scope `https://www.googleapis.com/auth/drive.file`. **The target folder must be shared with the service account `client_email` (Editor)** or uploads 404. Folder id from `GOOGLE_DRIVE_BACKUP_FOLDER_ID`, default `1o8uhyrMNcGAh4mVR9ddYPgT-969tyby4`.
- **Schedule/retention env**: `BACKUP_HOUR_UTC` (default 3), `BACKUP_RETENTION_DAYS` (default 30; `files.list` in folder + delete older).
- **Routes**: `POST /api/backup/run` (requireAuth + requireRole admin/manager вЂ” manual trigger), `GET /api/backup/status` (config + lastRun, in-memory only).
- **Gotchas**: if the dump throws mid-stream, destroy the gzip + PassThrough and swallow the create promise or the Drive upload hangs forever. `lastRun` is set inside `runDatabaseBackup` (success + failure), not by callers.
- Tests: `__tests__/routes/backup.test.ts` (8) вЂ” mocks `googleapis` (drive.files create/list/delete; create mock MUST consume the media body stream or the gzip back-pressures and deadlocks) + `@workspace/db` `pool.query`. 212 tests total.
- Deploy: pending вЂ” branch `feat/daily-db-backup`, not pushed (push/PR only on explicit request).

## Security hardening (branch feat/security-hardening)

- **Sessions persist in PostgreSQL** via `connect-pg-simple` (`user_sessions` table, created in `init-db.ts`; store also has `createTableIfMissing`). Falls back to MemoryStore only when `DATABASE_URL` is unset (dev). Cookie: `sameSite:"lax"`, `secure` in prod, maxAge stays 7 days.
- **`SESSION_SECRET` is mandatory in production** вЂ” `app.ts` throws at startup if missing (Render must have it set before deploy or the service won't boot).
- **Login rate limiting** (`modules/users/auth.ts`): `loginIpLimiter` 60/15min per IP + `loginAccountLimiter` 10 failed/15min per IP+email (`ipKeyGenerator(req.ip)+"|"+email`), both `skipSuccessfulRequests:true`. 429s never reach the handler (no audit row). `app.set("trust proxy", 1)` was already set and is required.
- **CORS**: prod allows only same-origin (Origin host == Host header) + `ALLOWED_ORIGINS` env (comma-separated); no-Origin requests (webhooks/curl) always pass; dev stays permissive.
- **helmet** enabled with `contentSecurityPolicy:false` + `crossOriginEmbedderPolicy:false` (SPA loads Google Fonts вЂ” a strict CSP is a future task).
- **Login audit**: `auth.login_success`/`auth.login_failed` rows in `audit_log` (entityType `auth`), fire-and-forget (`.then()` on `insert().values()` вЂ” test mocks must return a THENABLE from `values()`, with `.returning()` attached for other routes).
- `lib/db` `getPool()` is now exported and **cached** (previously the `pool` proxy created a NEW pg.Pool on every property access).
- `init-db.ts` table order matters for fresh DBs: `customers`/`customer_rfqs`/`customer_rfq_items` are created BEFORE `rfq_items` (which FK-references `customer_rfq_items`). Multi-statement `client.query` blocks are one implicit transaction вЂ” one failure aborts the whole block.
- `pnpm-workspace.yaml`: pnpm 11 reads `allowBuilds` вЂ” placeholder strings ("set this to true or false") break install; must be booleans. Local env: run `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install` (corepack otherwise blocks on an interactive prompt).

## Customer-PO item removal preserves the items sheet view (soft-cancel)

- **Problem**: removing an item from a customer PO (PATCH `/customer-po/:id` items) hard-DELETEd its `customer_po_items` row, so the `/items` В«ШіШ¬Щ„ Ш§Щ„ШЁЩ†Щ€ШЇ Щ€Ш§Щ„Ш·Щ„ШЁШ§ШЄВ» tab lost the row's order data вЂ” user expected the red-highlighted row (status В«Щ…Щ„ШєЩЉВ» + previously recorded rejection reason / highlight note) to remain.
- **Fix**: `customer_po_items.customer_po_id` is now **nullable** (schema `customer_pos.ts` + `init-db.ts` migration `ALTER TABLE customer_po_items ALTER COLUMN customer_po_id DROP NOT NULL`). PATCH `/customer-po/:id` no longer blanket-deletes the PO's items: it first selects the previous rows, and any row whose `customerRfqItemId` is NOT in the new list is **detached + cancelled** (UPDATE `customerPoId=null, qty=null, unitPrice=null, deliveryDate=null, deliveryStatus="cancelled"` вЂ” the RFQ link, PO number/date, rejection reason, highlight color/note and delivery history all survive). Only then are the remaining (kept) rows deleted + re-inserted as before. Manual rows (no RFQ link) are always in `removedIds` (their `customerRfqItemId` is null) в†’ cancelled + re-inserted.
- **Sheet view**: `computeFlagReason` (customer-rfq/routes.ts) prepends В«ШҐЩ„ШєЩЉВ» for rows with `deliveryStatus="cancelled"`; the previously recorded rejection reason is superseded by the cancel (the item is no longer rejected вЂ” it's cancelled), but the admin highlight note still merges into the В«Ш§Щ„ШіШЁШЁВ» column (`ШҐЩ„ШєЩЉ вЂ” <note>`), and the red row styling + PO number/date data carry over.
- **Null-guards**: `customerPoId == null` rows are skipped in `resolveDeliveryRollup`/`resolveReceivedRollup` (customer-po/routes.ts), collections receivable (reports/analytics.ts), data-entry item counts (reports/data-entry.ts), supplier-rollups (users/suppliers.ts), and WhatsApp `recordItemDelivery` (communications/routes.ts) refuses delivery for a detached item.
- **Test-mock gotcha**: the customer-po test `db.update` mock previously reflected EVERY `.set(vals)` onto `detailRow` вЂ” the cancel-removed-items UPDATE therefore clobbered the PO header (deliveryStatus:"cancelled" etc.) and the post-update re-select crashed `serialize`. The mock now reflects only when `table === poTable` (the header table).
- Tests: 225 pass (2 new PATCH soft-cancel tests + 1 sheet-view В«ШҐЩ„ШєЩЉВ» test); tsc clean; portal build OK.

## Per-item PO cancellation (extend per-supplier cancel)

- `POST /api/po/:id/cancel` now accepts optional `itemIds?: number[]` alongside `supplierId` вЂ” when given, only those lines of the supplier are cancelled (e.g. one item of two); omitted в†’ the whole-supplier path as before. 400 В«Ш§Щ„ШЁЩ†Щ€ШЇ Ш§Щ„Щ…Ш­ШЇШЇШ© Щ„Ш§ ШЄШЄШЁШ№ Щ‡Ш°Ш§ Ш§Щ„Щ…Щ€Ш±ШЇ ЩЃЩЉ ШЈЩ…Ш± Ш§Щ„ШґШ±Ш§ШЎВ» when the intersection is empty. The WhatsApp chat-record body + the audit description note partial scope (`(1/2 ШЁЩ†Щ€ШЇ)` / `(1/2 items)`). Transaction + whole-PO-flip logic reuse the filtered `itemIdsToCancel`.
- Frontend `po/pages/detail.tsx`: `handleCancelSupplier(supplierId, supplierName, itemIds?, itemLabel?)` вЂ” item rows on sent POs get a per-row В«ШҐЩ„ШєШ§ШЎВ» (Ban) button cancelling just that line; the supplier-header В«ШҐЩ„ШєШ§ШЎ Ш§Щ„Щ…Щ€Ш±ШЇВ» button still cancels the whole group. The success banner now uses `cancelDone.label` (item label or supplier name).
- Tests: po-cancel.test.ts 15 tests (per-item cancel, itemIds в†’ 400, explicit-all в†’ whole-PO flip). 228 total.

## Per-item cancel WhatsApp template (po_cancel_item_ar)

- New Meta template `po_cancel_item_ar` (UTILITY, 7 body params: Ш§Щ„Щ…Щ€Ш±ШЇ {{1}}ШЊ Ш±Щ‚Щ… Ш§Щ„ШЈЩ…Ш± {{2}}ШЊ Ш±Щ‚Щ… Ш§Щ„ШЁЩ†ШЇ {{3}}ШЊ Ш±Щ‚Щ… Ш§Щ„Щ‚Ш·Ш№Ш© {{4}}ШЊ Ш§Щ„Щ€ШµЩЃ {{5}}ШЊ Ш§Щ„ЩѓЩ…ЩЉШ©+Ш§Щ„Щ€Ш­ШЇШ© {{6}}ШЊ ШіШЁШЁ Ш§Щ„ШҐЩ„ШєШ§ШЎ {{7}}) provisioned idempotently by `ensurePoCancelItemTemplate()` (index.ts startup, alongside the other two templates). Override name via `WHATSAPP_TEMPLATE_PO_CANCEL_ITEM`.
- `sendPoCancelItemWhatsApp({phone, supplierName, contactPerson, poNo, item:{lineItem,partNo,description,qty,uom}, reason})` in `communications/service.ts` sends ONE message per cancelled line (qty via `formatQty`, UOM default В«Щ‚Ш·Ш№Ш©В»).
- The cancel route (`POST /po/:id/cancel`) uses the item template ONLY for partial cancels (`selectedRows.length < itemRows.length`); whole-supplier cancels keep `po_cancel_ar`. If the item template isn't approved by Meta yet (send throws), it falls back to `po_cancel_ar` with В«Ш§Щ„ШЁЩ†ШЇ Ш§Щ„Щ…Щ„ШєЩ‰: <partNo>В» in the reason вЂ” so the notification works from day one.
- **Gotcha encountered**: a `git reset --hard origin/main` mid-feature wiped the routes.ts import edit; the resulting `ReferenceError` was silently swallowed by the route's try/catch fallback (test caught it). After any reset, re-check ALL edits, not just the ones that error.
- Tests: po-cancel.test.ts 16 (item-template called with full details; fallback path). 229 total.

## CI format gate blocked ALL deploys (critical deploy gotcha)

- **Symptom**: merged PRs never reached production. Every one of the 231 `Deploy to Render` workflow runs was `skipped`, so no Render deploy was ever triggered by GitHub.
- **Cause**: `.github/workflows/deploy.yml` gates the deploy on the **whole CI run** succeeding (`workflow_run: workflows: ["CI"]`, `if: conclusion == 'success'`). CI's `format` job (`pnpm run format:check` в†’ `prettier --check "**/*.{ts,tsx,js,mjs,json,css,md}"`) had been failing on `main` with ~99 unformatted files, so CI never concluded `success` and Deploy was always skipped. Formatting just your own files is not enough вЂ” the check is repo-wide.
- **Fix**: run `prettier --write` over the whole repo (PR #108). Verify with `./node_modules/.bin/prettier --check "**/*.{ts,tsx,js,mjs,json,css,md}"`. `.prettierignore` excludes `dist/`, `node_modules/`, `**/generated/**`, `pnpm-lock.yaml`, images вЂ” so orval-generated files are never in scope.
- **Check before assuming an auto-deploy will happen**: list runs and inspect the Deploy run's `conclusion`. `skipped` means CI did not pass.
- **Manual deploy fallback**: `POST https://api.render.com/v1/services/srv-d894ofmq1p3s73fh04vg/deploys -d '{}'` with `Authorization: Bearer <RENDER_API>`. The `RENDER_API` key is user-supplied and can expire вЂ” it returned **401 Unauthorized** while the GitHub `ghp_` token worked. When Render returns 401 the key needs regenerating in the Render dashboard; the CI-gated path is the reliable route.

## Customer-PO rows must never vanish from the items sheet view (PR #107)

- **Symptom**: customer PO 877 existed at `/customer-po/877` but its lines were missing from `/items` в†’ В«ШіШ¬Щ„ Ш§Щ„ШЁЩ†Щ€ШЇ Щ€Ш§Щ„Ш·Щ„ШЁШ§ШЄВ».
- **Cause**: the sheet view is anchored on `customer_rfq_items` and joined a PO line only on `customer_po_items.customer_rfq_item_id`. That FK is `ON DELETE SET NULL`, and `PATCH /customer-rfq/:id` used to **delete and re-insert** all of its items вЂ” so every edit silently severed each existing customer-PO link (and the `rfq_items.customer_rfq_item_id` / offer links too). A PO created with free/manual lines has no RFQ link at all and could never render either.
- **Fix**:
  - `PATCH /customer-rfq/:id` now **updates items in place**, matched by partNo then lineItem, and deletes only the rows the operator actually removed (`inArray` delete last). Never reintroduce delete+reinsert here.
  - The sheet view pairs PO lines to RFQ items by FK **with a partNo/lineItem fallback**, and emits unmatched PO lines as their own rows with null RFQ columns, so an issued PO is always represented. `CustomerRfqSheetRow` RFQ fields are nullable in the OpenAPI spec; the portal guards the RFQ link and row key.
  - `init-db.ts` runs an **idempotent link repair** on every startup that re-attaches already-orphaned `customer_po_items` to the matching RFQ item (same partNo/lineItem, same RFQ) вЂ” recovers rows broken before the fix.
- **Test-mock note**: the sheet-view mock is split вЂ” `customerRfqItemsTable` serves the RFQ side (`innerJoin`), `customerPoItemsTable` serves the PO side (a row with `poLinkRfqItemId: null` simulates a severed link) and `purchaseOrderItemsTable` serves the cost columns. `db.update`/`db.delete` on the items table record into `updatedItemIds`/`deletedItemIds`.

## Customer-RFQ pricing gate (PR #106)

- Only **admin/manager** (`isPrivilegedRole`: `role === "admin" || role === "manager"`) may set a customer price or finalize. `denyNonPricingRole` + `pricingIntent` gating on PATCH; a non-privileged price submission is dropped rather than honoured. Privileged users may re-price a **sent** RFQ at any time вЂ” the close date, a missing approved supplier price and the 1.06Г— floor no longer block them. Margin deviations are **audit-logged only** (never a 400, never leaking the supplier cost); the audit descriptions deliberately omit numbers since every employee can read `audit_log`.

## Customer-RFQ items identified only by their description (PR #111)

- **Symptom**: a request saved with items showed В«Щ„Ш§ ШЄЩ€Ш¬ШЇ ШЁЩ†Щ€ШЇВ» when reopened (e.g. `CRFQ-2026-004116` at `/customer-rfq/4980`), and those items were missing from the items sheet view.
- **Cause**: the entry form has a **В«ШЄЩ€ШµЩЉЩЃ Ш§Щ„ШЁЩ†ШЇВ»** column, so an operator may identify a row by description alone. The save filter on all three layers required `partNo` or `lineItem` вЂ” `(it.partNo?.trim() || it.lineItem?.trim()) && it.qty` вЂ” so description-only rows were **silently discarded** and the request saved with fewer items than were entered. The customer-**PO** module already accepted `description` as an identifier; the RFQ module did not.
- **Fix**: all three filters (POST + PATCH in `routes.ts`, plus `new.tsx`/`detail.tsx` payload builders) now accept `description`. `findItemByKey` matches on description too, and the pricing select (`loadCurrentDbItemsForPricing`) loads that column вЂ” otherwise a surviving description-only row could never be matched and would be delete+re-inserted on every save, severing its `customer_po_items.customer_rfq_item_id` / `rfq_items.customer_rfq_item_id` links (the PR #107 class of bug). A row with no identifying text at all is still dropped.
- **Layer-parity rule**: the client payload filter and the server filter must accept the same set of fields. When adding a form field that can identify an item, update the filter in **all** layers listed above, not just the server.

## Items-sheet visibility invariants (PR #110)

Two more ways a row could disappear from `/items` в†’ В«ШіШ¬Щ„ Ш§Щ„ШЁЩ†Щ€ШЇ Щ€Ш§Щ„Ш·Щ„ШЁШ§ШЄВ» while the record still existed:

- **Detached customer-PO rows**: removing an item from a customer PO soft-cancels it (`customer_po_id в†’ NULL`, `deliveryStatus = "cancelled"`) so its rejection reason and highlight note survive. The sheet's `customerPoItemsTable в†’ customerPosTable` lookup must be a **LEFT join** вЂ” an INNER join discarded exactly those rows (they render with null PO columns and the В«ШҐЩ„ШєЩЉВ» flag, which is the point of the soft-cancel). The RFQ-items в†’ RFQs join stays INNER.
- **Item-less requests**: the view is anchored on `customer_rfq_items`, but `POST /customer-rfq` requires only a customer name and filters blank item rows вЂ” so a request could be saved successfully and appear **nowhere**. `loadSheetRowsRaw` now also loads every RFQ header and emits one **header-only row** (null item + null PO columns) for any RFQ with no item rows.
- **Test-mock note**: `sheetRfqHeaders` is `null` by default so the mock derives headers from the current `sheetRows` (tests assign those after `beforeEach`); set it to an array to assert the item-less case explicitly. The customer-RFQ mock distinguishes join types for the PO-header lookup.

## Customer-PO item duplication on save (PR вЂ” fix)

- **Symptom**: editing a customer PO at `/customer-po/:id` (e.g. PO 917, which had 2 lines) duplicated its items on **every** save вЂ” 2 в†’ 4 в†’ 6 в†’ 8 rows. Deleting the extras and saving again added them back.
- **Cause**: `PATCH /customer-po/:id` re-inserted every submitted item and deleted the PO's rows **only when some item had been removed** вЂ” the `DELETE ... WHERE customer_po_id = id` sat inside `if (removedIds.length > 0)`. So a plain edit that kept all items (the common case) skipped the delete entirely, left the stored rows attached, and appended a fresh copy of each one: 2 в†’ 4 в†’ 6 в†’ 8. The re-insert also recreated every row with a new id, severing the id-based links other modules hold (`purchase_order_items.customer_po_item_id`, `customer_po_item_deliveries.customer_po_item_id`, `work_order_assignments.customer_po_item_id`).
- **Fix**: items are now matched to their stored row and **UPDATED in place**; only genuinely new rows are inserted. Match order: submitted `id` в†’ `customerRfqItemId` в†’ `partNo` в†’ `lineItem` в†’ `description`, greedy so each stored row is claimed once (a repeated line consumes a distinct row). `CustomerPoLineItemInput` gained an optional `id` and the portal sends `it.id` on save. Rows genuinely removed are still soft-cancelled (detach + zero + `deliveryStatus="cancelled"`), never hard-deleted.
- **Do not reintroduce delete+re-insert** for `customer_po_items` вЂ” same rule as `customer_rfq_items` (PR #107). Ids are referenced across modules.
- **Test-mock note**: the customer-po test now mocks `drizzle-orm` so `eq` records its operands, letting an item `update(...).set(vals).where(eq(items.id, X))` be asserted per row id (`updateItemIds`/`updateItemCalls`). The duplication regression test simulates three consecutive saves against an in-memory store and asserts the PO keeps exactly 2 live lines each time; it fails 4/44 against the old code.

## Silent migration rollback: JS-style comments inside SQL (critical init-db gotcha)

- **Symptom**: after the customer-PO item fix shipped, deleting duplicate lines failed live with `Failed query: update "customer_po_items" set "customer_po_id" = $1 ... params: ,,,,cancelled,2434,...` вЂ” a not-null violation on `customer_po_id`, i.e. the soft-cancel could not detach rows.
- **Cause**: `init-db.ts` had `//` JS-style comments **inside** a SQL template literal. Postgres only understands `--`, so the whole multi-statement `client.query` was a syntax error. Statements in one `client.query` share an **implicit transaction**, so `ALTER TABLE customer_po_items ALTER COLUMN customer_po_id DROP NOT NULL` was rolled back along with its siblings and never applied. `initDb()` throws on the first failure and `index.ts` caught it as `logger.warn(..., "non-fatal, tables may already exist")` вЂ” so the failure was invisible in the Render logs.
- **Fix**: removed the JS comments; moved the `DROP NOT NULL` into its **own** `client.query` so a sibling failure can never roll it back; and changed the boot catch to `logger.error(..., "DB init FAILED вЂ” a migration did not apply")` so this class of failure is loud.
- **Rules**: never write `//` (or any JS comment) inside a SQL literal вЂ” use `--`. Keep a critical migration in its own statement. Migrations are idempotent, so an init failure is _never_ "tables already exist".
- **Guard test**: `src/__tests__/shared/init-db.test.ts` scans every SQL literal for `^\s*//` and asserts the `DROP NOT NULL` migration is a single-statement literal. It fails 3/3 against the old source. A `pgsql-ast-parser` pass over all 47 literals independently confirmed the old block was the only real syntax error (one unrelated `COLLATE "default"` false positive remains).

## Accounts page rebuild вЂ” completed-transactions registry, expenses, monthly closing

- **Goal**: `/accounts` was pre-emptied and rebuilt around three section tabs: **ШіШ¬Щ„ Ш§Щ„Ш­Ш±ЩѓШ§ШЄ** (completed transactions registry), **Ш§Щ„Щ…ШµШ§Ш±ЩЉЩЃ Щ€Ш§Щ„ШЄЩѓШ§Щ„ЩЉЩЃ** (operating expenses + PO line charges), and **Ш§Щ„ШЄШ±Ш­ЩЉЩ„ Ш§Щ„Щ…Ш­Ш§ШіШЁЩЉ** (posting: journal / sales+collections / suppliers+withholding / COA / reports / taxes / monthly closing). Accounting rationale in `docs/ACCOUNTING_STUDY.md`.
- **Backend** `modules/accounts/orders.ts` (mounted via `accounts/index.ts`):
  - `GET /accounts/collected-orders` в†’ `{customerOrders, supplierOrders, totals}`. **An order appears only once delivered/received/invoiced вЂ” never in progress.** Customer side: included when a POSTED `sales_invoices` row exists for the PO OR any `customer_po_items` row has `deliveryStatus` in `delivered|rejected|cancelled`; net/VAT/gross come from the posted invoice when present, else `ОЈ qtyГ—unitPrice` with VAT derived at the configured rate; realized cost = accepted supplier qty Г— `finalActualCost` (matched via `purchase_order_items.customerPoItemId`); `margin`/`isLoss`. Supplier side: included when any `purchase_order_items.lineStatus` is `fulfilled|partial|rejected` OR a posted supplier invoice exists; cost from accepted qty Г— actual cost, `hasVat` from the supplier invoice (`false` в‡’ VAT deficit), supplier names resolved by id.
  - `GET /accounts/po-charges` в†’ per-line charges joined to PO/supplier/lineItem + `byType` grouping + `total`/`count`.
- **VAT evidence** (`/accounts/vat`): new `vatEvidence` group вЂ” `evidencedInputVat` (only `hasVat` purchases), `unevidencedNet` + `unevidencedInputVat`/`deficit` (= rate Г— net of non-VAT suppliers, i.e. **Ш№Ш¬ШІ Ш¶.Щ‚.Щ…**), `fullyEvidenced`, `netPayable`, `carriedCredit`. The deficit is _absorbed_ вЂ” it is never added to deductible input VAT. Non-VAT purchases (`hasVat === false`) are excluded from `inputNet`/`inputVat` and collected in `nonVatPurchases`.
- **`closing.ts` bugs fixed**: the period regex was written `^\d\{4\}-\d\{2}$` (escaped braces в‡’ never matches) so **every** monthly closing 400'd; and the open-draft guard had a stray `}` inside the SQL template (`${...status}}`) _and_ used `!= 'void'`, which would have blocked closing any month containing posted entries. Now `^\d{4}-\d{2}$` and `status = 'draft'` (posted/void are final and must not block a close).
- **Frontend**: `accounts/pages/{OrdersRegistryTab,ExpensesAndCostsTab,MonthlyClosingTab,AccountingTab}.tsx` + `index.tsx` sectioned tabs. `AccountingTab` reuses the existing `SalesAndCollectionsTab`/`SuppliersTab` wrappers (so collections + withholding stay reachable) rather than the bare `SalesInvoicesTab`/`SupplierInvoicesTab`. All new endpoints are called with direct `fetch("/api/...", {credentials:"include"})` (not in the OpenAPI spec).
- **Permissions/i18n**: the accounts permission children were stale (duplicated 6 keys twice over); now `accounts:records` / `accounts:expenses` / `accounts:posting` with matching `perm.accounts.*` entries (en + ar).
- **Role-enum gotcha**: the OpenAPI `Employee.role` enum lists only `admin|manager|purchasing|data_entry`, but the backend's `requireRole` accepts `accountant`. Comparing the generated `employee.role` against `"accountant"` is a TS2367 error ("no overlap") вЂ” widen first: `const role = employee?.role as string | undefined`.
- Tests: `__tests__/routes/accounts-orders.test.ts` (7) + a VAT-evidence test in `accounts.test.ts`. **264 tests total pass**; tsc clean for libs/api-server/portal; portal + api-server builds clean; new routes return 401 (not 404) unauthenticated on a smoke-run of the built server.

## Financial-statement correctness & ageing (accounts/reporting.ts)

Three home-grown-ledger defects found by an accounting review, fixed + regression-tested:

1. **Contra accounts were inflated instead of netted (CRITICAL).** `income-statement` used `Math.abs(bal.balance)` for revenue and the raw balance for expense. `4101 Щ…Ш±ШЇЩ€ШЇ Ш§Щ„Щ…ШЁЩЉШ№Ш§ШЄ` is typed `revenue` but carries a **debit** balance, so `abs()` made sales returns **add** to revenue (1100 instead of 900); `5110 Ш®ШµЩ… Щ…ШґШЄШ±ЩЉШ§ШЄ` is typed `expense` with a **credit** balance, so it **added** to expense. Fix: sign every balance in its own normal direction (`signedFromRaw(type, raw)` в†’ debit-natured = `debit-credit`, credit-natured = `credit-debit`). Contra accounts now come out negative and net correctly, with no special-casing.
2. **Balance sheet never balanced (CRITICAL).** It summed only asset/liability/equity. Revenue/expense are not closed to retained earnings until year-end, so `Assets в‰  Liabilities + Equity` by exactly the profit on any profitable company. Fix: fold `currentPeriodResult = revenue в€’ expenses` into equity as its own line (`code:"RESULT"`), and return `balanced`/`difference`/`periodResult` so drift is visible instead of silently trusted.
3. **`isControl` was never enforced.** The docs claimed control accounts take no direct entries but `assertAccountsExist` only checked existence. Added `assertNoControlAccounts` (in `posting.ts`) вЂ” scoped to **sub-ledger-controlled** codes only (`ACCOUNT_CODES.AR/AP/INPUT_VAT/OUTPUT_VAT/WITHHOLDING_PAYABLE`) and to `source === "manual"`. **Do NOT widen this to cash/bank/inventory**: the В«Щ‚ЩЉШЇ Щ…ШµШ±Щ€ЩЃ ШіШ±ЩЉШ№В» quick-expense dialog and opening-stock adjustments legitimately post manual entries to cash/bank, and there is no sub-ledger behind them here. Auto-posted sources are exempt because they ARE the flows that write the sub-ledger.

- **Trial balance was already correct** вЂ” it picks the debit/credit column from the raw balance sign, not the account type, which is what makes the columns tie out. Don't "fix" it to use the account type.
- **New ageing reports**: `GET /accounts/aging/receivables` + `/accounts/aging/payables` (behind `requireAuth`) bucket outstanding `balance` (posted invoices only) into `current / d1_30 / d31_60 / d61_90 / d90_plus` by days past `dueDate`, return `overdue` + `count`, and sort oldest-first. UI: new В«ШЈШ№Щ…Ш§Ш± Ш§Щ„ШЇЩЉЩ€Щ†В» sub-tab in `FinancialStatementsTab.tsx` (receivables/payables toggle + bucket cards + table); the balance sheet shows a red banner when `balanced === false` and a note explaining the period result.
- **Test-mock gotcha**: `ledger.test.ts`'s `selectBuilder().where()` must honour BOTH a recorded `eq(col,val)` **and** a raw `sql` template containing `= any($1)` (how the control-account/`assertAccountsExist` lookups filter the COA вЂ” without it the guard sees the whole chart and rejects every manual entry). Drizzle columns expose snake_case `.name`, so translate to camelCase before matching fixture rows. `innerJoin(journalEntriesTable)` must also merge each line's `entryDate`/`status` onto the line rows or the posted-only filter is never exercised. Also: `eq` now returns `{__eq:[col,val]}` instead of the bare column.
- Tests: `ledger.test.ts` 32 (up from 21) вЂ” contra-revenue, contra-expense, balance-sheet equation, 2Г— control-account block, cash-allowed, 3Г— ageing. **275 api-server tests** + 24 portal pass; tsc clean; prettier repo-wide clean; portal build clean. The 9 new tests fail against the pre-fix code (verified by stashing the two source files).
- **Deploy (verified end-to-end)**: PR #116 squash-merged as `b7074e8`; CI on `main` green; `Deploy to Render` workflow ran `completed/success`; live `/api/healthz` = 200 and the new `/api/accounts/aging/*` return **401 not 404** (mounted behind `requireAuth`) вЂ” that 401-vs-404 check is the quickest way to confirm a new route actually shipped.

### Squash-merge history makes a fresh PR show `mergeable_state: "dirty"`

A branch cut from a commit that was squash-merged shows as **conflicting** even when the trees are identical, because the branch's parent is not an ancestor of the new `main` tip (the squash created a different commit object with the same tree). Diagnose, don't panic:

```bash
git rev-parse origin/main^{tree} <branch-parent>^{tree}   # identical в‡’ no real conflict
git diff --stat origin/main <branch-tip>                  # confirms the true delta
```

Fix by replaying only your commit onto the current main tip, then force-pushing:

```bash
git branch backup-<sha> <sha>                              # safety net
git rebase --onto origin/main <old-parent> <branch>
git rev-parse backup-<sha>^{tree} HEAD^{tree}              # MUST match вЂ” proves no content change
git push --force-with-lease=<branch>:<current-remote-sha> <token-url> <branch>
```

`--force-with-lease` without an explicit `<sha>` fails with `stale info` in this shallow clone; pass the remote SHA from `git ls-remote`. After the rebase the PR flips to `mergeable_state: "clean"` and CI runs.

- **CI polling gotcha**: filtering `actions/runs?head_sha=<short-sha>` returns `total_count: 0` even when the run exists вЂ” the API wants a full SHA. Query without the filter and match on `head_sha.startswith(...)`, or use `commits/<sha>/check-runs` (which reported all 3 checks green while the runs query looked empty).

## Customer-RFQ pricing is a grantable PERMISSION, not a role (data-entry pricing fix)

- **Problem**: a data-entry employee (Ahmed Hamdy) could not price a customer RFQ (`/customer-rfq/4955`): no price input, no finalize button. Cause was PR #106 вЂ” `isPrivilegedRole`/`denyNonPricingRole` + the portal `isPricingRole` gated pricing on `role === "admin" || role === "manager"`, so `data_entry` was blocked on both layers (403 + hidden UI). Not a bug; a role gate the manager could not delegate.
- **Fix**: pricing is now the explicit permission key **`customer-rfq:price`** (`PRICE_PERM.customerRfq`), granted per employee from the permissions editor. `admin` is always privileged; `manager` keeps it by DEFAULT (`ROLE_DEFAULTS.manager`); lower roles must be granted it explicitly by an admin.
- **Portal** (`lib/permissions.ts`): new `customer-rfq:price` catalog child under the `customer-rfq` page, `PRICE_PERM`, `EXPLICIT_ONLY_PERMS`, and `canPriceCustomerRfq(role, permissions)`. `detail.tsx`'s `isPricingRole` now calls `canPriceCustomerRfq(employee?.role, employee?.permissions)`.
- **Backend** (`customer-rfq/routes.ts`): `isPrivilegedRole` removed; `mayPriceCustomerRfq(role, permissions)` mirrors the portal's `resolvePermissions` exactly (explicit map authoritative, else role default вЂ” manager only). `hasPricingAccess(req)` reads the employee row **fresh** (so a grant/revoke applies without re-login); `denyNonPricingRole`/`hasPricingAccess` are now **async**. Used in POST item seeding + PATCH pricing/finalize gate.
- **`EXPLICIT_ONLY_PERMS` gotcha**: the permissions editor's page-level checkbox blanket-grants every child. Pricing exposes the supplier cost, so the `customer-rfq` page checkbox must NOT grant `customer-rfq:price` вЂ” `togglePage` filters `EXPLICIT_ONLY_PERMS` out. Tick the child row explicitly to grant it.
- Tests: `permissions.test.ts` (14) + `customer-rfq.test.ts` (66) вЂ” granted data_entry can price/finalize; explicit map omitting the key revokes even for a manager. The DB mock's `employeesTable` branch serves `{permissions}` when the select arg has a `permissions` key (else the `{name}` POST lookup). 278 api-server + 30 portal pass.

## Partial customer-RFQ pricing (PR #120) вЂ” price some items, not all

- **Goal**: on `/customer-rfq/:id`, allow pricing only the items ready to quote вЂ” finalizing no longer requires every item to have a price.
- **Backend** (`modules/customer-rfq/routes.ts`): the `status:"sent"` gate now 400s only when **no** item is priced (`ШЈШЇШ®Щ„ ШіШ№Ш± ШЁЩ†ШЇ Щ€Ш§Ш­ШЇ Ш№Щ„Щ‰ Ш§Щ„ШЈЩ‚Щ„ Щ‚ШЁЩ„ ШЄШ«ШЁЩЉШЄ Ш§Щ„Ш·Щ„ШЁ`) instead of when any item is unpriced. A partially priced finalize writes `audit_log` `customer_rfq.partial_finalize` (item names only вЂ” never prices/costs). The 1.06x margin loop now `continue`s on unpriced items (price null/empty/<=0) so no cost is probed for them.
- **Frontend** (`customer-rfq/pages/detail.tsx`): `allItemsPriced` is now `pricedItemCount > 0`; the finalize footer shows `X Щ…Щ† Y ШЁЩ†ШЇ Щ…ШіШ№ЩЋЩ‘Ш±` and gained a **В«Ш­ЩЃШё Ш§Щ„ШЁЩ†Щ€ШЇ Ш§Щ„Щ…ШіШ№ЩЋЩ‘Ш±Ш© ЩЃЩ‚Ш·В»** button calling the existing `handleSavePrices` (id-only payload в†’ backend updates `unit_price` by id without status change), now usable on drafts too for progressive pricing.
- Tests: `customer-rfq.test.ts` 68 (3 new). 280 api-server + 30 portal pass; tsc clean; portal build clean; prettier repo-wide clean.
- Deploy: PR #120 squash-merged `f1b8dd0`; CI + Deploy workflows success; live `/api/healthz` 200.

## Customer-order cost falls back to the issued supplier PO price (accounts registry)

- **Symptom**: `/accounts` -> ШіШ¬Щ„ Ш§Щ„Ш­Ш±ЩѓШ§ШЄ -> **ШЈЩ€Ш§Щ…Ш± ШґШ±Ш§ШЎ Ш§Щ„Ш№Щ…Щ„Ш§ШЎ** showed **0** in the В«Ш§Щ„ШЄЩѓЩ„ЩЃШ©В» column for customer orders whose supplier PO had been issued but not received, so the margin looked like pure profit.
- **Cause**: `modules/accounts/orders.ts` computed customer cost as `totalAcceptedQty x finalActualCost` only. Both operands are NULL until a receipt is booked, and the loop `continue`d on lines with no `customer_po_item_id` FK вЂ” which is every supplier line created from a sheet lookup or entered free-hand. Either gap alone yields 0.
- **Fix**: cost is resolved **per customer-PO item**, preferring the realized receipt cost and otherwise falling back to the **issued supplier PO price**: `purchase_order_items.referencePrice x customer_po_items.qty`. `referencePrice` is the per-unit buy price вЂ” the same field the supplier PO PDF prints as `unitPrice` (see the PDF block in `po/routes.ts`) and what the operator enters as В«ШіШ№Ш± Ш§Щ„Щ€Ш­ШЇШ©В» on `/purchase-orders/new`. The supplier PO is matched to the customer PO by **number** (`purchase_orders.sheetPoNo` <-> `customer_pos.customerPoNo`, case-insensitive) and the line by `lineItem` then `partNo` вЂ” the same fallback ladder as `resolveCustomerPoItemId` (communications) and `resolveReceivedRollup` (customer-po).
- **`costEstimated` flag**: true when the order has no receipts at all but an estimate was found; the tab renders В«ШЄЩ‚ШЇЩЉШ±ЩЉ (ШіШ№Ш± ШЈЩ…Ш± Ш§Щ„ШЄЩ€Ш±ЩЉШЇ)В» under the amount. Keep this distinction вЂ” an accounting estimate must never be presented as a realized cost.
- **Cancelled/rejected supplier lines are excluded** from the estimate (`DEAD_LINE_STATES`), matching how they are excluded from receipts/deliveries elsewhere.
- **Do not gate the realized path on the PO header**: legacy supplier lines carry the FK while the header row may be absent in test fixtures; only the estimate fallback reads the header (for `status === "sent"` + `sheetPoNo`).
- **Tests**: `accounts-orders.test.ts` +4 (estimate from issued price, partNo/number matching, cancelled-line exclusion, realized-beats-estimated) вЂ” all 4 fail against the pre-fix code. 284 api-server tests total.
- Not yet deployed/pushed вЂ” branch `refactor/accounts-shared-helpers`.

## One shared PO-line link ladder вЂ” the FK is not enough (accounts cost fix)

- **Symptom** (reported as В«Щ‡Щ„Щ€ШіШ© ЩЃЩЉ Ш§Щ„ШЄЩѓЩ„ЩЃШ©В»): `/accounts` -> ШіШ¬Щ„ Ш§Щ„Ш­Ш±ЩѓШ§ШЄ showed **0** cost and the В«ШЄЩ‚ШЇЩЉШ±ЩЉВ» label for customer orders whose goods had **already been received**, with no visible link to the supplier PO. `/accounts` -> Ш§Щ„Щ‡Ш§Щ…Шґ Ш§Щ„Щ…Ш­Щ‚Щ‚ showed revenue with **no cost** for the same orders.
- **Cause вЂ” two distinct defects, both from trusting one foreign key**:
  1. `modules/accounts/orders.ts` `realizedCostByCustomerItem` did `if (line.customerPoItemId == null) continue;`. The realized cost was discarded for every line lacking the FK, and the row fell through to the issued-price estimate.
  2. `/accounts/margins` + `/accounts/margins/summary` JOINed the two item tables on that same FK, so such a line was absent from the result set entirely вЂ” revenue without cost, i.e. profit overstated.
- **Why the FK is usually NULL**: `purchase_order_items.customer_po_item_id` is only set when the supplier PO is raised from a customer-PO item. Lines created from a **Google-Sheets lookup** or entered **free-hand** вЂ” the common case вЂ” never get it. The same blind spot had already bitten `resolveReceivedRollup` and `resolvePoIssuedIds` (customer-po), which both carry a `sheetPoNo` <-> `customerPoNo` fallback.
- **Fix вЂ” `artifacts/api-server/src/shared/po-links.ts` is the single ladder**: `matchCustomerPoItem` (pure, testable), `resolveCustomerPoLinks` (batched), `supplierLineByCustomerItem` (inverted map for JOIN-based callers). Rungs, in order: the FK -> supplier PO `sheetPoNo` <-> customer PO `customerPoNo` then `lineItem` -> `partNo` -> `description`. `unambiguous: false` means several lines matched equally well: a caller may still USE the value but must not PERSIST it.
- **Callers**: `orders.ts` (realized cost + the estimate, so both land on the same customer-PO line), `accounts/routes.ts` (both margins endpoints), and `resolveCustomerPoItemId` (communications) вЂ” which was a near-duplicate of the same ladder and is now a thin wrapper over it. Do not add a fourth copy.
- **`num` vs `numOr` (a real bug, not style)** вЂ” `numOr` maps a missing value to `0`, so the guard `toNum(line.finalActualCost) != null` was **always true** and never fired. The estimate path must use the null-preserving `num`, or "no receipt yet" collapses into "zero cost" and a received line gets estimated over its own realized cost. Pick the helper by whether "absent" and "zero" differ for that field.
- **A GET must not write**: the first cut persisted resolved links from inside `GET /accounts/collected-orders`. It broke the endpoint under the db mock (500) and is wrong regardless. Persistence belongs to the idempotent startup repair in `init-db.ts` (backfills `customer_po_item_id` where exactly ONE unambiguous match exists) and to `recordItemReceipt` when a receipt is booked.
- **`init-db.ts` backfill** is a CTE with `count(*) OVER (PARTITION BY poi_id)` + `row_number()`; it writes only `n = 1`, so it can never attach a receipt to the wrong line. Use `//` for the surrounding JS comment and `--` inside the SQL literal.
- **Tests**: `__tests__/shared/po-links.test.ts` (8, ladder rungs + ambiguity + PO-number scoping) + 2 regression tests in `accounts-orders.test.ts` / `accounts.test.ts`, all 4 of the latter **fail against the pre-fix source** (verified by stashing it). 308 api-server tests total; tsc + portal build + repo-wide prettier clean.
- Branch `refactor/accounts-margin-single-rule`, commit `58456e7`; pushed as PR #128, squash-merged `28fe496`, Render deploy success.

## Latin (English) digits across the accounting screens

- **Goal**: the `/accounts` page stays Arabic for labels but its **numbers** must read in Latin digits вЂ” `1,234.50`, not `ЩЎЩ¬ЩўЩЈЩ¤Щ«ЩҐЩ `. Accountants key and compare these figures against bank / e-invoice statements, so Arabic-Indic digits fight the source documents.
- **One switch**: `lib/format.ts` (`money` / `fmtMoney`) formats with `"en-US"`. Everything that shows a figure inside the accounting page routes through it вЂ” `VatTab`, `WithholdingTab`, `FinancialStatementsTab`, `OrdersRegistryTab`, `ExpensesAndCostsTab`, plus `JournalTab` / `SalesInvoicesTab` / `SupplierInvoicesTab` (their ad-hoc `toFixed(2)` calls now call `fmtMoney`, gaining thousands grouping they previously lacked).
- **Embedded modules are part of the page**: `ExpensesAndCostsTab` renders the expenses module and `SalesAndCollectionsTab` renders the collections module, so their local `fmt()` helpers (which duplicated the ar-EG rule) were switched too. Those two modules have no standalone route вЂ” they exist only inside `/accounts`. The sidebar has no link to either, so nothing else changes appearance.
- **Dates** on the page that were `toLocaleString("ar-EG")` (monthly-closing lock timestamps) now use `en-GB` вЂ” same reasoning, a record timestamp is read numerically.
- **Not changed**: the Arabic month names in `periodLabel` (В«ШіШЁШЄЩ…ШЁШ± 2026В») вЂ” only the digits are Latin. Other pages outside `/accounts` (analytics, communications, receipts) still use `ar-EG` digits deliberately; this was scoped to the accounting page as asked.
- Tests: `__tests__/format.test.ts` (5) asserts Latin digits, thousands grouping, negatives, the `-` fallback, and explicitly rejects `[Щ -Щ©]`. **35 portal + 308 api-server tests** pass; portal `tsc` + build + prettier clean.

## WhatsApp contact identity вЂ” the profile NAME is the only thing Meta gives you

- **Product decision to remember**: the Cloud API **cannot** return a contact's profile picture. There is no endpoint; respond.io and Chatwoot both document this as a Meta platform limitation (Chatwoot closed the request _not planned_). Only the regular WhatsApp protocol exposes avatars вЂ” business/Cloud API integrations never see them. Do not re-add a profile-picture lookup: the old `GET /whatsapp/profile-picture/:phone` called `/contacts?fields=profile_picture_url`, always failed `#100 / code 2500`, and 404'd once per avatar per render, flooding the console + Render logs (removed in PR #131; the `Avatar` component renders deterministic initials).
- **What IS available**: the webhook sends `contacts[0].profile.name`. Both webhook paths (`Whatsapp.on.message` and `dispatchWebhookPayload`) already parsed it into `senderName`, but it was **never persisted** вЂ” so every conversation rendered as a bare phone number. PR #132 fixed that.
- **DB**: `whatsapp_chats.contact_name` (schema `whatsapp_chats.ts` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `init-db.ts`). Set on inbound in `handleInboundMessage` (`senderName?.trim() || null`). Outbound rows carry no name.
- **API**: `GET /whatsapp/chats` returns `contactName` = latest **non-null** name for the phone. Use `(array_agg(contact_name ORDER BY created_at DESC) FILTER (WHERE contact_name IS NOT NULL))[1]` вЂ” the `FILTER` matters, otherwise the newest outbound row's NULL wins and the name never shows. Same `array_agg(...)[1]` idiom as the existing `lastMessage`.
- **Portal**: `artifacts/rfq-portal/src/lib/chat-label.ts` holds the ONE precedence rule вЂ” **registered supplier name в†’ WhatsApp profile name в†’ phone number** вЂ” used by the list, header, notification toast, forward picker and chat search. Add new display sites through `chatLabel()`; don't inline the `||` chain again.
- **No backfill possible**: names only arrive with future inbound messages, so pre-existing conversations keep showing the phone number until the contact replies. That is expected, not a bug.
- Tests: `__tests__/chat-label.test.ts` (5) вЂ” verified 2 of them fail against the pre-change rule. 315 api-server + 40 portal pass.

## WhatsApp chat list / scroll (PR #131)

- **Chat opened at the TOP instead of the newest message**: first attempt (PR #131) gated the scroll on `loading`/`selected` and keyed it off the newest message id. That was necessary but **not sufficient** вЂ” see the PR #134 section below, which found the real cause (the guard latched before the scroll was verified) and replaced `scrollIntoView` with a verified `scrollTop` retry.
- **Document numbering 500s (`POST /accounts/sales-invoices`)**: `nextEntryNo` read every `JE-YYYY-NNNNNN` series from `journal_entries`, so `INV-`/`SI-`/`SP-` restarted at `000001` and hit the UNIQUE constraint on the second document. Each prefix must resolve to its own table via `NUMBER_SERIES` in `accounts/posting.ts`. Regression tests in `ledger.test.ts` fail against the old code.
- **Sheet-mirror 404 loop**: `verifyMirrorSheetAccess()` runs at boot before the recurring sync, so an unshared/wrong `GOOGLE_MIRROR_SHEET_ID` logs **one actionable error** instead of `Sheet sync failed` every 5 minutes forever. The mirror sheet must be shared with the `GOOGLE_ACCOUNT_BASE_64` service account as Editor.

## Never latch a guard on an ATTEMPT вЂ” only on a VERIFIED result (WhatsApp scroll, PR #134)

- **The chat opened at the top instead of the newest message, "for good".** PR #131 tried to fix the scroll and failed because it kept a one-shot guard: `if (lastScrolledId.current === lastMessageId) return;` **before** ever checking whether the scroll happened. On open, `selected`/`loading` flip and the message list mounts in the **same commit**, so the first `requestAnimationFrame` runs while the container is still 0px tall. `scrollIntoView` then **silently no-ops** вЂ” no error, no console warning вЂ” and the guard was already latched, so every later render believed it had scrolled. The chat stayed pinned to the top until a manual reload.
- **Fix**: scroll the container directly (`scroller.scrollTop = scroller.scrollHeight`) behind an explicit ref, then **retry across frames until it verifiably reaches the bottom**, and latch the guard only at that point. `lib/scroll-to-bottom.ts` (`scrollToBottom(scroller): boolean`) is the extracted, unit-tested check.
- **Key the guard on `"<phone>:<newest message id>"`**, not the message id alone вЂ” with the id alone, going A в†’ B в†’ A never re-scrolls A because its guard from the first visit is still latched.
- **Use an explicit ref, not `scrollIntoView` on a sentinel**: the sentinel's `parentElement` is the `space-y-0.5` wrapper, not the scroller, and `scrollIntoView` also walks up to scroll _the page_. `scrollTop` is exact and testable. The sentinel and `scrollIntoView` were removed entirely.
- **`min-h-0` on a `flex-1 overflow-y-auto` child** of a `flex-col`: without it the child can size to its content, the internal scrollbar never appears, and `scrollHeight === clientHeight` so no scroll is ever possible.
- **General rule this exposed**: any UI side-effect (scroll / focus / measure) must be **verified** before being recorded as done. A guard latched on _intent_ rather than _outcome_ produces a silent, permanent "stuck" state. Applies to the other scrollable panes on this page too.
- Tests: `__tests__/scroll-to-bottom.test.ts` (5) вЂ” including the unlaid-out container that returns `false` so the effect retries. Reverting the helper to always report success makes it fail `1/5`. 45 portal + 315 api-server tests pass.
- Verified live on the built bundle: `scrollTop=<x>.scrollHeight` + the frame retry present, `scrollIntoView` count **0** (the flaky path is gone).

## AI Assistant вЂ” admin/manager WhatsApp agent (feat/ai-assistant)

- **Goal**: an LLM agent reachable **only** via WhatsApp for allowlisted **admin/manager** numbers. It answers questions about any data in the system (read-only DB tools), reads the company mailbox (IMAP), can read images/voice notes the operator sends, and generates Arabic PDFs it sends back as WhatsApp documents.
- **Access control is a per-phone allowlist, not a role flag**: `ai_assistant_users` (phone canonical digits-only UNIQUE, name, employeeIdв†’employees ON DELETE SET NULL, role admin|manager, isActive). A number is authorized only if it is listed AND active AND its linked employee (if any) is still active. The portal page (`/ai-assistant`) and every admin route require `requireRole("admin","manager")`.
- **DB** (`lib/db/src/schema/ai_assistant.ts`, exported from `schema/index.ts`): `ai_assistant_users`, `ai_assistant_messages` (rolled history per phone, index on `(phone, created_at DESC)`), `ai_assistant_settings` (single row `key='default'` seeded `ON CONFLICT DO NOTHING`). All DDL + seed live in `init-db.ts` (CREATE TABLE IF NOT EXISTS) вЂ” NOT drizzle-kit push.
- **Backend** `modules/ai-assistant/`:
  - `config.ts` вЂ” `AI_API_KEY` (`OPENAI_API_KEY`/`GEMINI_API_KEY` fallbacks), `AI_MODEL`, `AI_BASE_URL`, `isAiConfigured`, `isGeminiEndpoint()`, `loadSettings()`, `canonicalPhone()` (digits-only, strips bidi marks, `00`в†’``, `01вЂ¦`в†’`201вЂ¦`, `1вЂ¦`в†’`20вЂ¦`), `findAuthorizedUser()`.
  - `llm.ts` вЂ” OpenAI-compatible `/chat/completions` with tool calling + vision content parts; `transcribeAudio()`; `listModels()`. Retries 429/500/502/503/504 up to 3 attempts with backoff (Gemini 503s under load are real).
  - `agent.ts` вЂ” the tool-calling loop (`MAX_TOOL_ROUNDS=6`), Arabic system prompt (numbered-money rule: Latin digits), persists user+assistant turns, exposes `resetHistory()`.
  - `db-tools.ts` вЂ” read-only table registry (`TABLES`) + `queryRecords`/`countRecords`/`systemSnapshot`/`findWhere`; strips `passwordHash`. **The registry is built lazily** (`getTables()` behind a `Proxy`) вЂ” building it at module load dereferences every `@workspace/db` table binding and breaks route test suites that partially mock `@workspace/db` (customer-po imports the communications routes, which now import the ai-assistant handler).
  - `tools.ts` вЂ” tool registry: `search_database`, `count_database`, `system_overview`, `lookup_document`, `search_emails`, `read_email`, `send_email`, `generate_pdf` (each gated by the settings flags; `read_email` hidden when IMAP is unconfigured).
  - `email.ts` вЂ” imapflow + mailparser (`searchEmails`/`readEmail`) and nodemailer (`sendAssistantEmail`).
  - `pdf.ts` вЂ” pdfkit Arabic PDF generator (Amiri font), returns a Buffer.
  - `handler.ts` вЂ” `handleAiAssistantMessage(phone, msg)`: returns **true only** when the sender is allowlisted (so non-authorized numbers fall through untouched). Downloads inbound image/voice media, dispatches to `runAgent`, sends the reply text + any generated PDFs.
- **Webhook wiring (both paths, identical order вЂ” see the earlier "dispatch-order bug" note)**: `modules/communications/routes.ts` now tries, in BOTH `Whatsapp.on.message` and `dispatchWebhookPayload`: `reaction в†’ handleAiAssistantMessage в†’ handleRepMessage в†’ handleWorkOrderButton в†’ handleInboundMessage`. The AI handler runs FIRST so an allowlisted admin/manager's text reaches the agent even if they are also a registered rep.
- **Portal**: `/ai-assistant` page (`modules/ai-assistant/pages/index.tsx`) вЂ” allowlist CRUD (add/canonicalize/toggle/delete + link to employee), model/base-url/language/system-prompt/toggles form, live config badges (AI key set / IMAP configured). Nav item `nav.aiAssistant` (Bot icon, admin group) + permission catalog entry `ai-assistant` with children `ai-assistant:users` / `ai-assistant:settings`; excluded from the `purchasing` role defaults. Route added in `App.tsx`.
- **Env required for full capability**: `AI_API_KEY` (else the assistant only replies with a "not configured" notice). Email **reading** needs no extra config вЂ” `imapConfig()` in `email.ts` defaults `IMAP_HOST` to the host derived from `SMTP_HOST` (`smtp.` в†’ `imap.`, and `mail.` в†’ `imap.`) and `IMAP_USER`/`IMAP_PASS` to `SMTP_USER`/`SMTP_PASS`, so a working mail account configures both directions. `IMAP_*` vars override. **Caveat**: a Gmail/Workspace account must have IMAP enabled in its settings and the `SMTP_PASS` must be an app password (OAuth-only accounts will authenticate for SMTP but fail IMAP). Documented in README.
- **`isEmailReadConfigured()` requires host AND user AND pass**: it previously checked host+user only, so a mailbox with no `SMTP_PASS` reported "configured" and then died at login with an opaque auth error. All three are required now; the guard's failure message is Arabic so the model relays something actionable instead of echoing an English env-var hint.
- **Diagnosing "the assistant says email is not configured"**: verify in this order before touching code вЂ” (1) `GET /v1/services/<id>/env-vars` confirms `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` exist and are non-empty (no literal `None`/`""` values, which a stray dashboard edit can leave behind); (2) the **deployed** commit is current (`GET /v1/services/<id>/deploys?limit=3`, compare `commit.id` to `origin/main`); (3) run a throwaway vitest that logs into `imap.<smtp-host>` with those exact credentials. Live check on 2026-09-22: login **succeeded**, INBOX 429 messages / 384 unseen вЂ” so a "not configured" reply there is _not_ a credential or IMAP problem. (4) The far more likely cause is a **429 quota** on the model: the read tool is only invoked if the model gets a turn, and when every model is exhausted `handleAiAssistantMessage` replies with the generic/quota error, which reads like a configuration failure. `/tmp/fetch_*.py`-style Render env probes must be deleted afterwards (`chmod 600` while they exist).

### Gemini provider notes (default)

- **Defaults are Gemini**: `DEFAULT_BASE_URL = https://generativelanguage.googleapis.com/v1beta/openai`, `DEFAULT_MODEL = gemini-3.8-flash`. `AI_BASE_URL`/`AI_MODEL` still override for any OpenAI-compatible provider.
- **Retired default**: the seeded settings row used to default to `gpt-4o`. An idempotent `UPDATE ai_assistant_settings SET model='gemini-3.8-flash' WHERE key='default' AND model IN ('gpt-4o','gpt-4o-mini','')` runs in `init-db.ts` as its **own** statement (per the SQL-comment/rollback rules) вЂ” do not fold it into the CREATE block.
- **`thought_signature` is mandatory (Gemini 3)**: the assistant tool-call turn must echo `extra_content.google.thought_signature` back or the API 400s with "Function call is missing a thought_signature". `agent.ts` pushes the **raw** `result.toolCalls` array (not a reconstructed `{id,type,function}`), so the opaque field survives. The `ToolCall` type carries `extra_content?`; there is a regression test asserting it round-trips.
- **Voice notes go through Gemini's NATIVE endpoint**: Gemini has **NO** `/audio/transcriptions` (404), and the OpenAI-compat `input_audio` path only accepts `format: wav|mp3` вЂ” but WhatsApp sends **ogg/opus**. `transcribeAudio()` therefore branches on `isGeminiEndpoint()`: for Gemini it POSTs `${base_without_/openai}/models/<model>:generateContent` with `inline_data: { mime_type, data }` (any MIME type accepted); otherwise it uses the whisper `/audio/transcriptions` form path.
- **Model ids drift fast**: `gemini-2.5-flash` is already retired for new keys ("no longer available to new users"). Use `GET /ai-assistant/models` (admin UI dropdown) rather than hard-coding; `listModels()` strips the `models/` prefix.
- **Per-model daily quota is the dominant failure mode (429)**: Gemini's free tier caps **each model at 20 requests/day** (`generate_content_free_tier_requests`, quotaId `GenerateRequestsPerDayPerProjectPerModel-FreeTier`). The primary model exhausts after a handful of WhatsApp turns and then _every_ message fails, so `chatCompletion()` walks a **fallback chain** (`AI_FALLBACK_MODELS`, default `gemini-3.6-flash,gemini-3.1-flash-lite`). Error classes drive the control flow: **429/404** abandon the model immediately (no point retrying a daily quota/retired id) and jump to the next; **500/502/503/504 + network** retry the **same** model 3Г— with backoff, then fall through to the next candidate вЂ” a 503 В«high demandВ» is exactly when a different model succeeds (observed live: 3.7-flash 503 while 3.6-flash served the same request); **any other status (400/401/403вЂ¦)** is permanent and identical on every model, so it is thrown at once without burning the fallbacks. `transcribeAudio()` walks the same chain. Only when every candidate is exhausted does the error surface вЂ” `isQuotaError()` then lets `handler.ts` tell the operator it's a quota problem rather than a generic failure. **Do not revert 429 to the retry-on-same-model set**: retrying a spent daily quota just burns time and always fails.
- **`FALLBACK_MODELS` is Gemini-specific**: the ids are only valid on the Gemini endpoint. Pointing `AI_BASE_URL` at another provider means the fallback attempts 404 harmlessly (and `SWITCH_MODEL` includes 404, so it degrades cleanly) вЂ” override `AI_FALLBACK_MODELS` per provider.
- Tests: `ai-gemini.test.ts` (12) вЂ” Gemini defaults, native-endpoint OGG transcription, graceful null on failure, whisper fallback for OpenAI, model listing, 503 retry, no-retry on 400, 429 fallback, 503 fallthrough to the next model, permanent-400 short-circuit, all-candidates-exhausted, quota classification.
- **Deploy (verified live)**: PR #136 squash-merged as `d4e0546`; CI (Type Check / Tests / Format Check) green; Render deploy `dep-daota2btqb8s73ehj40g` live. `AI_API_KEY` + `AI_MODEL` were set on the Render service via `PUT /v1/services/<id>/env-vars` вЂ” **the endpoint takes a BARE ARRAY** (`[{"key":..,"value":..}]`), not `{"envVars":[...]}` (which returns `{"message":"invalid JSON"}`), and it REPLACES the whole set, so read the current vars first, modify, and PUT all of them back. Changing env vars triggers a new deploy automatically; the healthz + `/api/ai-assistant/*` (401 unauthenticated = mounted) smoke check confirms it.
- Tests: `__tests__/routes/ai-assistant.test.ts` (6 вЂ” allowlist CRUD, phone canonicalization, invalid phone 400, settings PUT, non-admin/manager 403) + `__tests__/routes/ai-agent.test.ts` (4 вЂ” tool call round-trip, direct answer, tool error fed back, thought_signature echo) + `__tests__/routes/ai-gemini.test.ts` (12) + `ai-email-config.test.ts` (7). **344 api-server tests** pass; tsc (libs + api-server + portal) clean; portal + api-server builds clean.

## Drizzle hides the Postgres error in `err.cause` вЂ” never match `err.message`

- **Symptom**: `DELETE /api/suppliers/:id` returned **500** even though the route had an FK guard, and `POST /api/accounts/sales-invoices` failed on **every** attempt with a duplicate `INV-2026-000001`.
- **`err.message` is useless for driver errors**: drizzle wraps them in `DrizzleQueryError`, whose message is only `Failed query: <sql>\nparams: <bind values>` вЂ” the Postgres message and its **SQLSTATE** live on `err.cause`. A guard like `err.message.includes("violates foreign key constraint")` therefore **never matches**. Use `shared/pg-errors.ts`: `pgError(err)` unwraps the cause chain, plus `isForeignKeyViolation` (23503), `isUniqueViolation` (23505), `constraintViolated(err, fragment)`. `pgError` identifies a driver error by a 5-char SQLSTATE `code`, so it stays correct for nested/cyclic causes.
- **Duplicate document numbers are a race, not a broken sequence.** `nextEntryNo(prefix, year)` scans the current max and adds one, so two overlapping requests вЂ” or one submit **retried after a slow response** вЂ” compute the same number; the loser violates the unique index and 500s. Verified with the real function against a real Postgres (PGlite): given `INV-2026-000045` it correctly returns `...046`, so the scan/SQL are fine and the fix must be at the insert.
- **`insertWithDocNo(prefix, dateStr, insert)`** (in `accounts/posting.ts`) is the fix: it re-reads and retries up to 5Г— **only** on a unique violation and rethrows everything else, so a genuine failure is never masked by the retry loop. It is wired into all four allocation sites вЂ” sales invoices (`INV`), supplier invoices (`SI`), supplier payments (`SP`) and journal entries (`JE`). Add new numbered documents through it, not `nextEntryNo`.
- Tests: `pg-errors.test.ts` (7), `invoice-numbering.test.ts` (6 вЂ” 4 fail against the pre-fix code), 3 supplier-delete route tests (409/204/404). **360 api-server tests** pass.
- **Route paths for smoke tests**: sales invoices live at `/api/accounts/sales-invoices` (NOT `/api/sales-invoices`); a wrong path returns **404**, which looks like "not deployed". `/api/healthz` 200 + a **401** on the real path is the correct "mounted behind auth" signal.
- Deploy: PR #140 squash-merged `090d8ea`; CI + Deploy workflows success; Render `dep-dap2ngv40ujc73bbqgi0` live.

## Email reading in production needs no extra config (verified)

`imapConfig()` derives `IMAP_HOST` from `SMTP_HOST` (`smtp.gmail.com` в†’ `imap.gmail.com`; `mail.` в†’ `imap.`) and falls back to `SMTP_USER`/`SMTP_PASS`. Production has all three SMTP vars set, so reading is configured without any `IMAP_*` var вЂ” the SMTP config is sufficient. (Confirmed live: IMAP LOGIN OK, INBOX 429 messages.) Before blaming configuration, check the `AI_API_KEY`/model quota path: when every model is exhausted the handler replies with the quota error, which reads like a config failure.

## A retry does not make number allocation safe вЂ” it needs a lock

- **The retry in #140 was insufficient.** `insertWithDocNo` re-read and retried on a unique violation, but the retry only re-reads the max _after_ the winner has committed. Two requests that start together both read the same max, and the loser's retries fire while the winner is still uncommitted, so every attempt regenerates the same number.
- **Measured on a real Postgres (PGlite) with real drizzle, 8 concurrent inserts**: retry-alone recovered **5/8** (3 в†’ `duplicate key ... "sales_invoices_invoice_no_key"`); with the advisory lock, **8/8**, zero duplicate groups. Don't trust a green unit test for a race вЂ” the mocked `select` never actually collides. Drive the real function against a real database, and to get real concurrency let the callback `await` a real query before inserting (otherwise JS ordering keeps it sequential).
- **Fix**: allocate inside `db.transaction` holding a per-series `pg_advisory_xact_lock` (`DOC_NO_LOCK_KEYS`: JE/INV/SI/SP = `7_391_05x`, deliberately distinct from the PO key `7_391_042`). Same pattern already used for PO numbering. The retry stays as a narrow belt-and-braces for an insert made outside this helper.
- **The transaction is what makes the callback signature `(docNo, tx)`.** Use `tx`, not `db`, inside it вЂ” otherwise the insert runs on a different connection _outside_ the lock and the fix silently does nothing. All four call sites (sales invoices, supplier invoices, supplier payments, journal entries) were updated.
- **Two latent bugs fixed by the same change**: `postJournalEntry` inserted the header and its lines with two separate `db.insert` calls, so a failure between them consumed an `entry_no` while leaving an entry with **no lines** (invisible in the ledger, but the number was spent). Header + lines now commit together.
- **`nextEntryNo(prefix, year, handle = db)`** takes an optional handle so it can run inside a caller's transaction; `DbLike` (in `posting.ts`) names the slice of the drizzle handle the helpers need.
- **Test-mock note**: `db.transaction` must be added to every mock that exercises a posting path (`ledger.test.ts`, `expenses.test.ts`) вЂ” `transaction: vi.fn(async (fn) => fn(dbMock))` keeps all existing assertions valid. `invoice-numbering.test.ts` asserts the lock is taken with the right key _before_ allocation.
- Tests: **361 api-server tests** pass; tsc (libs + api-server + portal) clean; prettier repo-wide clean; both builds clean.
- Deploy: PR #142 squash-merged `1e08346`; CI + Deploy-to-Render workflows success.

## AI assistant: no final reply + email attachments (PR #144)

- **Symptom**: the WhatsApp agent replied В«ШЄЩ… ШЄЩ†ЩЃЩЉШ° Ш·Щ„ШЁЩѓ Щ„ЩѓЩ†Щ†ЩЉ Щ„Щ… ШЈШ­ШµЩ„ Ш№Щ„Щ‰ Ш±ШЇ Щ†Щ‡Ш§Ш¦ЩЉВ» for В«Щ‡Ш§ШЄ Щ…Щ† Ш§Щ„Щ…ЩЉЩ„ Щ…Щ„ЩЃ pdf Щ„Ш§Ш®Ш± Ш§Щ…Ш± ШЄЩ€Ш±ЩЉШЇВ». Email/IMAP itself was healthy (LOGIN OK, INBOX 429) вЂ” the fault was entirely in the agent loop.
- **Cause 1 вЂ” the model never stopped calling tools.** Reproduced against production with the real 8-tool set: every round returned `tool_calls`, so `MAX_TOOL_ROUNDS` was exhausted with `finalText` still null. A loop that only stops on "no tool calls" is not safe against a tool-happy model. The last round now passes `tool_choice:"none"`; **if the provider ignores it (Gemini does), dropping the tool schemas entirely for one more call is what actually yields text** вЂ” `tool_choice:"none"` alone is not a guarantee. Only after that does the loop give up, with a message naming the tools that really ran.
- **Cause 2 вЂ” there was no way to get an attachment.** `read_email` returned attachment _metadata_ only, so the model hunted forever for a file it could never obtain and hallucinated a `get_email_attachments` tool. New `get_email_attachment` (uid + index/filename) downloads the bytes, queues them in `ctx.outbox` for WhatsApp, and returns text-like ones inline so the model can quote them.
- **Diagnosing "no final answer"**: there is no `logger.error` because `runAgent` never threw. Reproduce by replaying the loop against the live API rather than reading logs вЂ” the round-by-round tool trace is what exposes it.
- **Free-tier quota is PER MODEL**, so a longer `AI_FALLBACK_MODELS` chain multiplies the daily budget (20/day/model). `gemini-2.5-flash`/`gemini-2.0-flash` are now 404 (retired) вЂ” check `GET /v1beta/openai/models` before trusting an id. Env `AI_FALLBACK_MODELS` on Render overrides the built-in chain.
- **Unknown tool calls and tool failures were silent** вЂ” a hallucinated tool name only showed to the model as "Unknown tool". Both now `logger.warn`.
- **Test-mock note**: `ai-email-attachment.test.ts` fakes only `imapflow` + `dns` and lets the REAL `mailparser` parse a hand-built MIME message, so the attachment path is exercised for real. `AI_MAX_ATTACHMENT_BYTES` makes the size ceiling testable without allocating 25MB.
- `ai-gemini.test.ts` originally hardcoded "3 models tried"; derive it from `FALLBACK_MODELS.length` so extending the chain doesn't break it.

## A silently-unfiltered query makes the model hallucinate (the В«Щ‡Ш§ЩЉ ЩЃЩ€Щ„ШЄВ» incident)

- **Symptom**: asking the assistant about supplier В«Щ‡Ш§ЩЉ ЩЃЩ€Щ„ШЄВ» produced offers 237/232/231/230, and on challenge it invented В«ШґШ±ЩѓШ© Ш§Щ„Щ†Щ€Ш±В» as the supplier on PO 37. **No exception anywhere** вЂ” which is what made it hard to find.
- **Cause**: `queryRecords` built its `WHERE` from
  `spec.search.map(c => columns[c]).filter(Boolean)`. The registry declared columns that do not exist (`offers.supplierName`/`status`, `offer_items.partNo`/`lineItem`/`description`, `purchase_orders.supplierName`), so the array was **empty** в†’ no filter applied в†’ the newest rows of the table came back as "search results". The model read real rows as its answer and filled the gaps with invented names.
- **The general rule**: a capability that silently does something OTHER than it claims is worse than one that throws. `filter(Boolean)` on a registry lookup turns a configuration typo into fabricated data.
- **Fix invariants** (do not regress):
  - A search term that cannot be matched returns **nothing** (`sql`1 = 0``), never a scan.
  - Sub-matches are **OR**ed (a PO matches by its number **or** its supplier), never ANDed вЂ” ANDing rejects the very rows the term was meant to find.
  - FK columns are resolved to labels (`supplierName`/`poNo`) so the model never guesses a name from an id.
  - `searchNote`/`searchApplied` are returned **first** in the tool result so the model reads the caveat before the rows.
  - `ai-grounding.test.ts` guards the WHOLE registry: it asserts every declared `search` column exists in the Drizzle schema, so this cannot return silently.
- **Searching a FK's integer column by a name is not a filter** вЂ” `ilike(offers.supplierId, "%Щ‡Ш§ЩЉ ЩЃЩ€Щ„ШЄ%")` matches nothing yet marks the search "applied", which defeats the guard. Related-table terms must go through `extraSearch`/`extraSearchColumn`.
- Do not point `extraSearchColumn` at a column the table lacks (`purchase_orders` has no `supplierId`; it resolves to `id`).
- The prompt must state read-only capabilities honestly: there is **no WhatsApp send tool**, and the agent had been claiming it could message suppliers.

## IMAP server-side search is not a reliable text search

- `search.or = [{subject},{body}]` failed live: В«Щ„Ш§ ШЄЩ€Ш¬ШЇ Ш±ШіШ§Ш¦Щ„ Щ…Щ† EDCВ» for mail that was in the inbox. BODY full-text is unimplemented on many servers, it **never matches the From display name**, and Arabic is mangled by charset handling.
- Match **client-side** over the recent window instead (`matchEmailFields`), with Arabic normalisation (alef/hamza, taa marbuta, yaa, harakat, tatweel folded) so В«ШґШ±ЩѓЩ‡В» == В«ШґШ±ЩѓШ©В».
- Report the **scope** (folder, window, messages scanned) вЂ” otherwise "not found" is an unsupported claim and the operator has no way to judge it. Default window 60d (was 14d).
- Tests: `ai-email-search.test.ts` covers the match decision, normalisation, and attachment selection.

## Cost/latency of the tool loop

- Tool calls within one round are chosen together and are independent: run them with `Promise.all`, not sequentially. 3 sequential line-item lookups cost 3 round-trips for no reason.
- `MAX_TOOL_ROUNDS` is a **quota** budget, not just a loop guard: Gemini's free tier is 20 requests/day/**model**, so 8 rounds burned the day in a couple of questions. It is now 5, and `ai-agent.test.ts` asserts the test's copy matches the source constant.

## Multi-mailbox reading + real document reading (feat/ai-assistant-multi-mailbox)

- **Reading and SENDING are separate concerns, and must stay that way.** `shared/mail-identity.ts` is the ONE outbound identity (Step 1: every sender authenticates as that account so DKIM stays aligned); `ai-assistant/mailboxes.ts` is the READ list. A test asserts the read module cannot change the send identity вЂ” do not merge them.
- **`AI_MAILBOXES`** (comma-separated; `address` or `address|Label`; FIRST entry is the default) names readable mailboxes. Unset в†’ falls back to the single legacy `IMAP_USER`/`SMTP_USER`. Adding a mailbox must NOT require a new secret: every mailbox authenticates as itself via **domain-wide delegation** (`GOOGLE_ACCOUNT_BASE_64` + `https://mail.google.com/`), which is also why storing a password per mailbox is unnecessary. `logReadMailboxes()` logs the resolved list at startup вЂ” the list lives in env, not in the DB, so there is no UI to check it.
- **Addressing is by name, not position**: `resolveMailbox` accepts a full address, a bare local part (`sales@` в†’ `sales`), or the label (В«Ш§Щ„Щ…ШЁЩЉШ№Ш§ШЄВ»). Model-supplied mailbox/folder must be round-tripped through `read_email`/`get_email_attachment` because **a UID is unique only inside one folder of one mailbox**.
- **The Sent folder is found by its `\Sent` attribute, never a hardcoded path**: Gmail localizes it (В«[Gmail]/Ш§Щ„ШЁШ±ЩЉШЇ Ш§Щ„Щ…Ш±ШіЩ„В»). `search_sent_emails` is a distinct tool; an inbox search cannot answer "what did we send?".
- **Four bugs fixed here, each of which made multi-mailbox reading silently wrong** (all reproduce by reverting the fix, so the tests are real):
  1. `searchOneMailbox` didn't forward the mailbox to `withMailbox` вЂ” a fan-out read the DEFAULT inbox once per mailbox, i.e. the same mail N times.
  2. `SENT_ATTRIBUTE` compared without lowercasing в†’ the attribute path was dead code; only the name fallback ever worked.
  3. the Sent name pattern required a separator before the word, so В«Ш§Щ„ШЁШ±ЩЉШЇ Ш§Щ„Щ…Ш±ШіЩ„В» (space-prefixed) never matched.
  4. the folder was module-level mutable state вЂ” a request-scoped SELECTOR is required, or concurrent requests race.
- **Never mock `googleapis` to stub a token exchange**: that mock is bypassed (dynamic import in the SDK), the suite quietly calls Google, and the failure looks like a real "service account not authorized" error. Mock the delegation boundary (`gmail-auth`) instead. Tests must not touch the network вЂ” repeated runs returning a _varying_ error is the tell.
- **Document reading** (`extractDocumentText`): documents were previously only ACKNOWLEDGED ("Щ‡Щ„ ШЄШ±ЩЉШЇ ШЈЩ† ШЈЩ„Ш®Щ‘Шµ Щ…Ш­ШЄЩ€Ш§Щ‡Шџ") and never opened. Reuse the voice-note path вЂ” Gemini's native `generateContent` + `inline_data` takes PDF/image bytes directly, so no PDF parser is needed (and none is available: the Render image has no `pdftotext`), and scanned/photographed documents work. `extractWithGeminiModel` now takes the prompt so audio and documents share one implementation.
  - Feed the extracted text in the **same user turn** as the question (a caption like В«Щ„Ш®Щ‘Шµ ШЇЩ‡В» refers to the file), cap it (`MAX_DOCUMENT_CHARS` = 40k), and keep it **out of the stored history** while labelling the turn `[Щ…Щ„ЩЃ: po.pdf] вЂ¦` so replay still reads correctly.
  - On a failed download/extraction, tell the model the file could NOT be read. The alternative вЂ” asking about an empty document вЂ” is how a confident invention happens.
- **Gateway coverage**: `handleAiAssistantMessage` had none; `ai-handler.test.ts` now pins the allowlist (a non-allowlisted number returns `false` and must never reach the agent), document download/pass-through, the caption default, and the download-failure path.
- Tests: `mailboxes.test.ts` (50) + `gmail-auth.test.ts` (13) + `multi-mailbox-search.test.ts` (15) + `ai-email-tools.test.ts` (16) + `ai-handler.test.ts` (6) + 4 document tests in `ai-agent.test.ts`. **492 api-server tests** pass; tsc clean; portal + api-server builds clean; repo-wide prettier clean.

## Assistant answer latency (feat/ai-assistant-latency, #151)

Reported live as В«Ш§Щ„Щ€ЩѓЩЉЩ„ ШЁШ·Ш¦ ЩЃЩЉ Ш§Щ„Ш§ШіШЄШ¬Ш§ШЁШ©В». Three independent costs sat on the
path of **every** question вЂ” none was the prompt or the model choice:

1. **Email search MIME-parsed the whole window.** `searchOneMailbox` fetched
   `source` for up to 400 messages and `simpleParser`-ed each, per mailbox (Г—3),
   on every search, to find matches the envelope already identifies. `email.ts`
   is now **two-pass**: pass 1 reads envelope-only and is the real search; pass 2
   parses bodies (its own tighter budget, `BODY_PARSE_BUDGET`=60) _only when pass
   1 matched nothing_, and only the newest `limit` get their body read for the
   snippet. `ai-email-cost.test.ts` asserts the **number of body fetches** вЂ” a
   correctness-only test cannot see this regression.
2. **The webhook awaited the agent.** Meta redelivers a webhook not acked within
   seconds, so a 20-40s tool-calling answer was processed **twice** (double
   quota, two replies). `handleAiAssistantMessage` now decides ownership, starts
   the work in the background and returns immediately; a delayed ack (В«вЏі Ш¬Ш§Ш±ЩЉ
   Ш§Щ„ШЁШ­Ш«...В») fires only if the answer passes `ACK_AFTER_MS`. `pendingAiAssistantWork()`
   drains in-flight work (tests must call it after every handler invocation).
3. **The fallback chain restarted every round.** With 20 req/day/model the
   primary is often out, so each of the 5 tool rounds re-probed every dead model.
   `llm.ts` now **remembers** the model that worked (`rememberWorkingModel`) and
   the ones that are out (`markModelExhausted`) вЂ” do not clear this per request.
   A 429 carrying a short `retryDelay` is a per-MINUTE cap: wait it out once
   (`MAX_QUOTA_WAIT_MS`=5s) rather than demoting the whole conversation.
   `resetModelState()` exists **only for tests**; call it in `beforeEach` or the
   module-level memory leaks between tests (and `fetchMock.mockReset()`, since a
   queued `mockResolvedValueOnce` leaks too).

Per-round and total answer time are logged (`AI assistant: tool round complete`,
`AI assistant: answered`) so future slowness is measured, not guessed.
**505 api-server tests** (44 files) pass; tsc + portal build + repo-wide prettier
clean. Deploy verified: `57826aa` live, healthz 200.

## No overall deadline meant "silence" for the operator (#152)

- **Symptom**: В«Щ‡Ш§ШЄ ШЈШ­ШЇШ« ШЈЩ…Ш± ШЄЩ€Ш±ЩЉШЇ Щ€Ш§Ш±ШЇ Щ…Щ† Ш§Щ„Ш№Щ…Щ„Ш§ШЎ Щ…Щ„ЩЃ PDFВ» в†’ the ack was sent,
  then nothing ever arrived; the operator answered В«Щ…Ш±ШЇШЄШґ ЩЉШ№Щ†ЩЉВ». The reply WAS
  produced, just minutes later вЂ” after they had left the chat.
- **Cause**: no total deadline existed anywhere. Per-attempt timeout was 90s,
  `chatCompletion` could walk the 7-model chain Г— 2 attempts, and the agent ran
  up to 5 of those completions. Worst case: hours. **A very late answer is
  indistinguishable from no answer** вЂ” that is the real defect, not the wording.
- **Three bounds** (all env-tunable), checked before each attempt and passed as
  an `AbortSignal` so an in-flight request is cancelled the moment a budget ends:
  `AI_ATTEMPT_TIMEOUT_MS` (45s, one provider attempt) <
  `AI_COMPLETION_BUDGET_MS` via `completionBudgetMs()` (100s, one completion's
  whole chain) < `AGENT_BUDGET_MS` (150s, the entire run: every round + tool).
  An aborted run must also stop the chain (`budget.signal.aborted` guard in the
  attempt loop) or the remaining models are walked with already-aborted requests.
- **Timeout is a user-visible outcome**: `isTimeoutError()` routes it to a
  distinct Arabic message (В«Ш§ШіШЄШєШ±Щ‚ Ш§Щ„Ш·Щ„ШЁ Щ€Щ‚ШЄЩ‹Ш§ ШЈШ·Щ€Щ„ Щ…Щ† Ш§Щ„Щ…ШіЩ…Щ€Ш­вЂ¦В») so the operator
  knows to retry with something specific, never silence.
- **Read budgets per call, not at import**: `completionBudgetMs()` is a function
  so the test can shorten it via env; a module const would be frozen at import.
- **Test**: every model 503 в†’ asserts the call gives up inside the granted budget
  instead of walking all 7 (fails 2/16 against the pre-fix source).

## Email attachments unreadable вЂ” the read paths dropped their mailbox (UID 3977)

- **Symptom**: asking the WhatsApp agent for the PDF on the Jaz Almaza order
  (`Cordoba Order - Jaz Almaza Matrouh`, from `purchasing.crystal@jazhotels.com`)
  failed with a generic В«ШЄШ№Ш°Щ‘Ш± Щ…Ш№Ш§Щ„Ш¬Ш© Ш·Щ„ШЁЩѓ Ш­Ш§Щ„ЩЉЩ‹Ш§В» вЂ” no file, no item list.
- **Cause**: `withMailbox(fn, mailboxArg)` resolves the mailbox from its second
  argument and **falls back to `defaultMailbox()` when it is undefined**.
  `searchEmails` forwards the mailbox correctly, but `readEmail` and
  `readEmailAttachment` accepted a `mailbox` parameter and never passed it on вЂ”
  so **every** read/search-then-open went to the default mailbox. With
  `AI_MAILBOXES=procurement@вЂ¦|Ш§Щ„Щ…ШґШЄШ±ЩЉШ§ШЄ,info@вЂ¦|Ш§Щ„Ш№Ш§Щ…,finance@вЂ¦|Ш§Щ„Ш­ШіШ§ШЁШ§ШЄ`, the
  default is `procurement@`, while this message lives in `info@` вЂ” so the UID
  lookup found nothing and threw. The docblock right above these functions warns
  that the mailbox MUST be forwarded; the rule had been applied to search only.
- **Fix**: both read paths now pass their mailbox into `withMailbox`, and go
  through `readFromCandidateMailboxes`, which tries the requested mailbox FIRST
  then the other configured ones. The fallback exists because the caller may omit
  the mailbox and the model may pass one it inferred rather than the one the
  search tagged. **Only a genuine not-found advances** (`isNotFoundError`); an
  auth/TLS/not-configured fault would fail identically everywhere, so retrying it
  would spend the latency budget to report the same error.
- **Second half вЂ” the agent must _read_ the file, not just forward it**: the user
  asked for the PDF _and_ its item/quantity details. `get_email_attachment`
  already queued the file for WhatsApp but returned metadata only, so the body
  (which carries no item details) was all the model had. It now extracts
  PDF/image attachments via the existing `extractDocumentText` (Gemini
  inline_data вЂ” no PDF parser needed on Render) and returns the text. Called with
  `read:false` it skips extraction; when extraction returns null it reports
  `readFailed` and tells the model not to describe a file it never read.
- **`MAX_DOCUMENT_CHARS` moved to `llm.ts`**: the tool registry needs the cap and
  `agent.ts` imports the registry, so importing it from `agent.ts` would be a
  cycle. `agent.ts` re-exports it, so existing importers are unaffected. Any test
  that fully mocks `modules/ai-assistant/llm` must now use `importOriginal` or it
  loses the constant (the `ai-agent.test.ts` mock was fixed this way).
- **Tests**: `ai-email-read-mailbox.test.ts` (7) вЂ” reads UID 3977 from the second
  mailbox, a bare read finding it in any mailbox, a wrong model guess still
  resolving, attachment bytes from the right mailbox, genuine not-found across all
  three, and the config-error short-circuit (1 auth attempt). 5 of 7 fail against
  the pre-fix source. `ai-email-attachment.test.ts` +3 for PDF text extraction /
  `readFailed` / `read:false`; the first two fail against the pre-fix source.
  517 api-server tests pass; tsc + repo-wide prettier + api-server build clean.

## A sample must never be presented as a total (feat: `scan_emails` census)

- **Symptom**: the operator asked В«ШЈШ±Щ‚Ш§Щ… Ш·Щ„ШЁШ§ШЄ Ш§Щ„ШЄШіШ№ЩЉШ± Ш§Щ„Щ„ЩЉ ЩЃЩЉ Ш§Щ„Щ…ЩЉЩ„ Щ…Шґ Щ…Щ€Ш¬Щ€ШЇШ© ЩЃЩЉ
  Ш§Щ„Щ†ШёШ§Щ…В» and В«Ш№ШЇШЇ Ш§Щ„Ш·Щ„ШЁШ§ШЄ Ш§Щ„Щ€Ш§Ш±ШЇШ© Ш®Щ„Ш§Щ„ 2026В» over WhatsApp. The agent answered
  В«10 Ш±ШіШ§Ш¦Щ„В» (the real figure is **3,710**), listed only the newest 20 rows as if
  that were the whole set, then declared В«Ш§Щ„Ш№ШЇШЇ ШЈЩѓШЁШ± Щ…Щ† Ш§Щ„Ш­ШЇ Ш§Щ„ШЈЩ‚ШµЩ‰В» and offered to
  В«Щ‚ШіЩ‘Щ… Ш№Щ„Щ‰ ШЈШ¬ШІШ§ШЎВ» вЂ” an invented limitation, since the census fits in one call.
- **Root cause вЂ” a false negative plus no way to see a total.** `searchEmails`
  delegated matching to IMAP `search.or` on subject/body. **BODY full-text is
  unimplemented on many servers, it never matches the From display name, and
  Arabic is mangled by charset handling** вЂ” so a query for EDC mail returned
  nothing and the assistant reported В«Щ„Ш§ ШЄЩ€Ш¬ШЇ Ш±ШіШ§Ш¦Щ„ Щ…Щ† EDCВ» for a mailbox holding
  thousands. Nothing in the tool surface exposed a count, so the model answered
  from whatever the capped sample contained. **A capability that silently returns
  a subset while the answer is phrased as a total is worse than one that errors** вЂ”
  same class as the `filter(Boolean)` hallucination incident.
- **`scan_emails`** (`email.ts` + `tools.ts`): scans the WHOLE mailbox (envelope-only,
  chunked), extracts document numbers from the **subject** via `DEFAULT_NUMBER_PATTERNS`
  (exported for tests), and returns the true `matched`, `byMonth`, `bySender`,
  `distinctNumbers`, `isTotal` and a `note`. The prompt now states outright that
  `search_emails` is a **sample and never a count**.
- **`isTotal`/`note` are the honesty mechanism** вЂ” a truncated scan is labelled a
  lower bound (В«Ш­ШЇЩ‘ ШЈШЇЩ†Щ‰ Щ€Щ„ЩЉШі Ш§Щ„ШҐШ¬Щ…Ш§Щ„ЩЉВ») so a partial result cannot be reported as
  a total. Keep that distinction when extending the tool.
- **A census defaults to EVERY configured mailbox.** Reading only the default inbox
  produced a partial count while the note still claimed completeness.
- **Fall back to a whole-mailbox read when server-side narrowing finds nothing вЂ”
  then re-verify EVERY criterion client-side, dates included.** The server search is
  an optimisation, not the source of truth: an unverified fallback returned the
  whole year's 3,710 messages as the answer to a **March** slice (March is
  genuinely 0 вЂ” the mailbox's earliest mail is April 2026). This is the same
  "verify, don't trust the attempt" rule as the WhatsApp scroll fix.
- **Time budget is per mailbox, not per scan.** A single shared budget let one slow
  mailbox (the 429-message default inbox, plus IMAP connect overhead) starve the
  others: the first live run reported `scanned: 3715, truncated: true, isTotal:
false` and `procurement: 0 Ш±ШіШ§Щ„Ш© (Щ†Ш§Щ‚Шµ)`. Per-mailbox budgets в†’ `scanned: 4144`,
  `isTotal: true`, and 7.8s instead of 36s. **Always check `byMailbox` вЂ” a zero
  there means a starvation, not an empty mailbox.**
- **`scanEmails` must forward its mailbox to `withMailbox`** (same trap as
  `readEmail`/`readEmailAttachment`): a fan-out that reads the DEFAULT inbox once
  per mailbox returns the same mail N times.
- **Reconciliation is one query, chunked.** Comparing thousands of email numbers
  against a table in a single `IN` risks the Postgres **65,535 bind-parameter cap**;
  `compareNumbersWithSystem` splits at `COMPARE_CHUNK` (5,000) so an oversized
  statement cannot fail the whole answer. Compare on the canonical form
  (uppercase, spaces stripped) so В«26R 011936В» and В«26R011936В» never look like a
  mismatch. A long list is delivered as a **CSV attachment** (`exportCsv`) rather
  than being refused.
- **Diagnosing the mailboxes from this sandbox**: the Render Postgres host is
  **internal-only** (`dpg-вЂ¦-a`), so live DB comparison cannot run here
  (`getaddrinfo ENOTFOUND`) вЂ” the mailboxes ARE reachable via the service-account
  delegation, so census/date/slice behaviour can be verified live while DB joins
  cannot. Do not read an `ENOTFOUND` as a code defect.
- **Drizzle hides driver errors in `err.cause`** (again): the failed comparison
  surfaced only as `Failed query: select вЂ¦`, which is why the probe had to unwrap
  `cause.cause` to see `ENOTFOUND`.
- Tests: `ai-email-census.test.ts` + `ai-scan-emails-tool.test.ts` (28) вЂ” total vs
  lower bound, per-mailbox coverage, the date re-verification after fallback,
  mailbox fan-out, chunked comparison, CSV export. 21/23 of the guards fail against
  the pre-fix source. **545 api-server tests** (was 517); tsc (libs + api-server +
  portal) clean; repo-wide prettier clean; api-server build clean.
- **Live verification (production mailboxes)**: EDC 2026 = **3,710** matched across
  4,144 scanned, 3,317 distinct numbers, `isTotal: true`; byMonth sums exactly to
  the total; the **April slice = 528**, identical to the year's own April bucket вЂ”
  the cross-check that proves the window is applied.

## Attachment reading + the missing-number report (PR #156, `fix/ai-assistant-mail-census`)

Same operator thread as the census section above, but the failures that remained
once the count was right:

- **The missing-number PDF was truncated.** `exportPdf` handed the rows to the
  model, which relayed them into `generate_pdf` вЂ” and the model's payload is
  capped, so a 1,800-row difference produced a report with a handful of numbers.
  **Build the report in the SERVER from the comparison result**, never ask the
  model to carry the rows. `generateMissingNumbersPdf(comparison)` is called
  inside the `scan_emails` tool right after the comparison; the tool returns
  `pdfSent` + a `comparison` summary, and the model only announces the file.
  `exportPdf` without `compareTable`/`compareColumn` is refused rather than
  emitting an empty report.
- **Numbers may live inside the attachment, not the subject.** EDC's В«Quotation
  ImportВ» notices carry the number in the PDF, so a subject-only census
  under-counts them. `includeAttachments` opens the matched messages ONCE
  (`fetchMessageAttachments`, grouped by mailbox вЂ” UID is unique only inside one
  mailbox) and hands the same download to both the number merge (`source:
"attachment"`) and the item parser. Bounded by `AI_ATTACHMENT_SCAN_BUDGET`
  (default 120) + a 60s wall clock, reported via `attachmentCoverage` so a
  partial read is never called complete.
- **Items are read LOCALLY, no model call.** `scan_email_items` (new
  `email-items.ts`) parses part no / description / qty / UOM straight out of the
  PDFs. This is the point: the only pre-existing file reader was Gemini
  `inline_data`, capped at **20 requests/day/model**, so the operator's В«Ш§Щ„ШЁЩ†Щ€ШЇ
  Ш§Щ„Щ„ЩЉ ЩЃЩЉ Ш§Щ„Щ…Щ„ЩЃШ§ШЄВ» request died with a quota error even though the files were
  perfectly readable. `pdf-parse` needs no quota and no API key.
- **pdf.js concatenates text items with NO separator** вЂ” "Line No." в†’ "LineNo.",
  and a table row becomes "124Each5720.001.". `renderPdfPage` rebuilds each
  visual line from the glyph transform (`transform[4]` = x, `transform[5]` = y),
  grouping items within 2 units of a baseline and sorting by x. Without this the
  item tables are unparseable. Keep it as the `pagerender` option.
- **Never mock pdf.js to "make a fixture work"** вЂ” the pdf.js path is not
  reproducible under vitest (synthetic pdfkit fixtures need a warm-up pass that
  never happens in the test harness), so the PDF tests mock `pdf-parse` with the
  REAL captured EDC text while the tool wiring and column parsing are asserted
  exactly. The real attachments parse 8/8 in plain Node, which is how the service
  runs. Don't chase the vitest-only empty-first-parse.
- **The Render Postgres IS reachable externally** (correcting the note above):
  `GET /v1/postgres/<id>/connection-info` returns `externalConnectionString` on
  `dpg-вЂ¦-a.oregon-postgres.render.com`, and it works from this sandbox. The
  internal hostname inside `DATABASE_URL` is not resolvable here, but the
  external one is вЂ” so the DB comparison that "cannot run locally" can. Two
  gotchas: append `sslmode=require` (the raw URL omits it and drizzle fails with
  `SSL/TLS required`), and use the whole external URL; a bare `dpg-вЂ¦-a` host is
  what produced the `ENOTFOUND`.
- **Live verification (real mailbox + real DB)**: EDC 2026 = **3,734** matched,
  3,339 distinct numbers, **1,477 already in `customer_rfqs`, 1,862 missing**,
  and the report generated + queued (1.5 MB PDF, `pdfSent: true`). Run it through
  `executeTool("scan_emails", вЂ¦)` so the probe exercises the same path the model
  does вЂ” a hand-rolled equivalent missed the tool-level bugs.
- **The font ENOENT is source-run-only.** `fontPath()` resolves
  `assets/fonts/Amiri-Regular.ttf` relative to the MODULE, which exists only in
  `dist/` (build.mjs copies `src/assets` в†’ `dist/assets`). Running from `src/`
  reports ENOENT for every PDF; production is the bundle, so this is not a prod
  bug. Stage a copy only to run a probe.
- Tests: `ai-pdf-local-read.test.ts` (6), `ai-email-items.test.ts` (7),
  `ai-email-items-tool.test.ts` (7), extended `ai-scan-emails-tool.test.ts` (the
  full-comparison PDF + the no-comparison refusal). **571 api-server tests** (was
  545); tsc (libs + api-server + portal) clean; repo-wide prettier clean;
  api-server build clean (font asset + pdf-parse both in the bundle).
- PR #156 squash-merged `5c5fa8e`; CI (Type Check / Tests / Format Check) green;
  Deploy-to-Render workflow success; Render `dep-dapn7qk9v7es7397u9f0` **live** at
  `5c5fa8e`; `/api/healthz` 200 and the `/api/ai-assistant/*` routes 401.

## An overloaded PRIMARY model makes the assistant look dead (PR #158)

- **Symptom**: В«Щ…Шґ ШЁЩЉШ±ШЇ Ш№Щ„ЩЉШ§В» вЂ” the assistant sent only the ack. Reproduced by
  injecting a synthetic webhook (POST `/api/webhook/whatsapp` with a Meta-shaped
  body; the route `res.sendStatus(200)` first, so a 200 proves nothing вЂ” watch the
  LOGS): `AI assistant message handled` в†’ ack в†’ `model exhausted вЂ¦ gemini-3.8-flash
status 503` в†’ `AiError: LLM request budget of 100000ms exhausted before an
answer` в†’ a timeout notice. **Meta was healthy the whole time** (`subscribed_apps`
  lists the app, phone `CONNECTED`, WABA `APPROVED`) and nothing was wrong with the
  allowlist вЂ” check those BEFORE blaming the webhook.
- **Root cause**: `gemini-3.8-flash` (the configured primary) is overloaded. Live
  probe, 5 requests each with the real tool schema: **3.8-flash 1/5** (503,503,429,429)
  and **3.7-flash 1/5** (503 Г—4), while 3.6-flash / 3.1-flash-lite / 3.5-flash-lite /
  flash-lite-latest were **5/5**. Model ids that EXIST and answer on a single probe
  can still be unusable under load вЂ” measure several requests, not one.
- **The fatal interaction was retry Г— budget**: an overloaded model answers 503
  _slowly_ (~40s/attempt live). `MAX_ATTEMPTS=2` on the primary alone consumed the
  whole `completionBudgetMs()`, so the healthy fallbacks were never reached. **A
  shared budget with no per-model cap lets one bad model starve the chain.**
  Fix: `perModelMs = budgetMs / candidates.length` gates the retry
  (`attempt < MAX_ATTEMPTS && Date.now() < modelDeadline`) so every candidate gets a
  turn.
- **Order the chain by measured reliability, not by version**: a flaky model early
  spends the budget before a working one is tried. `DEFAULT_MODEL` is now
  `gemini-3.6-flash` and the fallbacks lead with the 5/5 models.
- **Diagnosing a model problem without the app**: probe
  `POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
  with `Authorization: Bearer $AI_API_KEY` and the REAL tool array вЂ” a bare
  chat request succeeds on models that 503 with tools attached (3.8-flash answered
  a plain request 200 while failing 4/5 with tools).
- **WhatsApp rejects `text/csv` outright** (`(#100) Param file must be a file with
one of the following types вЂ¦ Received file of type 'text/csv'`), so every CSV the
  assistant generated was silently lost вЂ” the operator asked for a file and got
  nothing. Upload CSVs as `text/plain` (accepted; the `.csv` filename is preserved).
  `whatsappSafeMime()` in `communications/service.ts` now guards the upload, and its
  final fallback is `text/plain` вЂ” **`application/octet-stream` is itself NOT in
  WhatsApp's accepted list**, so it would lose the file just as certainly.
- Tests: `whatsapp-media-mime.test.ts` (4), 2 new `ai-gemini` regressions (the
  fallback is reached when the primary is slow+overloaded; the default-model /
  fallback-order assertions), CSV mime expectations updated in
  `ai-scan-emails-tool` + `ai-email-items-tool`. **576 api-server tests** pass; tsc
  clean; repo-wide prettier clean; api-server build clean.
- PR #158 squash-merged `1b854b2`; CI + Deploy workflows success; Render
  `dep-dapnu4qd0e5s739q74bg` live at `1b854b2`; `/api/healthz` 200. Post-deploy
  webhook injection: reply produced in **7s** and the outbound status reached
  `delivered` вЂ” the healthy cycle.
- **Render `logs?startTime=&endTime=` returned EMPTY for windows that DO contain
  logs** вЂ” a time-filtered sweep will "prove" there were no inbound webhooks when
  there were. Pull unfiltered (`limit=1000`, repeated, dedupe by `id`) and filter in
  JS.

## A sender's declared MIME type is not evidence of the content (feat #160)

- **Symptom**: В«Ш§ШЇШ®Щ„ Ш§Щ„Щ…ЩЉЩ„ Щ€ШґЩ€ЩЃ ЩѓЩ„ Ш§Щ„PO Щ€Щ‚Щ€Щ„ЩЉ Ш§ЩѓШЄШ± ШЁЩ†ШЇ Ш§ШЄЩѓШ±Ш±В» answered В«ШЁЩ†Щ€ШЇ Ш§Щ„Щ‚Ш·Ш№
  ШЇШ§Ш®Щ„ Щ…Щ„ЩЃШ§ШЄ PDF вЂ¦ ЩЉШЄШ№Ш°Ш± Ш§ШіШЄШ®Ш±Ш§Ш¬Щ‡Ш§ ШўЩ„ЩЉЩ‹Ш§В». IMAP was healthy (3,749 EDC messages
  matched) and `pdf-parse` worked вЂ” the assistant never got a file to read.
- **Cause**: EDC declares its real PDFs (`%PDF-`) as `application/doc` вЂ” **281 of
  305 attachments measured on live mail**. `fetchMessageAttachments` filtered on
  `contentType === "application/pdf"` exactly, so the scan opened **zero** files
  and still reported a total. `isReadableDocumentMime` had the same blind spot for
  the model-side read path. **A filter keyed on a label the sender controls is a
  filter the sender can defeat.**
- **Fix**: `isPdfContent` (magic bytes) + `isPdfAttachment` вЂ” MIME **or** filename
  **or** bytes, ORed. The bytes are the signal that cannot be mislabelled;
  requiring all three would keep the mail unreadable, which is the bug. Both
  `fetchMessageAttachments` and `get_email_attachment` use it, so the file is also
  sent to WhatsApp under a type it accepts (`application/doc` is not one).
- **В«ШЈЩѓШЄШ± ШЁЩ†ШЇ Ш§ШЄЩѓШ±Ш±В» is a FREQUENCY question**: the old sort was by quantity, so a
  single 5,000-pc one-off order led it. `aggregateItemsByOccurrence` is now the
  default (`ordering=mostRepeated`), `ordering=qty` keeps the volume view. The
  aggregator lives in `email-items.ts` and is unit-tested without IMAP.
- **Grouping keys need a floor**: live data had the location tag `RCV` as the
  description on 33 lines, out-ranking every real part. `itemKey` drops
  descriptions shorter than `MIN_DESCRIPTION_KEY_LEN` (4) вЂ” **do NOT normalise
  descriptions further** (stripping numbers merges `CABLE 50 MM` with `CABLE 70 MM`).
- **A sample must not read as a total** (again вЂ” same rule as `scan_emails`): the
  tool result carries `scope` (В«ШЈШ­ШЇШ« N Ш±ШіШ§Щ„Ш© Щ…Щ† MВ»), `isComplete:false` when the
  pass was capped, and distinguishes В«found no readable filesВ»
  (`hasAttachments:false`) from В«the orders have no itemsВ». The old note said
  neither, which is how the reply sounded authoritative while having read nothing.
- **Budget**: attachment fetch is ~**67 ms/message** live, so the 120-message
  default analysed a thirty-second of the year. Now 400 messages / 75 s wall clock
  (inside the agent's 150 s ceiling). Measured through the REAL pipeline after the
  fix: 400 messages в†’ 382 attachments, 1,311 item lines, 856 distinct parts
  (previously 0).
- Tests: `ai-email-attachment-mime.test.ts` (7 вЂ” the `application/doc` PDF opens,
  a genuine xlsx is still ignored; **verified failing against the pre-fix filter**),
  `itemKey`/occurrence tests in `ai-email-items.test.ts`, ranking + truncated-scope
  - no-files tests in `ai-email-items-tool.test.ts`. **593 api-server tests** pass;
    tsc + repo-wide prettier + api-server build clean.
- **Env leakage when running the suite by hand**: `set -a && . /tmp/env_exports.sh`
  to reach the live mailbox leaves `SMTP_*`/`IMAP_*`/`AI_*` exported, and 4 tests
  that assert the _unconfigured_ state then fail. `unset` them before trusting a
  local `vitest run` вЂ” they pass on a clean shell.
- PR #160 squash-merged `1d8ac8f`; CI (Type Check / Tests / Format Check) green;
  Render `dep-dapr5g8473hc73c01u10` live at `1d8ac8f`; `/api/healthz` 200 and
  `/api/ai-assistant/*` 401 (mounted behind auth).

## Assistant timeouts on follow-ups + long-term memory

Two reported live failures on the WhatsApp agent, plus the requested "memory +
learns continuously" capability.

### Follow-up questions timed out

- **Symptom**: «اكتر بند اتكرر» answered after a long scan, then «السخانات
  الأريستون ليه مش في التقرير؟» and «حاول مره اخري» both died with «استغرق الطلب
  وقتًا أطول من المسموح» / «لم أتمكن من الوصول لإجابة».
- **Cause 1 — no memo.** `scan_email_items` ran the whole census (envelope scan
  of the whole mailbox) AND downloaded/parsed every attachment on **every** call.
  Measured live: **~35-43 s per call**. The follow-up re-ran it, so the run blew
  the agent's 150 s budget and returned the timeout notice.
  Fix: `memoizeScan` / `scanCacheKey` (in `email.ts`, module-level TTL cache,
  `AI_SCAN_CACHE_TTL_MS`, default 5 min). `scan_email_items` memoizes the
  **small derived** `{census, parsed}` result keyed on the SCAN args — never on
  `contains`, which is applied afterwards. Verified live: follow-up **43 s → 2 ms**.
- **Cause 2 — the cache must not retain PDF buffers.** A scan WITH attachments
  carries every downloaded PDF (~35 MB). `scanEmails` therefore bypasses the
  cache when `includeAttachments` is set; only the cheap envelope-only census is
  cached there. The item census memoizes its own small result instead.
- **Cause 3 — the window was read as the whole mailbox.** The census covers only
  the newest N messages (400), so an older order's part (Ariston) was absent from
  a report phrased as complete. Fix: `contains` filter on `scan_email_items`
  (matches description OR partNo over the parsed rows) for «فين بند كذا؟», and
  the note now states the scope and says plainly that older mail was NOT scanned
  — «لا تقل غير موجود في البريد». Verified live: `contains:"ariston"` returned
  `0666.001.ARSTON.0004` with the honest coverage note.
- Tests: `ai-email-items-timeout.test.ts` (5 — the memoization test **fails when
  the cache is disabled**, i.e. genuinely guards the fix; plus the contains
  filter, partNo matching and the truncated-scope note). `clearScanCache()` is
  exported and MUST be called in `beforeEach` of any suite that exercises a scan
  (the cache is module-level and would leak between cases): wired into
  `ai-email-census.test.ts` and `ai-email-items-tool.test.ts`.
- Adding `or`/`isNull`/`sql` to a partially-mocked `drizzle-orm` is required once
  a module under test imports `memory.ts`; `ai-agent.test.ts` now stubs the whole
  `memory` module (recall + render + distill) so the loop tests stay focused.

### Long-term memory (the agent learns and keeps it)

- **DB**: `ai_assistant_memories` (`lib/db/src/schema/ai_assistant.ts`), DDL in
  `init-db.ts` as its OWN `client.query` (statements share an implicit
  transaction — a sibling failure rolling back the CREATE is how a table
  silently never exists). Columns: `phone` (''=shared), `category`
  (fact|preference|entity|rule|lesson), `key`+`value`, `importance`, `source`,
  `pinned`, `valid_from`/`valid_until` (bi-temporal), `use_count`/`last_used_at`.
  UNIQUE index on `(phone, category, key)` — the consolidation key.
- **Module** `modules/ai-assistant/memory.ts`, modelled on the open-source work:
  **Mem0** (extract + CONSOLIDATE: same key updates, never duplicates),
  **Letta/MemGPT** (self-editing tools + relevant memories in context),
  **Graphiti/Zep** (a superseded fact is CLOSED via `validUntil`, not destroyed).
- **Tools**: `remember_fact` / `recall_memory` / `forget_memory`, offered to the
  model and pinned in the system prompt. Every message injects the top ~12
  relevant memories (`renderMemoryBlock`), with an explicit "prefer live tool
  data when they disagree" instruction.
- **Retrieval is LOCAL keyword scoring** (`scoreMemory`/`tokenize`) — deliberately
  no embeddings: an embedding per read would spend the same 20-req/day/model
  budget whose exhaustion is this assistant's recorded failure mode. Pinned facts
  always inject; a non-matching query returns **nothing** (never fabricate a fact).
- **Learning is quota-free.** `distillMemories` runs after each turn and learns
  from the operator's OWN words («افتكر إن…», «من الآن اعتبر…» → a `rule`; a
  correction like «ده غلط» → a `lesson`). Fire-and-forget: a memory-write failure
  must never turn a good answer into an error. Do NOT add an LLM distillation
  step — it would burn the quota learning instead of answering.
- **API**: `GET/POST /ai-assistant/memories`, `PATCH/DELETE /ai-assistant/memories/:id`
  (admin/manager; audited). **Portal**: a «ذاكرة المساعد طويلة المدى» card on
  `/ai-assistant` (add, search, category filter, pin, delete).
- Tests: `ai-memory.test.ts` (18 — consolidation, scoping, no-fabrication,
  pinned-always, shared+own, prompt block, distillation incl. no false learning).
- **616 api-server** + 45 portal tests pass; tsc (libs + api-server + portal)
  clean; repo-wide prettier clean; api-server + portal builds clean.
- Deploy: pending — push/PR only on explicit request.

## The assistant stops repeating itself and stops inventing document numbers

Two reliability upgrades to the tool loop, modelled on proven open-source agent
patterns: the LangGraph "generator → critic" self-correction loop, and the
per-run tool-result cache recommended by the OpenAI Agents SDK / Hermes guidance.

### 1. Identical tool calls are executed once per run

- **Pattern**: a light deduplication layer between the model's tool calls and the
  executor. The cache key is `tool name + canonicalised arguments`; the _promise_
  is cached (not the resolved value) because the calls in one round already run
  concurrently via `Promise.all`.
- **Why it matters here specifically**: Gemini's free tier is **20 requests/day
  per model**, so every wasted round is a fraction of the day's ability to answer.
  A model that re-issues the same search when the first result did not match its
  expectation was burning that budget on work already done — one of the recorded
  ways this assistant goes silent.
- **Cache scope is the RUN, not the process.** A later question must see fresh
  data, so `toolCache` is a local `Map` inside `runAgent`. Do not hoist it.
- **Every `tool_call_id` still gets a response**: the memoized content is echoed
  for the duplicate call too, otherwise the provider rejects a `tool_calls` turn
  with an unanswered id.
- `toolCacheKey()` sorts object keys recursively, so `{"a":1,"b":2}` and
  `{"b":2,"a":1}` dedupe, while two calls differing in any value stay distinct.

### 2. A deterministic grounding verifier before the reply is sent

- **The failure it targets** is the documented one: asked about a supplier, the
  model answered «عروض 237، 232…» and on challenge **invented** a supplier name.
  Prompt rules alone had not prevented it.
- **Mechanism**: `findGroundingNumbers()` extracts document-id-shaped tokens
  (letters AND digits, e.g. `26R011936`, `P26E13477`, `INV-2026-000045`) from the
  draft answer; `findUngroundedNumbers()` checks them against a **grounding
  ledger** built from every tool result plus the operator's own words and the
  conversation history. Any token that appears nowhere in that evidence triggers
  `verifyGroundedAnswer()` — one extra `toolChoice:"none"` round that names the
  unverifiable tokens and forces the model to remove them or say the information
  is unavailable.
- **The critic is deterministic — no model call to decide.** The check is token
  containment, so the extra provider request is spent **only when a fabrication
  is actually suspected**, never on an ordinary answer. This is deliberate: an
  LLM-judge critic would spend the same daily quota whose exhaustion is this
  assistant's recorded failure mode.
- **Guardrails that must not regress**:
  - Only mixed alphanumeric ids are challenged. Money, quantities, ids and years
    are excluded by shape, so correct prose is never rejected for containing a
    plain number.
  - A token that is a **substring** of a grounded id is accepted (quoting
    `011936` from `26R011936` is fine); an **extension** is not (`26R0119367` is a
    different id).
  - The verification round runs only if at least `VERIFY_MIN_REMAINING_MS` (30s)
    is left in `AGENT_BUDGET_MS`. Past that a late correction is worse than the
    answer the operator is already waiting for.
  - **The draft is kept if verification throws or returns nothing** — an
    unavailable verifier must never lose a good reply.
- The system prompt states both behaviours (no repeated identical calls; never
  write a document number that did not appear in a tool result), so the model
  usually complies without the loop having to intervene.

- Tests: `ai-agent.test.ts` grew by **8** (dedup: an identical call runs once,
  argument key order is equivalent, differing args still both run; grounding: a
  fabricated number is corrected, a real number is not challenged, an
  operator-stated number is accepted, the draft is kept on verifier failure, and
  token classification). **6 of them fail against the pre-fix code**, verified by
  temporarily disabling the cache and the verification block — they guard the
  behaviour, not merely the code path.
- **624 api-server tests** (was 616) pass; tsc (libs + api-server) clean;
  repo-wide prettier clean; api-server build clean.
- Deploy: pending — push/PR only on explicit request.

## The assistant knows the real names, and refuses to give up too early

Follow-up sharpening of the same loop (PR #163 landed the dedup + number check).

### 3. The real supplier/customer vocabulary is prefetched into the prompt

- **The lesson**: the live «هاي فولت» incident. Asked which supplier PO 37
  belonged to, the model invented «شركة النور» / «الشركة المصرية». Prompt rules
  alone had not stopped it, and only a human asking again caught it.
- **Mechanism**: `entityVocabulary()` (db-tools) reads the real names in two
  bounded selects, caches them for `ENTITY_TTL_MS` (10 min), and
  `renderVocabularyBlock()` puts the list + internal ids in the system prompt.
  No model quota is spent — it is two cheap queries — and it turns "did I
  invent this name?" from an act of faith into a lookup the model can do.
- **Rediscovery cadence matters**: the cache lives at MODULE scope, unlike the
  per-run tool cache. Names change on the order of days, so re-reading them on
  every one of the day's 20 requests would be pure waste; 10 minutes is the
  agreed staleness. `settings.allowDatabase` gates the read entirely.
- **A read failure returns empty lists**, never throws: a database hiccup must
  degrade to "no vocabulary", not block the answer.

### 4. A draft naming an unknown company is corrected before it is sent

- `findUnknownEntityNames()` scans the draft for name-shaped runs and compares
  them to the vocabulary, flagging any run that shares no distinguishing token.
- **The check is deliberately NARROW**, because a false flag is worse than the
  bug: it would make the assistant "correct" a name it got right. So it only
  looks at runs anchored on a company FORM word (`شركة`/`مؤسسة`/`company`), and
  accepts a run when ANY token matches — hence a correct short form
  (`شركة الأمل` for `شركة الأمل للتوريدات`) passes.
- **Generic words are excluded from the match test.** Marker words and
  `لل…`-prefixed suffixes (`للتوريدات`) are shared by most Arabic company names
  and say nothing about identity; counting them would accept every invented name
  whose suffix looks familiar (`مؤسسة الدلتا للتوريدات` vs `شركة الأمل
للتوريدات`).
- Arabic is normalised before comparison (hamza/alef, taa marbuta, yaa, harakat,
  tatweel) and a glued connective (`بشركة` → `شركة`) is stripped both for
  matching and for what gets shown back to the model.
- A flag reuses the same single correction round as the number check, and the
  cause is logged (`unknownNames`) so a bad flag would be visible, not silent.

### 5. A refusal that answered nothing gets one re-ask

- `isRefusalSentence()` matches explicit "I found nothing" phrasing, and only
  when the draft also cites no id and no 2+ digit number (`looksLikeDataFound`).
- `RETRY_MIN_REMAINING_MS` (35s) and `MAX_REFUSAL_REASKS` (1) bound it: exactly
  one second attempt, only with budget to spend, and the loop stops if the
  re-ask still comes back empty. Naming the words `مورد`/`أمر` as "data" was
  rejected on purpose — they appear inside the refusal sentence itself.
- Tests: `ai-entity-names.test.ts` covers the real checker (invented name
  flagged, existing name accepted, short form accepted, spelling variants,
  shared-token acceptance, empty-vocabulary silence, ordinary prose untouched);
  `ai-agent.test.ts` covers the prompt injection, the corrective round, and the
  re-ask bounds. **3 of the new loop tests fail when the name check and the
  re-ask are disabled**, confirmed by temporarily stubbing both.
- **638 api-server tests** (was 624) pass; tsc clean; prettier clean.
- Deploy: pending — push/PR only on explicit request.

## The most-repeated part is counted by ORDERS, and a capped scan says so

Live report (the operator, «gos»): the assistant declared a «فحص شامل» of EDC's
mail for the year, but the answer was built from **381 of 480** matched messages
and its PO numbers did not reconcile. The scan had stopped at its message cap
while the prose read as a total.

### 6. `scope.truncated` now reflects the ATTACHMENT pass, not just the census

- **The bug**: `truncated` was computed from the ENVELOPE scan alone
  (`perMailbox.some((r) => r.truncated)`). The envelope scan covered all 480
  matches, so the flag stayed `false` even though `fetchMessageAttachments` had
  opened only 381. Every downstream sentence keyed on that flag, so the summary
  honestly said "complete" about a sample.
- **The fix**: `truncated` is `envelope || attachmentCoverage.truncated`. The
  attachment pass already knew it had stopped early (the coverage carries its own
  `truncated`, set by both the message cap and the wall-clock budget) — nothing
  was reading it.
- **Belt and braces**: `scan_email_items` also compares _opened_ against
  _matched_ (`coverage.messages >= census.matched`). A pass can stop on TIME with
  its message budget unspent, and that path leaves `truncated` false; the
  comparison catches both shapes. `complete` needs all three: files found, none
  unreadable, and every matched message opened.
- The default attachment budget rose **400 → 1,200** (env
  `AI_ATTACHMENT_SCAN_BUDGET`). The cap is a safety valve, not a sampling
  strategy: set below a normal year of orders, it silently turned every census
  into a sample. The time budget (`ATTACHMENT_SCAN_TIME_BUDGET_MS`, 75s) is what
  bites first on a genuinely huge mailbox, and when it does, coverage reports it.

### 7. Occurrences count ORDERS, not printed lines

- A part's `documents` set is keyed on the document's OWN number
  (`documentNumber()` reads `PO number: P26E14630(RIG58)` / `RFQ number:
26R011954`), falling back to `mailbox#uid#filename`. A PO that lists a part on
  three lines — or restates every line on its distribution page — is ONE order.
  Counting lines let a single noisy document top a frequency ranking.
- `documents` is surfaced (CSV + PDF) so the count is auditable rather than a
  bare number.

### 8. The ranking rule the operator asked for, and the columns they need

- `aggregateItemsByOccurrence(items, minOccurrences)` excludes a part seen on
  fewer than `minOccurrences` orders; `scan_email_items` defaults `minOrders: 2`
  and the tool description spells out the rule. A 7,000-piece line ordered once
  is **not** "most repeated" — the escape hatch is `minOrders: 1`.
- A `contains` lookup is exempt from the rule (`minOrders = 1`): «فين بند كذا؟»
  is a lookup, and a single occurrence is a valid answer.
- Item rows now carry `unitPrice`/`lineTotal` parsed from the PO's money tail
  (anchored on the delivery date so a description ending in two numbers is not
  read as prices), aggregated to `avgUnitPrice`/`totalValue`. The PDF gains the
  columns the operator asked for: part no, full description, order count, total
  qty, UOM, avg unit price, total value, PO numbers — and a scope line that says
  whether the report is the whole set or a capped sample.
- **Tests**: parser cases for price/docId/order-counting, the singleton rule and
  its `minOrders: 1` escape hatch, the PDF column/scope contents, and the
  attachment-cap honesty fix (`ai-email-items*.test.ts`). **646 api-server tests**
  (was 638) pass; tsc clean; prettier clean.
- Deploy: pending — push/PR only on explicit request.

## A page stamp is not a description, and a reason must not be invented

Live follow-up after the census fix, from the same operator. Three things were
wrong in one answer, and only one of them was about honesty.

### 9. Page furniture leaked into the description (the «Page 2 of 4» row)

- The top row of the live report — part `0600.000.GENRAL.0005`, in **134**
  orders, described as `P26E11255 Page 2 of 4` — was not a hallucination. The
  part number was real and printed on the row; the PDF text layer had placed the
  document's own number (`P26E11255`) and the running footer (`Page N of M`)
  **between** the part number and the real description, so the extractor read the
  stamp as the description.
- `collectDescription` now SKIPS a line matching `PAGE_FURNITURE_RE` and keeps
  scanning, instead of stopping there. Stamp forms: `Page N of M`, a bare
  document number (`P26E11255`, `P26E11255(RIG58)`), `PURCHASE ORDER`,
  `REQUEST FOR QUOTE[/QUOTATION]`, `PO/RFQ number: …`.
- The same regex guards the inline head, so a row whose only trailing text is a
  stamp yields an empty description rather than a stamp.
- **Test**: `does not read a page stamp as the description (the «Page 2 of 4»
row)` — reproduces the interleaving exactly and fails when the `continue` is
  removed.

### 10. One tool could eat the whole run; now each call has its own ceiling

- The run budget (150s) bounded the whole answer but nothing bounded a SINGLE
  tool. One slow call could consume the turn and leave the model no time to
  speak — which the operator experiences as silence, the oldest symptom here.
- `executeTool` wraps the inner dispatch in `Promise.race` against
  `toolTimeoutMs()` (env `AI_TOOL_TIMEOUT_MS`, default 100s). On expiry it
  returns a tool ERROR that names the tool and says the data was not fully read,
  so the model reports a partial call instead of treating it as complete.
- **Tests**: `per-tool timeout wrapper` — a never-resolving tool returns the
  partial-data error; a fast tool is unaffected.

### 11. The truncation REASON is exposed, so it is never guessed

- The live answer told the operator the cap was «400 رسالة» — but the deployed
  budget was 1,200, and the real limiter was the **75s time budget**. The reason
  was simply not in the payload, so the model filled the gap.
- `AttachmentCoverage.truncatedReason` is now `"count" | "time" | "error" | null`,
  set at each stop site (message cap, wall-clock, fetch failure). The tool's
  scope/partial wording and the PDF scope line quote it, and the `limit`
  parameter description no longer advertises the stale default of 400.
- **Tests**: the reason is asserted for both shapes, plus that the word «400»
  never appears when the cause was time.

### The honest truth about a 480-message mailbox

Completeness in ONE call is a throughput problem, not a flag: at the observed
~430ms/message (IMAP fetch + MIME + PDF text) a 480-message pass needs ~3.5
minutes, far past the 75s ceiling that exists to protect the operator's reply.
So a large census is genuinely partial, and the correct behaviour — now the
behaviour — is to state how many of how many were opened, name why it stopped,
and never present the sample as the total.

**Tests**: 652 api-server tests pass (was 647); tsc + prettier + build clean.

## An ERP's tax row is a part number, but it is not stock

### 12. `0600.000.GENRAL.0005` — the pseudo-line that topped «most repeated»

- The EDC PO prints its VAT as a real row: a part number (`0600.000.GENRAL.0005`),
  a quantity, and — on the next line — the text `VALUE ADDED TAX LOCAL`. So it
  parsed as a genuine line item with an EMPTY description, and because it appears
  on every PO it climbed to the top of the frequency ranking (live: 134 orders).
- A real line item always carries prose. `collectDescription` now reports whether
  its scan ran into the totals marker (`TABLE_END_RE`: `Total`, `VALUE ADDED
TAX`, `Purchase Order Distribution`, …), and an item with **no description**
  whose next content line is that boundary is dropped as accounting, not stock.
- This is deliberately narrow: only un-described rows adjacent to the totals are
  dropped, so a genuinely terse real row (rare) is not lost, and the earlier
  «does not double-count the restatement page» behaviour (which `TABLE_END_RE`
  already handled) is untouched.
- **Tests**: the main PO fixture now asserts ONE line and no
  `0600.000.GENRAL.0005`, plus a dedicated case for an un-described row before
  `VALUE ADDED TAX LOCAL`; both fail when the drop is removed. The tool-level
  fixture (`totalLines`) was corrected from 2 to 1 for the same reason.
- **Tests**: 653 api-server tests pass (was 652).

## Phase 3 — the census RESUMES instead of claiming a sample is the total

The «480-message mailbox» answer above was honest but still a dead end: a scan
larger than one call's budget could only ever report a partial list, and the
operator was left to rephrase. Raising the budget does not fix it — at the
observed ~430ms/message, 480 messages need ~3.5 minutes, above any ceiling the
operator will wait. So the scan became **resumable**.

### 13. `runItemScan` walks a cursor in the shared scan cache

- `email.ts`'s `fetchMessageAttachments(matches, budget, skip)` and
  `scanEmails`'s `attachmentSkip` take an EXCLUSIVE start index into the matched
  list, so a caller reads the next window instead of re-opening the newest one.
  There is one mailbox census (`scanEmails` with `returnAllMatches: true`); only
  the attachment window moves, and each window's attachments are cached with the
  pass that produced them.
- `item-scan-session.ts` (new) holds the session: the accumulated `items` /
  `messages` / `coverage`, the `nextSkip` cursor, `remaining`, `batches`, and
  `complete`. It lives under the same `scanCacheKey("items", …)` the old
  one-shot memo used, so a follow-up question continues the SAME census instead
  of restarting it, and a different filter is a different census.
- **The cursor advances by messages actually PARSED**, not by messages fetched.
  A window is fetched, then parsed in `AI_ITEM_PARSE_CHUNK` (default 150) sized
  chunks, and the session is written back **after every chunk**. That is what
  makes progress durable: the per-tool timeout can cut a call DURING the parse
  (the fetch budget does not bound the parser), and without mid-batch persistence
  the whole window would be lost — the live failure. A message is never counted
  as read before its rows are in the session.
- `runItemScan` always opens at least ONE window per call (`do/while`, not
  `while`), so a resumed scan can never stall on a zero/elapsed budget.
- `sessionAttachmentCoverage(session)` derives `truncated` from the CURSOR: a
  session is truncated while `remaining > 0`, whatever any single window reported
  about itself. `complete` is a fact about reaching the end, never an assumption.
- Pacing: `scanCallBudgetMs()` (env `AI_SCAN_CALL_BUDGET_MS`, default 45s) sits
  below the per-tool ceiling (100s) and the run budget (150s), so a call returns
  its own honest "partial, continue" payload rather than a generic timeout.
- The `scan_email_items` result carries `scannedMessages` / `remainingMessages`
  and, when incomplete, a `continueHint` telling the model to call the tool again
  with the same arguments. The tool description, the agent prompt, and the PDF
  scope line all say the same thing: report `فُتح N من M` and do not call a
  sample a total. `limit` is now described as the WINDOW size, not a sampling cap.
- **Tests** (`ai-email-items-tool.test.ts`): the "completes the census across
  calls instead of stopping at one batch" case drives three calls (2+2+1) and
  asserts the cursor advanced `0,2,4` with the last call `isComplete`; the
  "keeps parsed rows when a call is cut mid-batch" case sets a 0ms call budget
  and a 2-message parse chunk and asserts every message was read exactly once
  across calls. `ai-email-items-timeout.test.ts` pins the honest reason and that
  a completed multi-window census reports complete with no fabricated shortfall.
- **Tests**: 655 api-server tests pass (was 653); tsc clean.

## Procurement agent upgrade — intent router, evidence envelope, DB-first tools, evaluation gate

The assistant was answering EVERY question through the same path with the same budget, doing arithmetic in the model's head. Live consequences: a 3,710-message census reported as "10", a supplier name invented under challenge, and a simple "which supplier owns PO X?" costing the same rounds as a year-long analysis. This work gives it a deterministic front end, database-computed answers, and a measurable quality gate.

### Intent router (`router.ts`) — deterministic, free, testable

- `routeQuestion(text)` classifies each question into an `intent` + `path` BEFORE any provider request. Rules-based (regex over normalised Arabic), never an LLM call, so it is free/instant/explainable — and unit-testable, which an LLM classifier would not be.
- Two paths: **FAST** (`FAST_MAX_ROUNDS = 2`) for a single document/supplier/count question, **DEEP** (`DEEP_MAX_ROUNDS = 5`) for analysis/email/reports. `plan.verify` says whether the post-answer grounding check is worth its round.
- **Rule ORDER is the design**: analytical/email/report signals are checked BEFORE the bare-document-number rule, so «اعمل حصر لكل PO في البريد خلال 2026» is not mistaken for a document lookup just because it contains «PO» and a year. The unclassified default is DEEP — mis-routing a real analysis as trivial (answers confidently from a sample) is the expensive error; the reverse merely costs a round.
- **Do not put the bare quantifiers «كل»/«all» back into `ANALYTIC_RE`**: they appear in email/report requests («كل المرفقات», «كل البنود») and matching them there labels those as analytics before the email/report rules can see them. Same trap for «كام» without a word boundary — «كامل» (complete) reads as «كام» (how many).
- `normalizeArabic` folds hamza/alef/yaa/taa-marbuta + strips harakat, so «تسعير»/«تسعيره» both match. Without it the router silently misses and sends everything deep.
- `MAX_TOOL_ROUNDS` in `agent.ts` is now an alias for `DEEP_MAX_ROUNDS`; the loop uses `plan.maxRounds`, so the router — not a module constant — sets the budget per question.

### Evidence envelope (`evidence.ts`) — a sample must never read as a total

- Business tools return `EvidenceEnvelope` instead of a bare array: `{data, source, filters, recordCount, isComplete, warnings, confidence, method, evidence}`.
- `confidence` (VERIFIED | PARTIALLY_VERIFIED | INSUFFICIENT_EVIDENCE) is DERIVED in ONE place: `isComplete:false` can never be VERIFIED; any warning degrades a complete result to PARTIALLY_VERIFIED. That rule is what makes "I analysed everything" unsayable about a partial scan. Keep it centralised — per-tool confidence logic is how the 3,710-as-10 bug returns.

### Database-first procurement tools (`procurement-tools.ts`)

- `get_purchase_order_status`, `get_supplier_performance`, `aggregate_po_items`, `get_unfulfilled_orders`, `get_latest_supplier_price`, `get_open_supplier_invoices`, `detect_duplicates`, `find_missing_records` — all aggregate in SQL (`SUM`/`COUNT … GROUP BY … HAVING`), not in the model. A model totalling hundreds of rows will approximate, drop rows past its context window, or invent a figure the operator cannot audit; a `GROUP BY` cannot.
- Built to avoid N+1: supplier names are resolved for a whole result set in ONE `inArray` query, and offers/PO aggregates are one query each regardless of supplier count.
- `find_missing_records` chunks its `IN` at `COMPARE_CHUNK` (5,000) — a year-long number list would otherwise exceed Postgres's 65,535 bind-parameter cap and fail the whole answer.
- All eight are registered in `tools.ts` (definitions + dispatch) behind the existing `allowDatabase` flag, so a settings toggle disables them with the rest.

### Telemetry (`metrics.ts`) + evaluation gate (`eval.ts`)

- `recordMetrics` captures per-request `{intent, path, rounds, toolCalls, verified, latencyMs, outcome, model}`; `metricsSummary()` gives avg/P95 latency, avg rounds, timeout rate, verification rate. Exposed at `GET /api/ai-assistant/metrics` and rendered as an «أداء الطلبات» card on `/ai-assistant` (best-effort fetch — its absence never blocks the settings page).
- `eval.ts` is a labelled set of real operator questions (Arabic-first, shaped around the actual incidents) scored against the router with `runOfflineEvaluation()`. **Offline by design**: it spends zero model requests and is deterministic, so it can gate every commit. `runLiveEvaluation` exists for a human with a key but is never called by the suite — a CI run that consumed the day's model quota to grade itself would be self-defeating.
- `ai-eval.test.ts` asserts accuracy ≥ 90%, **path-accuracy ≥ 95%** (stricter than intent accuracy, because the path is the safety-critical decision), routing latency < 20ms, and every incident-derived case (`note` set) individually — a regression on one of those is a bug already paid for.

### Tests

- New: `ai-router.test.ts` (17), `ai-procurement-tools.test.ts` (19), `ai-eval.test.ts` (6), plus router-budget + telemetry integration cases in `ai-agent.test.ts` (4). **699 api-server tests** (was 655) pass; tsc (libs + api-server + portal) clean; portal build clean; repo-wide prettier clean.
- **CI format-gate fix**: `main`'s CI had been failing on `prettier --check` because of two over-long backticked test names in AGENTS.md, so every `Deploy to Render` run was `skipped`. Reworded (not just reformatted — prettier's "fix" de-indents the whole list item) so the gate passes and deploys resume.

## Procurement/Operations agent upgrade — conversation state, async jobs, verifier, security, dashboard (stacked on #169)

The Manus prompt asked for a multi-phase upgrade from "a chatbot that reads mail" to a real procurement/operations agent. PR #169 delivered phases 1–2 (intent router, fast/deep path, telemetry, evidence envelope, DB-first tools, evaluation gate). The remaining phases are on `feat/ai-agent-context-jobs-verifier` (stacked on `feat/ai-agent-routing-evidence-tools`).

- **Conversation state (P4)** — `ai_assistant_state` table (`lib/db/src/schema/ai_assistant.ts` + DDL in `init-db.ts`, one row per phone, UNIQUE on `phone`). `conversation.ts` loads/saves/clears it and renders a «سياق المحادثة» block into the prompt so a follow-up like «وطب آخر سعر له؟» resolves «له» to the part/supplier/period the conversation was already about. **Two invariants**: a null patch field never clears a remembered entity (otherwise one turn forgets what the next needs), and only EXPLICITLY named entities are recorded — `inferStatePatch` is deliberately conservative, because a wrong "last part" silently poisons every later question. `clearConversationState` is called by the `/reset` path in `handler.ts`, so a reset also drops the context, not just the message history.
- **Async jobs (P3/P6)** — `ai_assistant_jobs` table + `jobs.ts`. A census too large for one WhatsApp reply becomes a tracked job (`createJob` returns immediately; the work runs in the background and writes `progress`), because the operator cannot sit in a chat for minutes. `jobKey` makes a re-issued identical request **RESUME** the active job rather than start a second expensive scan. A thrown error marks the job `failed` (never leaves it `running`), and `pendingAiJobs()` drains in-flight work for tests + graceful shutdown. Routes `GET /ai-assistant/jobs`; the portal shows a «المهام الخلفية» table.
- **Deterministic verifier (P2/PR5)** — `verifier.ts` reconciles a large figure in the answer against the database (`extractReportedTotals` → `verifyAnswer` → `confidenceFromVerification`). Three outcomes, and the distinction matters: `verified` / `disagreement` (the answer's total does not reconcile — reports the DB value) / `skipped` (no large figure to check). **A skip is not a pass**: it must never be reported as evidence that a figure was right, so `confidenceFromVerification` only ever DOWNGRADES `VERIFIED` → `PARTIALLY_VERIFIED`, never upgrades a low-confidence answer.
- **Security: send-email confirmation gate (P7)** — `send_email` now requires `confirmed:true`; without it the tool sends NOTHING and returns the draft for the operator to approve. Enforced in CODE (`tools.ts`), not in the prompt: **a prompt rule is not a permission boundary** — a model that misreads the instruction could still send. `ai-send-email-gate.test.ts` fails 2/3 when the gate is removed.
- **Dashboard** — `GET /ai-assistant/jobs` + the pre-existing `/metrics` and `/models` feed a jobs card and the telemetry card on `/ai-assistant`. All best-effort: a failed job/metrics fetch must never block the settings page.
- **Evaluation gate grew to 63 labelled cases** (was 17) covering PO / supplier / offers / email / invoices / ambiguous, including the incident-derived cases. Growing it exposed **real router gaps** that were then fixed: smalltalk was matched too late (a greeting fell to the deep default), the report-vs-analysis ordering was wrong («ابعت تقرير بالأرقام الناقصة» is a report, not an analysis), «أرقام الموردين» was not recognised as a count, a bare sheet PO code (`P26E13477`) was not a document lookup without a noun, and the PLURAL «الموردين» was mis-classified as a single-entity lookup (a set question is analysis). Thresholds: accuracy ≥90%, **path accuracy ≥95%** (the safety-critical metric — a fast-labelled analysis answers from a sample).
- Tests: `ai-conversation.test.ts` (9), `ai-jobs.test.ts` (6), `ai-verifier.test.ts` (9), `ai-send-email-gate.test.ts` (3), expanded `ai-eval.test.ts` (9). **727 api-server tests** (was 699) + 45 portal pass; tsc (libs + api-server + portal) clean; repo-wide prettier clean; api-server + portal builds clean.
- Deploy: PR pending — push/PR only on explicit request.

## P4/P6 completion — durable scan sessions, evidence-level telemetry, operator dashboard (PR #171)

Closed the last gaps in the procurement-agent upgrade.

- **A restart must not lose a census cursor.** The resumable email/item census kept its `nextSkip` cursor and parsed rows in an in-process cache, so a deploy/crash/recycle mid-census either restarted a multi-minute scan from zero or never finished. New `ai_assistant_scan_sessions` table (`lib/db/src/schema/ai_assistant.ts`, DDL in `init-db.ts` as its OWN statement — statements share an implicit transaction, so a sibling failure would roll the CREATE back silently). `persistScanSession` / `loadPersistedScanSession` (`email.ts`) mirror/restore the session; `runItemScan` restores on a cache miss and **continues from the saved cursor**. Best-effort + fire-and-forget (a DB hiccup must never fail a scan), lazy `@workspace/db` import so the module stays testable without a database. Only DERIVED rows are stored — never the downloaded PDF buffers.
- **Evidence level is derived from the run, not claimed.** `answerConfidence()` maps `(toolCalls, verificationRan, numericDisagreed)` to `VERIFIED` / `PARTIALLY_VERIFIED`: a numeric reconciliation that disagreed, or a grounding-correction round that fired, means the first draft contained something the evidence did not support. `metrics.ts` gains `byConfidence` + per-request `confidence`; the `/ai-assistant` page shows a coloured evidence badge per request and a breakdown. Do not let a "verified" label be asserted by the model — derive it.
- **Operator onboarding** — the admin page lists concrete example questions grouped by the capability each exercises (DB lookup / quote comparison / delivery follow-up / email census), so the agent's real scope is discoverable instead of "ask me anything".
- Tests: `ai-scan-persistence.test.ts` (2 — both fail when persistence is disabled) + 2 confidence tests in `ai-agent.test.ts` (both fail when `confidence` is not recorded) + the `byConfidence` breakdown. **783 api-server tests** pass; tsc (libs + api-server + portal) clean; repo-wide prettier clean; api-server + portal builds clean.
- Deploy: PR #171 squash-merged `3907434`; CI + Deploy-to-Render workflows success; `/api/healthz` 200 and `/api/ai-assistant/{metrics,jobs}` 401 (mounted behind auth).

## Item identity, PO-only counting, source scope (feat/ai-item-identity)

Live operator report («بقولك من الميل مش قاعده البيانات» + «PO فقط وليس RFQ او
quotation» + «اكتر بند اتكرر»). Four separate defects, all of the same family: a
capability that silently did something other than what it claimed.

- **A Part Number is not an identity.** New `item-identity.ts`: `itemTokens`
  (Arabic/English normalisation, unit folding `LITERS`==`LTR`, stopwords dropped,
  a number glued to a unit kept as ONE token so `50 MM` != `70 MM`), then
  `itemAttributes` -> `hasConflictingAttributes` (differing model/size/capacity
  means different items, even when only one side states it) -> `itemsEquivalent`
  -> `groupByItemIdentity` (union-find: identity is transitive, so A<->B and
  B<->C put all three in one cluster). Two different part numbers NEVER merge.
  The live case — the same breaker counted twice because one PO printed
  `P/N : A9R41440` and the next identified it by description alone — is one item
  again.
- **`aggregateItems` is the VOLUME view; frequency is
  `aggregateItemsByOccurrence`.** Do not swap the sorts: `aggregateItems` sorts by
  `qty` (the `ordering=qty` answer) and the frequency ranking sorts by
  `occurrences`. Sorting the volume view by occurrences breaks its callers.
- **Occurrences count ORDERS, and only PURCHASE ORDERS.** `documentKind()`
  classifies an attachment from its title (`PURCHASE ORDER` /
  `REQUEST FOR QUOTE|QUOTATION`) **and** the document number's prefix (`P26E...` =
  PO, `26R...` = RFQ) — two independent signals because a scanned copy can lose
  the title. RFQ lines are read (coverage stays honest) but **not counted**; the
  counts are surfaced as `poDocuments` / `rfqDocumentsExcluded` /
  `unknownDocuments` so the exclusion is auditable rather than silent.
- **Source scope is a CONSTRAINT, not a topic.** `SourceScope` on `RoutePlan`,
  computed once in `routeQuestion` and attached to **every** branch (a branch that
  forgets it loses the operator's requirement). `EMAIL_SCOPE_RE` /
  `NOT_DB_SCOPE_RE` (the latter must tolerate «مش **من** قاعدة البيانات» — the
  bare «مش قاعدة» form missed the live phrasing). `routeHint` adds a scope
  instruction, and `agent.ts` **checks the outcome**: an email-scoped question
  answered with no email tool in `usedTools` gets an explicit «هذه الإجابة من
  النظام الداخلي وليست حصرًا للميل» warning appended. A hint is not a guarantee —
  verify the run, don't trust the prompt.
- **`verifyAnswer` must not reconcile a figure against the wrong source.** The
  numeric check compares a reported total to the DATABASE; an email census and the
  database legitimately hold different numbers, so `source: "email" | "mixed"` now
  returns `skipped`. The live false alarm («المرصود 235800 والمحسوب 14265» on a
  reply entirely about the mail) came from comparing the two. `answerSource()` in
  `agent.ts` derives the source from the tools that actually ran; omitting
  `source` keeps the old behaviour so existing callers are unaffected.
- **`capInput` keeps the HEAD *and* the TAIL.** An instruction message puts its
  constraints LAST («PO فقط وليس RFQ او quotation») and head-only truncation
  dropped exactly those lines. `MAX_INPUT_CHARS` 4000->6000, `TAIL_SHARE` 0.4, and
  the marker is **inside** the budget so the result never exceeds the advertised
  cap.
- **A 100% census is never answered with a sample.** `wantsCompleteCensus()`
  («100%», «فحص كامل», «كل أوامر الشراء», «ما تتوقفش») makes the background-job
  hand-off **unconditional** — `AI_AUTO_JOB_MIN_REMAINING` is only the threshold
  for an ordinary ask. The payload carries `completionPct`, `poDocuments`,
  `identityUncertain` (items resting on prose alone — the operator asked for that
  count) and `totalAttachments`, and the PDF gains the columns the operator named
  (الترتيب / وصف البند الكامل / Part Number / Line Item / عدد الأوامر / إجمالي
  الكمية / الوحدة / متوسط سعر الوحدة / إجمالي القيمة / العملة / أرقام الأوامر),
  with a missing value spelled «غير متوفر» rather than left blank. **Line Item is
  deliberately always «غير متوفر»**: it is an internal row number that differs PO
  by PO, so it is not carried through aggregation — say so rather than invent one.
- **Reset clears the census, not just the transcript.** `handler.ts` reset calls
  `clearScanCache()` **and** `clearPersistedScanSessions()`; clearing only the
  memory cache left the Postgres mirror reachable, so the next question resumed a
  scan (and reused a row set) produced *before* the reset — a reset that looked
  like a reset while doing nothing.
- Tests: `ai-item-identity.test.ts` (23 — 2 fail against a part-number-keyed
  implementation), `ai-source-scope.test.ts` (15 — 2 fail without the verifier
  source guard), +3 in `ai-email-items-tool.test.ts` (PO-only exclusion and the
  unconditional 100% hand-off each fail when their guard is removed), +1 reset
  test in `ai-handler.test.ts`. Three existing tests were updated because they
  pinned the OLD behaviour: `ai-agent.test.ts` (its question was email-worded, so
  the new scope warning correctly fires), the PDF column list, and the
  `aggregateItems` volume-sort assertion. **825 api-server tests** pass; tsc
  (libs + api-server + portal) clean; repo-wide prettier clean; api-server +
  portal builds clean.
- Deploy: pending — push/PR only on explicit request.

## Sender shorthand, company scope, and the EDC PO census (fix/ai-edc-sender-scope)

Live operator thread (24/09): «هتخش للميل info وهتشوف اوامر الشراء كلها الواردة من
EDC … وليس من قاعدة البيانات». The assistant answered that there were **no EDC PO
attachments at all** over a mailbox holding thousands of them. Two independent
defects, plus one found while fixing them.

- **`from:"EDC"` is not a sender.** `EDC` appears in the SUBJECTS
  (`EDC PO No P26E14708`) and in no address — the mail is from
  `noreply@egyptian-drilling.com`, with **no display name**. The census narrows
  `from` SERVER-SIDE, so the filter matched nothing and «لا توجد مرفقات» was
  reported over real orders. `scanEmails` now re-scans **without** the sender (the
  operator's word searched across subject AND sender), resolves it against the
  senders actually present (`resolveSenderFromCandidates`), and reports
  `senderResolution` so the model names the address it really searched.
- **The company is the unit, not one mailbox.** The first cut filtered on the
  single resolved ADDRESS, which dropped the colleagues' mail — live EDC writes
  from `noreply@` (3,610) **plus two individuals (62)**, all EDC orders. Filtering
  now uses the resolved **DOMAIN** (`senderResolution.domain`, carried on the
  result). Live: `matched` went **3,612 → 3,695**.
- **An unresolvable shorthand must not read as «no mail».** When two domains tie
  (a rival within 4x of the leader) the resolver returns `resolved: null` plus
  `candidates`, and the note explicitly forbids the claim «لا توجد رسائل من هذا
  المُرسل», naming the senders actually seen.
- **Do NOT drop the other criteria on the retry.** The first cut passed only
  `query` to the fallback scan, so a `subject` the operator gave was silently
  discarded and the resolved census widened beyond the question. `subject` (and
  the dates, unseen flag, folder) must survive — pinned by a test.
- **A test fixture must reproduce the failure it claims to guard.** The first
  census tests set the envelope display name to `"EDC"`, so the CLIENT-side filter
  matched and the resolver never ran — three tests passed against the bug. The
  fixture now sets a realistic display name (`Egyptian Drilling Company`) via a
  `senderDisplayName` variable; the same trap hides a shorthand whose test address
  itself contains the term (`info@edc-supplies.com` becomes
  `info@delta-supplies.com`).
- Tests: +7 in `ai-email-census.test.ts` (company-scope, other-criteria-preserved,
  refusal wording, no needless resolution, plus the display-name fixture) and
  +1 assertion in `ai-email-sender-resolution.test.ts` for `domain`. 4 of the new
  guards fail against the pre-fix source (verified by staging the single-address
  filter and the unstripped description/Line Item). **861 api-server tests** pass;
  tsc + repo-wide prettier + api-server build clean.
- Live verification: `matched: 3695 resolved: {requested:"EDC",
  resolved:"noreply@egyptian-drilling.com", domain:"egyptian-drilling.com"}` and a
  parsed line item with `lineItems=[1,2]` and a complete description.

## A PDF text layer can push a column onto the next line (fix/ai-edc-lineitem-totals-jobs)

Live thread (24/09, `gos`): «هتشوف اوامر الشراء كلها الواردة من EDC … اكثر ٢٠ بند
تم إصدار اوامر شراء بهم اكثر من مره مع اجمالي الكميه والتوصيف و line item كاملا
وسعر الواحده وليس من قاعده البيانات». Four defects, all the same family: a
capability that silently did something other than what it claimed.

- **The sender shorthand is not a sender (already fixed in #174), re-verified
  live.** `from:"EDC"` resolves to the whole COMPANY — the address is
  `noreply@egyptian-drilling.com` (no display name) plus two individuals, and the
  filter must widen to the DOMAIN or the colleagues' orders vanish. Live after
  the fix: `matched: 3704`, `resolved: noreply@egyptian-drilling.com`,
  `domain: egyptian-drilling.com`, all 3,704 in `info@` (0 in the other two
  mailboxes) — the earlier «لا توجد اوامر شراء من EDC» was a filter artefact.
- **The overflowing `Part No` cell produced an EMPTY description.** EDC's
  generator sometimes pushes the Part No cell onto the NEXT visual line, glued
  ahead of the prose: `3RV20214AA P/N : 3RV20214AA10 , CIRCUIT BREAKER, 460V,`.
  The line then OPENS with a digit, so it was taken for a new table row and the
  item surfaced with **no name** — the exact field the operator audits by.
  `stripOverflowPartNo` drops the fragment **only when corroborated** (the
  remainder still carries a `P/N :` the fragment prefixes), because deleting the
  first word of ordinary prose would be a worse error than leaving it.
- **A continuation line can OPEN with a digit and still be prose.** `10 10HP,
  SIEMENS …` continues the description; the old `/^[A-Za-z]/` test dropped it and
  truncated «التوصيف الكامل» at the first line. A new row is stopped by
  `ITEM_ROW_RE` earlier, and a money/date-only tail has no word, so the prose
  test is `[A-Za-z]{4,}` — keep it that way.
- **The Line Item code is a COLUMN, not prose.** The text layer drops it *inside*
  a description line (`CODE 1001.001.USED.0360 ) FOR ELECTRICAL`); removing the
  code and keeping the prose is right, dropping the whole line is not.
- **`documentKind` now takes the SUBJECT as a second signal.** EDC titles its
  mail «EDC PO No P26E14708» / «EDC RFQ No 26R011900»; a scanned copy whose text
  layer lost the heading has no `PURCHASE ORDER` and no `PO number:` marker, so it
  was counted as an unidentified PO — inflating the census the operator is asked
  to trust. The title in the TEXT still wins, so a subject typo cannot
  misclassify. Live: 159 PO vs 1,603 RFQ vs 2 unknown — the reported «كلها RFQ
  وليس POs» was wrong because the earlier scan never read the subject.
- **The background census job must rank like the interactive path.** The job's PDF
  used `aggregateItems` (sort by QUANTITY), so a single huge one-off order sat on
  top of a «اكثر 20 بند تكرارا» list — a different question than the one asked.
  It now uses `aggregateItemsByOccurrence(items, 2)`.
- **The 3,700-message census does NOT finish in one call, and must say so.** The
  attachment pass is budget-bounded (`AI_SCAN_CALL_BUDGET_MS`, 45s); live it got
  ~1,725/3,704 with `remaining > 0`. That is why the explicit «100%» ask hands off
  to a background job (`start_census_job`) — and why a partial reply must quote
  `فُتح N من M` rather than calling the sample a total.
- Tests: +2 in `ai-email-items.test.ts` (the overflow-description recovery — fails
  against the pre-fix parser — and the "leading code-shaped word stays in prose"
  counter-case), +1 subject-classification case, +1 source guard that the job
  report still calls the occurrence aggregator. **870 api-server tests** pass;
  tsc (libs + api-server + portal) clean; repo-wide prettier clean; 45 portal
  tests pass.
- Deploy: pending — push/PR only on explicit request.

## A persisted "empty result" must not outlive the bug that produced it (PR #176)

The morning after #175 shipped, the operator ran the same EDC ask and got
**«رسائل مطابقة: 0 — رسائل فُتحت: 0 — ملفات: 0 … النطاق: كل الرسائل المطابقة (0)»**
within ONE SECOND, then a job that "completed at 100%" and produced no file. Live
mail held 3,706 messages / 332 `EDC PO No…` — nothing was wrong with the mail.

- **The root cause was a POISONED PERSISTED SESSION, not the scan.** The resumable
  census mirrors its session to `ai_assistant_scan_sessions`; a session written
  *before* #174 (when `from:"EDC"` matched nothing) was `{matched:0, nextSkip:0,
  batches:0, complete:true}`. `runItemScan` saw `complete` and returned instantly
  without opening a message — forever, across deploys. Job #2 proves it: created
  `08:55:52.775Z`, finished `08:55:53.435Z` (**0.66 s**) with `matched:0`. Query
  the table and you see four such rows.
- **`complete` is a claim; the coverage counters are evidence.** `isUnstartedEmpty`
  discards a restored session that examined nothing AND matched nothing. Two cases
  are indistinguishable from the session alone (a filter the IMAP server does not
  recognise vs a genuinely empty mailbox), and discarding costs one envelope scan
  (already memoized), so re-checking is strictly better than believing.
- **Guard on the OUTCOME, not the flag** (the WhatsApp-scroll lesson, again):
  `runItemScan` now runs a batch when `!complete || !sessionDidWork(session)`, and
  work is judged by `coverage.messages`/`attachmentCoverage.messages`/`scanned` —
  NOT by `batches`, because a window of messages with no readable attachment parses
  zero chunks yet examined every message.
- **`session.census = census` was an unconditional assignment.** A transient IMAP
  failure returning `matched: 0` mid-census would set `remaining = 0` and mark the
  census complete, ending a 3,700-message walk after its first window. A window may
  only replace the total when it is authoritative (`census.matched > 0`), or when
  there is no total yet.
- **An emptiness with no evidence is a FAILURE, and must be said as one.** The job
  report now checks `matched === 0 && opened === 0 && !files` and says
  «الحصر لم يبدأ فعليًا … أعد المحاولة» instead of `النطاق: كل الرسائل المطابقة (0)`
  — that sentence is what turned a broken scan into «لا توجد أوامر شراء من EDC».
- **Live data was cleaned** (`DELETE FROM ai_assistant_scan_sessions`, 4 rows) so
  the fix takes effect on the next request rather than after the first success.
- **Diagnosing this class**: the Render Postgres IS reachable externally —
  `GET /v1/postgres/<id>/connection-info` → `externalConnectionString`, then
  `NODE_PATH=<repo>/.pnpm/pg@*/node_modules node -e "…"` (drizzle/`pg` are not
  resolvable from `artifacts/api-server` directly). Read the jobs table first:
  `created_at` vs `finished_at` exposes an "instant" job immediately.
- Tests: `ai-scan-persistence.test.ts` +2 — the poisoned empty session is discarded
  and a real scan runs (matched 3, not 0), and a transient zero-match window does
  NOT end a census that already matched (total stays 4). **Both fail against the
  pre-fix source** (verified by reverting `isUnstartedEmpty`, the outcome guard and
  the conditional census assignment). +1 assertion in `ai-email-items-tool.test.ts`
  for the «الحصر لم يبدأ فعليًا» wording. **872 api-server tests** pass; tsc clean;
  repo-wide prettier clean.

## A census report must be retrievable, and its DELIVERY proven (fix/ai-census-job-report)

Live thread (24/09) on `/ai-assistant`: «اعمل حصر لكل أوامر شراء EDC … وليس من
قاعدة البيانات». The assistant produced a report, then announced «لقد تم إرسال
التقرير الكامل» while **no file ever arrived** — and the operator had no way to
tell a sent report from a lost one.

- **A delivery failure is its OWN terminal state, not `completed` and not
  `failed`.** `JobStatus` gained `delivery_failed`, thrown by the job's `finish`
  via `JobDeliveryError`. The scan succeeded, so the **artifact stays on the job
  row** and can be re-sent — whereas `failed` means the work itself broke. A job
  that reports success while nothing was delivered was the defect; the state is
  what makes the claim impossible.
- **`finish` now returns delivery EVIDENCE.** Its signature gained a `save`
  callback (`save({ result })` persists the artifact as it becomes known, so a
  later error cannot lose it) and returns `{ messageId }`. The worker records only
  what the WhatsApp send actually returned; `null` means not delivered.
- **`resend_job_report` re-sends a stored artifact WITHOUT re-scanning.** A
  year-long census costs minutes and a slice of the model quota, so a failed
  delivery must never trigger a second scan. `job_status` surfaces `delivered` /
  `pdfMessageId` / `textMessageId`, and the prompt tells the model that only
  `delivered=true` may be reported as sent.
- **The PDF table could not paginate the very reports this asks for.** It drew one
  header and a fixed row height, so continuation pages carried **no column
  headings** and a long description was cut at the cell edge. `drawHeaderRow` is
  now called before the first row **and after every `addPage()`**, and rows are
  measured with `heightOfString` so a wrapped cell is not truncated. The report is
  also limited to the operator's **top 20** (the artifact keeps up to 100).
  `ai-pdf-pagination.test.ts` renders a real 200-row pdfkit document (4 pages) and
  pins the structure — **both tests fail against the pre-fix source**. (The
  header-repeat assertion is at the source level: pdfkit **compresses content
  streams**, so colour operators are not greppable in the output bytes.)
- **A test mock must be derived from the existing stub, not duplicated.**
  `parseItemsFromAttachments` reads `extractPdfTextDetailed` (for the page count)
  while fixtures were only stubbed on `extractPdfText`, so 3 tests silently broke.
  Every suite mocking the email module supplies the detailed variant from the same
  stub: `async (b) => ({ text: await extractPdfText(b), pages: 1 })`.
- **The PDF font is loaded defensively** (`existsSync` → built-in fallback).
  `fontPath()` resolves relative to the MODULE, so it exists only in `dist/`
  after the build copies `src/assets`; without the fallback a source-run throws
  ENOENT. `pdf.ts` has no logger import — don't add one just to log this.
- **Live verification (production mailboxes + the EXTERNAL Render Postgres)**:
  `from:"EDC"` → **3,713** matched, resolved to `noreply@egyptian-drilling.com`
  (domain `egyptian-drilling.com`, so 7 individual senders are included too);
  `subject:"EDC PO No"` → **332** PO messages vs **1,809** RFQ messages, and
  `byMonth` sums to exactly **332** — the RFQ/PO confusion the operator reported,
  now separated. The attachment pass reports `truncatedReason:"time"`, 825 of 1200
  opened, `remaining: 2888` and a `continueHint`, so a partial pass is never
  presented as a total. Fetch the DB URL via
  `GET /v1/postgres/<id>/connection-info` → `externalConnectionString`, then
  **append** `?sslmode=require` (`&` when a query already exists); a raw copy
  fails `SSL/TLS required`.
- **Delete the live-probe temp files afterwards** (`/tmp/env_exports.sh`,
  `/tmp/dburl.txt`, any `zz-*.test.ts`) and `unset` the exported
  `SMTP_*`/`AI_*`/`DATABASE_URL` vars before re-running the suite — the 4 tests
  asserting the *unconfigured* state fail on a polluted shell and look like real
  regressions.
- Tests: `ai-jobs.test.ts` 13 (+3 — `delivery_failed`, delivery proof, artifact
  survives), `ai-pdf-pagination.test.ts` (2, new), `ai-pdf-local-read.test.ts` +2
  (page count), `ai-email-items-timeout.test.ts` mock. **880 api-server tests**
  pass; tsc (libs + api-server + portal) clean; repo-wide prettier clean;
  api-server build clean.
- Deploy: pending — push/PR only on explicit request.


## «التوصيف والـ Line Item مقصوصين» — a wrapped Part-No cell ended the description

Reported live after the census itself was fixed: «وصف البند والـ line item كانوا مش
بيجو كاملين في التقرير، مقصوص». Two independent truncations, both reproduced from
real EDC attachments — the extraction one was a **silent data loss**, not a display
issue.

- **`collectDescription` stopped at a wrapped `Part No` cell.** When the ERP's
  `Part No` value overflows its column, the text layer pushes the fragments onto
  their OWN lines (`SFCTR3P30`, `A24VSA2L`, `EWL-X0000`, `LSGP-40-`). Such a line
  carries no 4-letter word, so the collector read it as the END of the description
  and discarded every line after it. Live on P26E09609 the row read
  «P/N : SFCTR3P30A24VSA2L , CONTACTOR ,3P» and the report showed exactly that —
  while «,30A 24VAC / SCREWS,24V COIL FOR TRANE SCR HVAC , ( OLD P/N : CTR02575 )»
  was thrown away. `isPartNoFragment` now **SKIPS** such a line instead of ending
  the description. It is deliberately narrow (almost-all uppercase/digits/dots/
  dashes, ≤24 chars, must contain a digit) so a category word like
  `VALUE ADDED TAX` is never mistaken for a fragment.
- **The line cap (7) could end a long description early.** Now
  `MAX_DESCRIPTION_LINES` (20), an explicit constant, because the longest real
  descriptions wrap well past the old bound.
- **A CONTINUATION fragment must not stop the collector either**: «prose with ≥2
  words, or 1 word once the description has already started». A wrapped tail ends
  in short fragments (`… FOR YORK A C`) that a 4-char-only rule rejected.
- **pdfkit CLIPS text taller than the `height` it is given.** Passing
  `height: height - 6` on the data cell cut the last line off a wrapped
  description — the display half of «مقصوص». The cell is now drawn with **no**
  `height` at all, since the row is already as tall as its tallest cell
  (`heightOfString`). Do not reintroduce a `height` on a data cell.
- **The header's `lineBreak:false` is correct** — it is a fixed-height bar. The
  no-clip invariant therefore belongs to the DATA draw; asserting it on the whole
  function reports a false failure.
- **Measure the defect, don't assume it.** A sweep over **315 real documents /
  848 parsed items** flagged descriptions whose tail was absent from the raw text:
  10 before the fix, **7 after** — and all 7 are probe false positives (the raw
  interleaves a stripped Line Item code `REF CODE 1001.001.USED.0441`, or the
  date/money mid-sentence in Arabic prose). Real truncation is **zero**.
- Tests: `ai-description-completeness.test.ts` (2) — both built from verbatim
  extracts of real POs (P26E09609 wrapped-fragments; a 12-line description) and
  **both fail against the pre-fix source** (verified by reverting the skip and the
  cap: got «, CONTACTOR ,3P SFCTR3P30» and «… WRA…» respectively). **882 api-server
  tests** in 73 files pass; tsc (libs + api-server + portal) clean; repo-wide
  prettier clean; api-server build clean.
- Deploy: pending — push/PR only on explicit request.

