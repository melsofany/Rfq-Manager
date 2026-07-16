# Cortoba Supplies — RFQ Management System

A full procurement platform for قرطبة للتوريدات (Cortoba Supplies) — manages the complete RFQ workflow from creation through supplier quotation to offer analysis.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/rfq-portal run dev` — run the frontend (port 20663)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string, `SESSION_SECRET` — session signing key, `SMTP_PASS` — Gmail app password

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + express-session + bcryptjs + nodemailer
- DB: PostgreSQL + Drizzle ORM
- Frontend: React + Vite + TailwindCSS v4 + shadcn/ui + Wouter routing
- Charts: Recharts
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — source of truth for the API contract
- `lib/db/src/schema/` — all Drizzle table definitions
- `lib/api-client-react/src/generated/` — auto-generated React Query hooks (DO NOT edit)
- `artifacts/api-server/src/routes/` — Express route handlers (auth, rfq, suppliers, pricing, analytics, offers, audit)
- `artifacts/rfq-portal/src/pages/` — all frontend pages
- `artifacts/rfq-portal/src/index.css` — CSS variables / design tokens

## Architecture decisions

- Contract-first API: OpenAPI spec drives code generation for both Zod validators and React Query hooks
- Token-based supplier pricing links: each sent RFQ generates a unique `base64url` token; supplier clicks the link at `/q/:token` without needing an account
- Session-based auth (express-session) with cookie transport; `credentials: true` on CORS
- bcryptjs (pure JS) used instead of bcrypt (native) to avoid build script approval requirement
- All routes mounted under `/api` prefix; proxy strips nothing — services handle full paths

## Product

- **Login** — Email/password auth with role-based access (admin, manager, purchasing)
- **Dashboard** — KPI cards, RFQ status chart, top suppliers, recent activity
- **RFQ Management** — Create RFQs with internal CRQ-YYYY-XXXXXX numbering, add line items, send to suppliers via email with unique pricing links, view sent log (tracking opens/submissions), analyze received offers side-by-side with price deviation flags
- **Supplier Portal** — `/q/:token` public page where suppliers enter unit prices, tax, lead time per item and submit their quotation
- **Supplier Directory** — CRUD with category filter, supplier scorecard (response rate, price, on-time, quality)
- **Analytics** — Response rate charts, supplier leaderboard, RFQ status distribution
- **Employees** — Admin-only user management
- **Audit Log** — Admin-only full activity trail

## Seed Accounts

> **⚠️ SECURITY NOTE:** Seed account passwords are set via environment variables or generated at seed time.
> Run `node scripts/seed.mjs` after setting `DATABASE_URL` to create initial accounts.
> Change all passwords immediately after first login in any production environment.

- Admin: `admin@cortoba-supplies.com`
- Manager: `khalid@cortoba-supplies.com`
- Staff: `sara@cortoba-supplies.com`

## SMTP Configuration

- Host: smtp.gmail.com:587
- User: Set via `SMTP_USER` environment variable
- Password: Set via `SMTP_PASS` environment variable (use a Gmail App Password)

## User preferences

- English UI; Arabic company name "قرطبة للتوريدات" displayed alongside English
- No emojis in the UI
- Internal RFQ numbers: `CRQ-YYYY-XXXXXX` format
- No WhatsApp integration (user declined)

## Gotchas

- Do not use `bcrypt` (native) — it requires build script approval in this environment; use `bcryptjs` instead
- The `/q/:token` pricing route must be public (no auth middleware) — suppliers access it without accounts
- Session cookie `secure: true` only in production; `sameSite: none` in production for cross-origin proxy
- `pnpm --filter @workspace/api-server run build` builds with esbuild; PORT and BASE_PATH are injected by workflow

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
