# Rfq-Manager ‚Äî Repository Notes

## Overview
Cortoba Supplies RFQ (Request for Quotation) management system. Monorepo (pnpm workspaces).

## Structure
- `artifacts/api-server/` ‚Äî Express + Drizzle ORM backend (esbuild bundle ‚Üí `dist/index.mjs`)
- `artifacts/rfq-portal/` ‚Äî React + Vite SPA frontend
- `lib/db/` ‚Äî `@workspace/db` Drizzle schema + pool (requires `DATABASE_URL`)
- `lib/api-spec/openapi.yaml` ‚Äî OpenAPI spec; clients regenerated via **orval**
- `lib/api-client-react/` ‚Äî generated React Query client
- `lib/api-zod/` ‚Äî generated zod schemas

## API routing
- API mounted at `/api` (app.ts: `app.use("/api", router)`). SPA fallback serves `index.html` for unmatched routes.
- PO routes live at `/api/po` and `/api/po/:id` (NOT `/api/purchase-orders` despite the comment in routes/index.ts).
- `/api/healthz` is the unauthenticated liveness probe (returns `{"status":"ok"}`).
- Most routes are behind `requireAuth` (session-based, checks `req.session.employeeId`). Unauthenticated ‚Üí `401 {"error":"Unauthorized"}`.
- Routes use `req.log` (pino-http). Test apps must stub `req.log` and `req.session`.

## Code generation workflow
1. Edit `lib/api-spec/openapi.yaml`.
2. Run orval to regenerate `lib/api-client-react/src/generated/*` and `lib/api-zod/src/generated/*`.
3. Build libs: `tsc --build` (root).
- **orval pitfall (duplicate schema names)**: a duplicate `components/schemas` key in `openapi.yaml` is a YAML "duplicated mapping key" error. orval reports this only as `Failed to resolve input: Please provide a valid string value` ‚Äî **after** it has already `Cleaning output folder`, which deletes the committed generated files. Validate the YAML first with `js-yaml` (`node_modules/.pnpm/js-yaml@*/node_modules/js-yaml`) before running orval. When adding a new sub-item schema, name it distinctly (e.g. `CustomerRfqLineItem`, not `CustomerRfqItem`) to avoid colliding with existing `*Item` schemas.

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
- **Schema creation**: tables are created via `artifacts/api-server/src/shared/init-db.ts` (`CREATE TABLE IF NOT EXISTS ...` run on every startup) ‚Äî NOT via `drizzle-kit push`. The `prebuild` push only runs when `DATABASE_URL` is set and is not relied upon. **Any new table MUST be added to `init-db.ts`** or it will not exist on Render and inserts will 500. The `lib/db/src/schema/*.ts` files define the Drizzle ORM objects used in code, but the DDL lives in `init-db.ts`.
- **Frontend error extraction**: the orval client (`lib/api-client-react/src/custom-fetch.ts`) throws `ApiError`, where the server JSON body is `err.data.error` (NOT `err.response.data.error` as with Axios). Use the shared `getApiErrorMessage(err)` helper (`artifacts/rfq-portal/src/lib/api-error.ts`) in mutation `onError` handlers so real server messages surface instead of a generic fallback. Older pages (suppliers) still use the broken Axios-style extractor ‚Äî fix them when touched.

## Conventions
- Arabic UI (RTL) with English code/comments. Field labels in Arabic.
- PO statuses: `draft` ‚Üí `sent`. Draft POs are fully editable; sent are immutable.
- Git: use provided GitHub token for push. Co-author commits with `openhands <openhands@all-hands.dev>`.
- Git identity: no global git config exists in this env ‚Äî set `git config user.name "openhands"` and `git config user.email "openhands@all-hands.dev"` locally before first commit.
- Token caveat: the system-managed `$GITHUB_TOKEN` env var (a `ghu_` OAuth token) has **empty OAuth scopes** and is rejected by git push (403). Use the user-provided `ghp_` classic token literally in the remote URL (e.g. `https://melsofany:<ghp_token>@github.com/...`) for push + PR creation. Reset remote to credential-less URL afterward. The `create_pr` tool also fails (403) because it uses the `ghu_` token ‚Äî create PRs directly via `curl` to `https://api.github.com/repos/<owner>/<repo>/pulls` with the `ghp_` token.

