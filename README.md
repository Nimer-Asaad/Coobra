# COOBRA

Bilingual (Arabic / English) delivery management platform.

**Phase 1:** monorepo, authentication, role-based authorization, bilingual UI with RTL/LTR.
**Phase 2:** shipments — creation by merchants and by operations staff on a merchant's behalf,
controlled lifecycle with status history, driver assignment, delivery with cash-on-delivery
confirmation, admin/merchant/driver screens. See [docs/shipments.md](docs/shipments.md).
Settlements and accounting are not implemented yet.

## Applications and packages

| Path                   | What it is                                                                  |
| ---------------------- | --------------------------------------------------------------------------- |
| `apps/api`             | NestJS REST API (auth, sessions, RBAC, users, health)                       |
| `apps/admin-web`       | Next.js admin console for SUPER_ADMIN, ACCOUNTANT, OWNER_VIEWER, OPERATIONS |
| `apps/driver-app`      | Expo (iOS / Android / web) app for DRIVER                                   |
| `apps/merchant-app`    | Expo (iOS / Android / web) app for MERCHANT, with public self-registration  |
| `packages/database`    | Prisma schema, migrations and generated client (PostgreSQL)                 |
| `packages/shared`      | Roles, languages, zod validation schemas, error codes, API types            |
| `packages/i18n`        | Arabic + English translations and i18next helpers                           |
| `packages/mobile-core` | Shared Expo layer: API client, session/language state, RTL, auth screens    |

`packages/mobile-core` was added beyond the three requested shared packages so the driver and
merchant apps do not duplicate their authentication screens and session logic.

## Tech stack

pnpm workspaces + Turborepo · TypeScript 6 · NestJS 12 · PostgreSQL 16 + Prisma 7 ·
Next.js 16 + Tailwind CSS 4 + shadcn/ui-style components · Expo SDK 58 + Expo Router +
React Native Web · TanStack Query · Zustand · i18next / react-i18next · zod · Argon2id.

## Prerequisites

- Node.js ≥ 22.12 and pnpm 10 (`corepack enable`)
- Docker (for PostgreSQL and the Mailpit development mail server), **or** your own PostgreSQL 16

## Getting started

```bash
pnpm install

# 1. Environment
cp .env.example .env                     # set POSTGRES_PASSWORD, DATABASE_URL, TEST_DATABASE_URL
cp apps/admin-web/.env.example apps/admin-web/.env.local
cp apps/driver-app/.env.example apps/driver-app/.env
cp apps/merchant-app/.env.example apps/merchant-app/.env

# 2. Services (PostgreSQL on :5432, Mailpit SMTP :1025 / UI http://localhost:8025)
docker compose up -d

# 3. Database
pnpm db:deploy                           # apply migrations

# 4. Build shared packages and the API once
pnpm build

# 5. Create the first SUPER_ADMIN (no credentials are hard-coded)
SUPER_ADMIN_EMAIL=you@example.com SUPER_ADMIN_NAME="Your Name" \
SUPER_ADMIN_PASSWORD='choose-a-strong-password-1' pnpm admin:create-super-admin
```

## Running the applications

| App          | Command                                    | URL                   |
| ------------ | ------------------------------------------ | --------------------- |
| API          | `pnpm --filter @coobra/api dev`            | http://localhost:4000 |
| Admin web    | `pnpm --filter @coobra/admin-web dev`      | http://localhost:3000 |
| Driver app   | `pnpm --filter @coobra/driver-app start`   | Expo dev server :8081 |
| Merchant app | `pnpm --filter @coobra/merchant-app start` | Expo dev server :8082 |
| Everything   | `pnpm dev`                                 |                       |

In the Expo dev server press `w` for web, `a` for Android, `i` for iOS, or scan the QR code with
Expo Go. On a physical phone set `EXPO_PUBLIC_API_URL` to your computer's LAN IP.

Health checks: `GET /health` (liveness) and `GET /health/ready` (database connectivity).
All other API routes are under `/v1`.

## Quality checks

```bash
pnpm lint
pnpm typecheck
pnpm test                 # unit tests
pnpm test:integration     # API tests against a REAL PostgreSQL (TEST_DATABASE_URL); wipes that DB
pnpm build
pnpm export:web           # Expo web export of both mobile apps
pnpm db:validate
pnpm format:check
```

## Documentation

- [Architecture and authentication](docs/architecture.md)
- [Shipments: roles, lifecycle, COD and API (Phase 2)](docs/shipments.md)
- [Impersonation design (not implemented)](docs/impersonation.md)
- [Git workflow and establishing `main`](docs/git-workflow.md)
