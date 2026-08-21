# Cortoba Supplies — RFQ Manager

A full procurement platform for قرطبة للتوريدات (Cortoba Supplies) — manages the complete RFQ lifecycle from creation through supplier quotation to offer analysis.

## Getting Started

```bash
pnpm install
```

### Environment variables

| Variable         | Description                                                             |
| ---------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`   | PostgreSQL connection string                                            |
| `SESSION_SECRET` | Express session signing key — **required in production** (server refuses to start without it). Generate with `openssl rand -base64 48` |
| `ALLOWED_ORIGINS`| Optional comma-separated extra CORS origins (same-origin SPA is always allowed) |
| `SMTP_HOST`      | SMTP host (default: smtp.gmail.com)                                     |
| `SMTP_USER`      | SMTP username                                                           |
| `SMTP_PASS`      | SMTP password / app password                                            |

## Development

```bash
# API server — http://localhost:8080
pnpm --filter @workspace/api-server run dev

# Frontend — http://localhost:3000
pnpm --filter @workspace/rfq-portal run dev
```

## Scripts

```bash
pnpm run typecheck          # TypeScript check all packages
pnpm run test               # Run all tests
pnpm run format             # Format with Prettier
pnpm --filter @workspace/db run push   # Push DB schema (dev only)
```

## Stack

| Layer      | Tech                                              |
| ---------- | ------------------------------------------------- |
| API        | Express 5, express-session, bcryptjs, nodemailer  |
| DB         | PostgreSQL, Drizzle ORM                           |
| Frontend   | React 19, Vite, TailwindCSS v4, shadcn/ui, Wouter |
| Validation | Zod, drizzle-zod                                  |
| Tests      | Vitest, Testing Library                           |
| Build      | pnpm workspaces, TypeScript 5.9, esbuild          |

## Project Structure

```
artifacts/api-server/     # Express API server
artifacts/rfq-portal/     # React frontend
lib/db/                   # Drizzle schema & migrations
lib/api-spec/             # OpenAPI spec + codegen config
lib/api-client-react/     # Auto-generated React Query hooks
lib/api-zod/              # Auto-generated Zod schemas
```

## Features

- **RFQ Management** — Create RFQs with internal CRQ-YYYY-XXXXXX numbering, manage line items
- **Supplier Distribution** — Send RFQs via email with unique token-based pricing links
- **Offer Analysis** — Side-by-side comparison with price deviation flags
- **Supplier Portal** — Public `/q/:token` page for supplier price submission (no login required)
- **Supplier Directory** — CRUD with categories, scorecards (response rate, price, on-time, quality)
- **Analytics** — Response rates, supplier leaderboard, RFQ status distribution
- **Audit Log** — Full activity trail (admin only)
- **Role-based access** — admin / manager / purchasing

## Deployment

The app is deployed on [Render](https://render.com). CI/CD runs via GitHub Actions:

- **CI** — typecheck + tests on every push / pull request
- **Deploy** — auto-deploy to Render on push to `main` after CI passes
