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

## Conventions
- Arabic UI (RTL) with English code/comments. Field labels in Arabic.
- PO statuses: `draft` → `sent`. Draft POs are fully editable; sent are immutable.
- Git: use provided GitHub token for push. Co-author commits with `openhands <openhands@all-hands.dev>`.
