---
name: RFQ Manager Project
description: Context about the Cortoba Supplies RFQ procurement app imported from GitHub
---

# Cortoba Supplies RFQ Manager

## What it is
Full procurement platform for قرطبة للتوريدات. Imported from https://github.com/melsofany/Rfq-Manager into this workspace.

## Stack
- Frontend: React + Vite + TailwindCSS v4 + shadcn/ui + Wouter — artifact `rfq-portal` at `/`
- Backend: Express 5 + express-session + bcryptjs — artifact `api-server` at `/api`
- DB: PostgreSQL + Drizzle ORM
- Auth: session-based, bcryptjs (NOT native bcrypt — build script approval issues)

## Seed accounts
Passwords now read from env vars: SEED_ADMIN_PASS, SEED_MANAGER_PASS, SEED_STAFF_PASS
Fallback defaults changed from original hardcoded ones. Accounts:
- admin@cortoba-supplies.com (admin role)
- khalid@cortoba-supplies.com (manager role)
- sara@cortoba-supplies.com (purchasing role)

**Why:** Original repo had plaintext passwords in replit.md (public GitHub) and initDb.ts — security risk fixed.

## Key security fixes applied
- replit.md: removed plaintext passwords, replaced with env var instructions
- scripts/seed.mjs: now requires SEED_*_PASS env vars (throws if missing)
- artifacts/api-server/src/lib/initDb.ts: passwords now read from SEED_*_PASS env vars with safe fallback defaults

## Important gotchas
- bcryptjs (pure JS) must be used, NOT bcrypt (native) — native requires build script approval
- `/q/:token` supplier pricing route must be public (no auth middleware)
- initDb runs on every server startup, idempotent via ON CONFLICT DO NOTHING / DO UPDATE SET role
- Session cookie: secure:true + sameSite:none only in production
- Render deployment: Service ID srv-d894ofmq1p3s73fh04vg

**Why:** bcrypt native fails because Replit blocks unapproved build scripts.

## GitHub repo credential exposure note
The original public GitHub repo still contains the old replit.md with plaintext passwords. User should either:
1. Force-push the cleaned replit.md to GitHub
2. Or make the repo private

## Port assignments
- api-server: 8080 (paths: ["/api"])
- rfq-portal: 20663 (paths: ["/"])