## Customer module (added in PR #9) ‚Äî `customers` table (id, customerId, name, nickname, contactPerson, email, phone, address, taxId, notes, isActive, createdAt, updatedAt). Drizzle `push` (prebuild) creates the table on deploy when `DATABASE_URL` is set.
- API: `artifacts/api-server/src/modules/users/customers.ts` ‚Äî `GET/POST /customers`, `GET/PATCH/DELETE /customers/:id`. Duplicate email/phone guarded on create + update. Delete is `requireRole("admin","manager")` and FK-aware (409 on linked records). Mounted via `modules/users/index.ts`.
- Frontend: `artifacts/rfq-portal/src/modules/customers/pages/{index,new,detail}.tsx` (list + search + delete confirm, add form, detail + inline edit + delete modal). Routes `/customers`, `/customers/new`, `/customers/:id` in `App.tsx`.
- Customers page pattern (in-place edit + delete) mirrors the suppliers module but drops categories/scores/bulk-import.

## Customer RFQ module (added in PR #11)
- DB: `lib/db/src/schema/customer_rfqs.ts` ‚Äî `customer_rfqs` (id, internalNo, customerId‚Üícustomers, customerName, customerRfqNo, numberAutoGenerated, entryDate, expiryDate, buyerName, status, notes, createdAt, updatedAt) + `customer_rfq_items` (id, customerRfqId‚Üícustomer_rfqs ON DELETE CASCADE, partNo, lineItem, uom, qty NUMERIC(15,4), createdAt). Tables created via `init-db.ts` (NOT drizzle-kit push).
- API: `artifacts/api-server/src/modules/customer-rfq/routes.ts` ‚Äî `GET/POST /customer-rfq`, `GET/PATCH/DELETE /customer-rfq/:id`. Mounted via `modules/customer-rfq/index.ts` ‚Üí `routes/index.ts`. POST auto-generates `customerRfqNo` (`CRFQ-YYYY-NNNNNN`) when blank and sets `numberAutoGenerated=true`; `internalNo` is always generated. `customerId` resolved from a typed customer name (ilike match). `lineItem` spaces stripped server-side (`replace(/\s+/g,"")`). All routes behind `requireAuth`; PATCH is draft-only.
- Frontend: `artifacts/rfq-portal/src/modules/customer-rfq/pages/{index,new,detail}.tsx`. `new.tsx` has a `CustomerCombobox` (pick existing customer or type name), optional customer-RFQ-no with live auto-generate warning banner, date pickers, buyer, multi-row items (lineItem strips on input via `replace(/\s+/g,"")`, UOM `<datalist>`, qty). `detail.tsx` shows the auto-number warning (via `?warn=auto-number` query or the `numberAutoGenerated` flag). Routes `/customer-rfq`, `/customer-rfq/new`, `/customer-rfq/:id`.
- Tests: `artifacts/api-server/src/__tests__/routes/customer-rfq.test.ts` (9 tests; uses a `chainable(value, methods)` helper that is both thenable and chainable to model drizzle's await-anywhere builders).

## Customer RFQ request status (PR #29)
- Adds a derived, progressive **request status** (حالة الطلب) shown on the customer-RFQ list + detail. Four milestones rolled up across offer/pricing/customer-PO/delivery tables:
  1. `received` — طلب وارد (default).
  2. `supplier_priced` — مُسعَّر من المورد: at least one **approved** `offer_item` links to an item of this RFQ (via `rfq_items.customer_rfq_item_id`, with partNo/lineItem fallback for legacy rows). `resolveSupplierPricedItemIds()` (in `customer-rfq/routes.ts`) reuses the same join as `resolveApprovedCosts`.
  3. `customer_priced` — مُسعَّر X%: share of the RFQ's items with `unit_price > 0`.
  4. `po_issued`/`delivered` — صدر أمر شراء / مُسلَّم X%: via `customer_po_items` rollups (`delivery_status` / `total_delivered_qty`).
- Headline stage prefers the most advanced milestone reached; numeric `customerPricingPct`/`deliveredPct` fields let the UI render richer badges.
- Backend: `CustomerRfqRequestStatus` interface + `buildRequestStatus`/`resolveSupplierPricedItemIds`/`computeRequestStatusForRfq` helpers in `modules/customer-rfq/routes.ts`. `GET /customer-rfq` (list) batch-loads items + approved-offer links + PO/delivery rollups (no N+1) and returns `requestStatus` per row. `GET /customer-rfq/:id` returns `requestStatus` + per-item `hasPo` flag. `PATCH /customer-rfq/:id` recomputes both after update.
- OpenAPI: new `CustomerRfqRequestStatus` schema, `requestStatus` on `CustomerRfq`, `hasPo` on `CustomerRfqLineItem`. Regenerated orval clients; removed the recurring `approveOfferItem{Body,200}.ts` dup-name type files + their `export *` lines in `generated/types/index.ts` to clear TS2308 (same gotcha as PR #14).
- Frontend: `customer-rfq/pages/index.tsx` gains a «حالة الطلب» column with a colored `RequestStatusBadge` (slate/blue/amber/indigo/green by stage). `customer-rfq/pages/detail.tsx` shows the status badge in the header + a new «أمر شراء» column; rows whose item already appears on an issued customer PO turn **green** (bg tint + badge) via the `hasPo` flag.
- Tests: `customer-rfq.test.ts` — 27 tests. DB mock gains a `customerPoItemsTable` branch returning per-test `poItemRows` for the request-status PO/delivery lookup; `poItemRows` initialized in `beforeEach`. List test now sets `detailItems` (not `countRows`) since the list loads actual items to compute `itemCount` + status.
- **List-hang gotcha (PR #30 fix)**: `resolveSupplierPricedItemIds` takes `withLegacyFallback` (default `true`). The per-item partNo/lineItem fallback is O(N) DB queries and **must be disabled** on the list path (passes `false`) — it hung the `/customer-rfq` page (stuck at «جارٍ التحميل...») on Render once many items lacked the FK link. The list path is a fixed set of batched queries (all RFQs → all items → one approved-offer join → one PO rollup); only the detail path keeps the fallback (one RFQ, few items).

## Customer RFQ pricing + finalize/lock (PR #13)
- DB: `customer_rfq_items.unit_price NUMERIC(15,4)` added in `init-db.ts` (CREATE TABLE + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration so existing Render tables pick it up on next startup).
- API (`routes.ts`): `computeTotal(qty, unitPrice)` helper rounds qty×price to 4dp + strips trailing zeros (mirrors `formatQty`). POST/PATCH persist `unitPrice`. GET `/:id` + PATCH responses return `unitPrice` (formatted) + `total` (server-computed). PATCH with `status:"sent"` validates **every** item has a price > 0 else 400 `أدخل سعر كل بند قبل تثبيت الطلب`; once `status="sent"` the RFQ is immutable (non-draft PATCH → 400 `لا يمكن تعديل طلب تسعير العميل بعد إرساله`).
- Frontend (`detail.tsx`): the read-only items table gains سعر الوحدة / الإجمالي columns. Drafts: price cell = `<Input type=number>`, live line total (`formatLineTotal`), grand-total footer, and a "حفظ الأسعار وتثبيت الطلب" button (confirm dialog, disabled until `allItemsPriced`) that PATCHes prices + `status:"sent"`. Sent RFQs render prices/totals read-only.
- OpenAPI: `unitPrice` in `CustomerRfqLineItemInput`; `unitPrice`+`total` in `CustomerRfqLineItem`. Regenerate via `cd lib/api-spec && ./node_modules/.bin/orval --config orval.config.ts`, then `tsc --build`.
- Tests: the db mock's `update().set(vals)` now merges `vals` onto `detailRow` so the post-update re-select sees the new `status` (needed to assert finalize → "sent"). 46 tests total.

## Workflow caveat (learned the hard way)
- **Commit before switching branches / `git reset --hard`.** Uncommitted working-tree edits are destroyed by `git reset --hard` (and by `git checkout` if it touches overlapping files). When doing a multi-edit feature, commit incrementally on the feature branch BEFORE fetching/resetting against origin, or you lose all uncommitted work irrecoverably (git never staged the blobs).

## Purchase-order items from customer POs (PR #20 → simplified PR #21)
- On `/purchase-orders/new`, the PO-number lookup is now **automatic** (no source toggle).
- Backend (`modules/po/routes.ts`): `GET /api/po/lookup/:poNo` now prefers a matching **customer PO** (entered on `/customer-po`, matched via `ilike(customerPoNo, poNo)` — case-insensitive exact). If a customer PO matches and has items, those are returned in the **SheetItem shape** (`itemId/lineItem/partNo/description/uom/qty/referencePrice/poNo`, `referencePrice` = stored `unit_price`). If no customer PO matches (or it has no items), it **falls back** to `lookupPoFromSheet` (Google Sheets) — so legacy PO numbers still resolve. Google Sheets integration is **untouched**.
- `GET /api/po/customer-po-numbers` — list `{value,label,internalNo,customerName,status}` for the combobox. (The standalone `/api/po/customer-po-lookup` endpoint from PR #20 was removed in PR #21 — the main lookup subsumes it.)
- Frontend (`modules/po/pages/new.tsx`): `useMergedPoSuggestions()` merges `/api/po/sheets/po-numbers` + `/api/po/customer-po-numbers` into one deduped list (case-insensitive; items in both keep the richer customer-PO entry). `PoNumberCombobox` shows rich two-line suggestions when `internalNo`/`customerName` exist. `handleLookup` calls the single `/api/po/lookup/:poNo`. `unitPrice` pre-filled from `referencePrice` (works for both sources — sheet returns it from column I). The field label is now **«رقم أمر الشراء»** (the old «Purchase order number (sheet column K)» + the PR #20 radio toggle are both gone).
- Imports in `po/routes.ts`: `customerPosTable`/`customerPoItemsTable` + `ilike`.

## Customer PO module (PR #17 + #18)
- DB: `customer_pos` (id, internalPoNo, customerPoNo, customerId→customers, customerName, poDate, buyerName, notes, employeeId, employeeName, status, createdAt, updatedAt) + `customer_po_items` (id, customerPoId→customer_pos ON DELETE CASCADE, customerRfqId, customerRfqItemId, partNo, lineItem, description, uom, qty NUMERIC(15,4), unitPrice NUMERIC(15,4), deliveryDate, createdAt). Tables created via `init-db.ts`.
- API: `modules/customer-po/routes.ts` — `GET/POST /customer-po`, `GET/PATCH/DELETE /customer-po/:id`. Mounted via `modules/customer-po/index.ts` → `routes/index.ts`. POST auto-generates `internalPoNo` (`CPO-YYYY-NNNNNN`), records `employeeId`/`employeeName` from `req.session`. `customerId`/`customerName` are explicit input (POST 400s without a customerName). Customer name is stored, NOT derived from a linked RFQ — works for POs without an RFQ number. `lineItem` stripped. PATCH replaces items. `status:sent` finalizes (immutable after). `GET /customer-po/:id` returns items with `unitPrice`/`total` (server-computed).
- Frontend: `modules/customer-po/pages/{index,new,detail}.tsx`. `new.tsx` has a `CustomerCombobox` (pick existing customer or type name), optional Customer-RFQ picker (pulls checked items into the PO with their qty/price/delivery date; auto-fills owning customer from the RFQ), read-only "الموظف المُدخِل" badge (logged-in employee), buyerName relabeled "المشتري (المرجع من العميل)" to disambiguate. `detail.tsx`: draft edit shows customer picker; read-only renders customerName/buyerName/employeeName. Shared `components/CustomerCombobox.tsx` (reused by new + detail) — uses `useListCustomers`; free-text allowed so a name persists even if not registered.
- Tests: `customer-po.test.ts` (17 tests; chainable+thenable DB mock; `resolveCustomerName` join path REMOVED — customer_name now read from stored column).
- orval gotcha: when a PR adds an operation/schema, the merge with main re-triggers orval dup-name TS2308; after merge-resolve, re-run `cd lib/api-spec && orval --config orval.config.ts`, delete any duplicating `approveOfferItem*.ts` type files + their `export *` lines in `generated/types/index.ts`, then `tsc --build`.

## Offer-item approval + customer-rfq margin check (PR #14)
- DB: `offer_items.is_approved` (boolean) in `lib/db/src/schema/offers.ts`; `rfq_items.customer_rfq_item_id` (FK → `customer_rfq_items.id`, nullable) in `lib/db/src/schema/rfq.ts`. Both created via ALTER TABLE in `init-db.ts` (DDL lives there, schema files define ORM objects).
- API — approve: `PATCH /api/offers/items/:offerItemId/approve` (`modules/rfq/offers.ts`). Body `{approved?: boolean}` (default `true`). Sets `is_approved` on one offer_item and un-approves the previous approved item for the same `rfq_item_id`. Logs to `audit_log`. Returns `{id, isApproved}`.
- API — offers detail: `GET /api/rfq/:id/offers` includes `offerItemId` + `isApproved` per offer (both in `analysis.itemAnalysis[].offers[]` and flat `offers.items[]`).
- API — customer-rfq finalize (margin check): PATCH `/customer-rfq/:id` with `status:"sent"` enforces `1.06 × approved supplier cost` per item (both prices EXCL VAT; `taxIncluded` items VAT-stripped). `resolveApprovedCosts()` (in `customer-rfq/routes.ts`) joins `offer_items`→`rfq_items` via `customer_rfq_item_id`, with `partNo`/`lineItem` fallback. Violations → `400 {error, marginViolations}`. Admin (`req.session.role==="admin"`) may pass `overrideMarginCheck:true` (audited).
- Frontend: `rfq/pages/detail.tsx` offers tab gains "اعتماد السعر" column + per-supplier approve toggle (one approved per item). `rfq/pages/new.tsx` sends `customerRfqItemId` per rfq_item.
- Tests: `customer-rfq.test.ts` extended with margin-clear/violation/no-approved/admin-override — DB mock returns `approvedRows` for `offerItemsTable` joins (`.innerJoin`) and uses mutable `sessionState.role`. New `offer-approve.test.ts`. **Gotcha**: do NOT set `req.ip` in test middleware (getter-only, throws); route reads it via `req.ip` (undefined in tests, fine).
- orval regen gotcha: after adding operations, orval emits a zod const in `generated/api.ts` AND a type file in `generated/types/` (e.g. `approveOfferItemBody.ts`). The zod `index.ts` `export *` from both causes TS2308. Fix: delete the duplicating type files + their `export *` lines in `generated/types/index.ts`.

## Customer PO module (PR #17)
- DB: `lib/db/src/schema/customer_pos.ts` — `customer_pos` (id, internalPoNo, customerPoNo, poDate, buyerName, employeeId→employees, employeeName, customerName, status, notes, createdAt, updatedAt) + `customer_po_items` (id, customerPoId→customer_pos ON DELETE CASCADE, customerRfqId nullable, customerRfqItemId nullable, partNo, lineItem, description, uom, qty, unitPrice, deliveryDate, createdAt). Tables created via `init-db.ts` (NOT drizzle-kit push). `customer_rfq_item_id` is **not unique** — the same item may be ordered again on a later PO (partial shipment).
- API (`modules/customer-po/routes.ts`): `GET/POST /customer-po`, `GET/PATCH/DELETE /customer-po/:id`, plus `GET /customer-po/customer-rfqs` (light RFQ picker list). POST auto-generates `internalPoNo` (`CPO-YYYY-NNNNNN`) via `generateInternalPoNo` (select maxNo). `resolveCustomerName(poId)` does `select({name}).from(poItems).innerJoin(rfqs).where(poId).limit()` → sets `customerName` from the first RFQ-linked item (null for manual-only POs). `lineItem` spaces stripped server-side. NUMERIC qty/unitPrice formatted; `total = qty×unitPrice` computed on read. PATCH draft-only; `status:"sent"` finalizes (immutable). DELETE draft-only. All routes behind `requireAuth` + `audit_log`. Employee recorded from `req.session.employeeId` (+ name lookup).
- Frontend (`customer-po/pages/{index,new,detail}.tsx`): index=list+search; new=PO header + optional **CustomerRfqPicker** (combobox) that loads the RFQ's items via `useGetCustomerRfq` and renders a checklist; checked items are appended as PO rows (partNo/desc/uom pre-filled, qty/price/deliveryDate editable); manual rows for POs with no RFQ. detail=read-only items table with line totals + grand total + draft edit/finalize/delete. Routes `/customer-po`, `/customer-po/new`, `/customer-po/:id`.
- OpenAPI: `customer-po` tag, 3 paths, 7 schemas (`CustomerPo`/`CustomerPoCustomerRfqOption`/`CustomerPoLineItem[Input]`/`CustomerPoInput`/`CustomerPoUpdate`/`CustomerPoDetail`).
- Tests: `__tests__/routes/customer-po.test.ts` (16). DB mock: `customerPoItemsTable` (bare select) branches on arg having `name` (→ resolveCustomerName via `.innerJoin`) vs no arg (→ detail items via `.where()`); `customerPosTable` with `{maxNo}` arg → generateInternalPoNo; with `{po}` arg → list (`orderBy`); bare → detail row (`where`). `update().set(vals)` reflects onto `detailRow`.
- orval regen note: regenerating re-creates the orphan `approveOfferItem{Body,200}.ts` type files (deleted in PR #14 to fix TS2308). After each orval run, delete them + their `export *` lines in `generated/types/index.ts` again, or `tsc --build` fails with TS2308.

## Goods receipt / delivery / accounts module (receipts & realized margin)
- DB: `lib/db/src/schema/receipts_deliveries.ts` — `po_item_receipts` (id, poItemId→purchase_order_items, poId, receivedQty, acceptedQty, rejectedQty, rejectionReason, actualCost NUMERIC(15,4), receiptStatus, receivedBy, receivedAt) + `customer_po_item_deliveries` (id, customerPoItemId→customer_po_items, customerPoId, deliveredQty, deliveryStatus, deliveredBy, deliveredAt). Added fields: `purchase_order_items` (`customerPoItemId`, `totalReceivedQty`, `totalAcceptedQty`, `totalRejectedQty`, `finalActualCost`, `lineStatus`), `customer_po_items` (`totalDeliveredQty`, `deliveryStatus`), `work_order_assignments.poItemId`. All DDL in `init-db.ts` (CREATE TABLE IF NOT EXISTS + ALTER TABLE … ADD COLUMN IF NOT EXISTS).
- API receipts (`modules/po/receipts.ts`): `GET /po/:id/receipts` (list), `POST /po/:id/receipts` (create a receipt row; `postpone:true` shortcut sets `lineStatus=postponed`), `PATCH /po/receipts/:receiptId`, `DELETE /po/receipts/:receiptId` (re-aggregates after every write). Aggregation: Σ received/accepted/rejected, weighted-avg `finalActualCost`, `lineStatus` = fulfilled|partial|rejected|postponed|pending. `REJECTION_REASONS` exported here (shared with WhatsApp flow). `POST /po/:id/send-receipt-prompts` sends a per-item interactive WhatsApp button per line to the representative. `normalizePhone` is exported from `po/routes.ts`.
- API deliveries (`modules/customer-po/deliveries.ts`): `GET /customer-po/:id/deliveries`, `POST /customer-po/:id/deliveries`, `PATCH/DELETE /customer-po/deliveries/:deliveryId`; re-aggregates `totalDeliveredQty`/`deliveryStatus` on `customer_po_items`.
- API accounts (`modules/accounts/routes.ts`): `GET /accounts/margins` (per-line realized margin joining `customer_po_items` ↔ `purchase_order_items` via `customerPoItemId`; revenue=qty×sellUnitPrice, cost=acceptedQty×finalActualCost, margin + marginPct; `onlyLoss` filter), `GET /accounts/margins/summary` (totals + loss-lines count). Filters: `customerName`, `from`, `to`.
- Session: `SessionData` gained optional `employeeName`, set on login (used by receipts/deliveries `receivedBy`).
- WhatsApp (`communications/service.ts` + `routes.ts`): new `sendRepresentativeItemReceiptWhatsApp` (per-line تم-الاستلام/رفض buttons, payload `work_order_item:<poNo>:<poItemId>:<action>`) and `sendRejectionReasonOptions` (interactive list of `REJECTION_REASONS`, payload `work_order_reason:<poNo>:<poItemId>:<reason>`). Inbound `handleWorkOrderItemButton` creates a full-qty `po_item_receipts` row on "received", or prompts for reason then records a full-qty rejection. Legacy whole-PO flow (`work_order:`) preserved and runs only when the per-item flow declines the payload. Uses `ActionList`/`ListSection`/`Row` from whatsapp-api-js (rest-parameter constructors need a guaranteed non-empty tuple: `new ListSection(title, firstRow, ...rest)`).
- Frontend: `/purchase-orders` page now has Tabs — «أوامر الشراء» (existing list) and «استلام التوريدات» (`modules/po/pages/receipts.tsx`): expandable PO rows → per-line receipt form (received/accepted/rejected/actualCost/rejectionReason) + postpone + send-receipt-prompts to representative. `/accounts` page (`modules/accounts/pages/index.tsx`): summary cards (revenue/cost/margin/loss-lines) + filterable margins table (loss rows highlighted red). Sidebar entry `nav.accounts` (Calculator icon) + i18n. These new pages use direct `fetch("/api/...", {credentials:"include"})` (NOT orval) since the endpoints aren't in the OpenAPI spec — same pattern as other non-spec calls.

