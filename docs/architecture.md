# Architecture (Phase 1)

## Monorepo

```
apps/
  api/            NestJS REST API
  admin-web/      Next.js admin console (BFF + UI)
  driver-app/     Expo Router app (iOS, Android, web)
  merchant-app/   Expo Router app (iOS, Android, web)
packages/
  database/       Prisma schema, migrations, generated client
  shared/         Roles, languages, zod schemas, error codes, API types (no runtime deps but zod)
  i18n/           ar/en resources + i18next helpers (used by API emails and every UI)
  mobile-core/    Shared React Native layer for both Expo apps (source-only, compiled by Metro)
```

`shared`, `i18n` and `database` compile to ESM in `dist/`. Turborepo builds them before any app
(`dependsOn: ["^build"]`). The API is ESM (NestJS 12 is ESM-only).

## Validation and errors

- One set of **zod schemas** in `@coobra/shared` is used by the API (`ZodValidationPipe`) and by
  every client for instant feedback. Messages are **i18n keys** (`validation.email.invalid`),
  so errors are translated on the client in the user's language.
- The API always returns `{ statusCode, code, message, fieldErrors? }`. `code` is a stable
  `ErrorCode`, translated by clients through `errors.<CODE>`. `message` is developer-only.
- Unknown fields are stripped by zod (e.g. a `role` sent to `/auth/register` is ignored).

## Authentication

| Endpoint                            | Access                  | Notes                                             |
| ----------------------------------- | ----------------------- | ------------------------------------------------- |
| `POST /v1/auth/register`            | public, 5/min/IP        | Always creates a **MERCHANT**; sends verification |
| `POST /v1/auth/login`               | public, 10/min/IP       | Requires `clientApp`; role must match the app     |
| `POST /v1/auth/logout`              | session                 | Revokes the current session                       |
| `GET  /v1/auth/me`                  | session (unverified ok) |                                                   |
| `POST /v1/auth/forgot-password`     | public, 5/min/IP        | Always `202`, never reveals whether email exists  |
| `POST /v1/auth/reset-password`      | public                  | Also completes invited users' account setup       |
| `POST /v1/auth/verify-email`        | public                  | Single-use token from the email link              |
| `POST /v1/auth/resend-verification` | session (unverified ok) | 3/min                                             |
| `PATCH /v1/me/preferences`          | session (unverified ok) | Language                                          |
| `GET/POST /v1/admin/users`          | SUPER_ADMIN             | Create staff/drivers by invitation (no passwords) |

### Passwords

Argon2id (`argon2` native binding), OWASP parameters: 19 MiB memory, 2 iterations,
parallelism 1. Hashes are re-computed on login if the parameters change. Logins for unknown
emails verify against a dummy hash so response time does not reveal which emails exist.
Policy: 10–128 characters, at least one letter and one digit (any script, so Arabic works).

### Sessions

- Opaque 256-bit random tokens; the database stores only their SHA-256 hash (`sessions` table).
  Sessions are revocable instantly (logout, password reset revokes all of a user's sessions,
  disabled users and role changes invalidate them).
- Absolute lifetime: 12 h for the admin console, 30 days for mobile apps (configurable).
- A session is bound to a `clientApp`; DRIVER can only sign in to the driver app, MERCHANT to
  the merchant app, staff roles to the admin console.
- **Transport per client:**
  - _Native apps_: `Authorization: Bearer` token kept in the OS keychain/keystore
    (`expo-secure-store`).
  - _Expo web builds_: `x-auth-transport: cookie` → the API sets an **httpOnly, SameSite=Strict**
    cookie; the token is never readable by JavaScript and never stored in `localStorage`.
    Cookie-authenticated state-changing requests must carry an `Origin` from `CORS_ORIGINS`
    (CSRF defence). In production the web apps and the API must share a registrable domain
    (e.g. `app.coobra.example` and `api.coobra.example`).
  - _Admin console_: Backend-for-Frontend. Next.js route handlers call the API server-to-server
    and keep the token in its own httpOnly, SameSite=Strict cookie. The browser only talks to
    `/api/session/*` and an allow-listed `/api/bff/*` proxy, with same-origin checks on writes.

### Authorization

A global `AuthGuard` makes every route private by default. `@Public()` opts out,
`@AllowUnverifiedEmail()` allows signed-in but unverified users, `@Roles(...)` restricts roles.
UI navigation is filtered by role too, but the API is the source of truth.

### Account creation

- Merchants self-register (public). The role is hard-coded server-side.
- The first SUPER_ADMIN is created with `pnpm admin:create-super-admin` (env-provided
  credentials, refuses if one already exists).
- Staff and drivers are created by a SUPER_ADMIN. They receive a single-use **account setup**
  link (72 h) to choose their own password; administrators never see or set passwords.

### Email

Localised (ar/en, `dir` set in HTML) emails for verification (24 h), password reset (30 min)
and account setup (72 h). Links point to the app that matches the user's role. Transport is
SMTP (Mailpit in development). A console transport exists for development and is rejected by
configuration when `NODE_ENV=production`.

### Audit log

`audit_logs` records registrations, successful/failed logins, logouts, password reset
requests/completions, email verification, user creation and preference changes, with IP and
user agent. `actorUserId` is always the real human — this is the foundation for impersonation.

## Data model (Phase 1)

`users`, `merchant_profiles`, `sessions`, `auth_tokens`, `audit_logs` — see
`packages/database/prisma/schema.prisma` and the `init_auth` migration.

## Internationalisation and RTL

- Languages: Arabic (`ar`, RTL) and English (`en`, LTR). Resources live in `@coobra/i18n`;
  a test enforces that both locales have exactly the same keys.
- **First launch**: every app shows a bilingual language picker before any auth screen.
- **Persistence**: admin web → `coobra_lang` cookie; mobile → secure storage (native) /
  `localStorage` (web). When signed in the choice is also saved to the user's account
  (`PATCH /v1/me/preferences`), which decides the language of emails.
- **Admin web**: `<html lang dir>` is rendered server-side from the cookie; Tailwind logical
  utilities (`ms-*`, `text-start`, …) flip automatically.
- **Mobile**: the root view uses the Yoga `direction` style, so layout flips immediately when the
  language changes. `I18nManager.forceRTL` is also updated so native behaviour (navigation
  gestures, system UI) follows after a restart — the Settings screen tells the user when a
  restart is needed. `expo-localization` is configured with `supportsRTL: true`.
  On web, `<html dir>` is set directly.
- Emails, phone numbers and other Latin-script values are rendered LTR inside RTL layouts.
