# Production deployment

What a production deployment of COOBRA needs, how to roll it out safely, and how to recover.
Design background: `docs/adr/0003-phase4c-impersonation.md` (R4, §7, §13).

## 1. Topology and HTTPS

- The API, the admin console and the merchant and driver web apps are served over HTTPS on hosts
  of one site that the owner chooses (`IMPERSONATION_SITE`, e.g. `coobra.ps`): for example
  `api.coobra.ps`, `admin.coobra.ps`, `merchant.coobra.ps` and `driver.coobra.ps`.
- TLS ends at the HTTPS edge (load balancer, CDN or ingress). Redirect HTTP to HTTPS there.
- **HSTS is set at the edge**, not by the apps:
  `Strict-Transport-Security: max-age=31536000; includeSubDomains`. Start with a short
  `max-age` (e.g. 300) for the first deployment, then raise it. Add `includeSubDomains` only when
  every subdomain of the site serves HTTPS. Do not add `preload` without a separate decision.
- **Do not set `Cross-Origin-Opener-Policy: same-origin`** on the admin console or the merchant
  and driver web apps. The impersonation hand-off needs `window.opener` between the console and
  the app tab (`same-origin-allow-popups` on the console only is acceptable).
- The admin console sends its own Content Security Policy (`apps/admin-web/src/proxy.ts`): scripts
  only with the per-request nonce, connections only to its own origin, no framing. A proxy must
  not strip or replace that header. The API sends Helmet's headers.
- The API must be reachable **only through the proxy** (firewall or private network). If clients
  can reach it directly, they can choose the address the API sees (see §3).

## 2. Required environment

The API refuses to start in production when `COOKIE_SECURE`, `MAIL_TRANSPORT`, `TRUST_PROXY` or
`RATE_LIMIT_ENABLED` is wrong. Impersonation fails closed (stays off, the rest works) when the
deployment does not qualify (R4); the reason is logged at start-up.

### API

| Variable                         | Production value                                                   |
| -------------------------------- | ------------------------------------------------------------------ |
| `NODE_ENV`                       | `production`                                                       |
| `DATABASE_URL`                   | The production database (from the secret manager)                  |
| `CORS_ORIGINS`                   | Exact origins of the admin, merchant and driver web apps           |
| `COOKIE_SECURE`                  | `true` (required)                                                  |
| `TRUST_PROXY`                    | The number of proxies in front of the API; see §3 (required)       |
| `RATE_LIMIT_ENABLED`             | `true` (required)                                                  |
| `API_PUBLIC_URL`                 | `https://api.<site>`                                               |
| `ADMIN_WEB_URL`                  | `https://admin.<site>`                                             |
| `MERCHANT_APP_URL`               | `https://merchant.<site>`                                          |
| `DRIVER_APP_URL`                 | `https://driver.<site>`                                            |
| `IMPERSONATION_SITE`             | `<site>`, the registrable domain all hosts belong to               |
| `MAIL_TRANSPORT`, `SMTP_*`       | `smtp` and the provider's settings (password from the secrets)     |
| `MAIL_FROM`                      | The sender address                                                 |
| `IMPERSONATION_SWEEPER_ENABLED`  | `true` (default; runs safely on every instance)                    |
| `IMPERSONATION_WRITES_ENABLED`   | `false` until the owner approves impersonated writes in production |
| `CONSEQUENCE_SIGNING_KEYS`       | Only with writes enabled: `<kid>:<secret>`; see §5                 |
| `CONSEQUENCE_SIGNING_ACTIVE_KEY` | Only with writes enabled: the `kid` that signs                     |

### Admin console

`API_URL` (the API's address as the console's server reaches it), `MERCHANT_APP_URL` and
`DRIVER_APP_URL` (same values as the API's). Without the two app URLs the console does not offer
impersonation.

### Merchant and driver web apps (build time)

`EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_ADMIN_WEB_URL` (the console's exact origin, the only
window allowed to hand over an impersonation).

### Start-up check

Each API instance logs one `Security:` line, for example
`Security: rate limiting on, trusted proxies 1, impersonation on, impersonated writes off`,
followed by an error naming the settings (never their values) if impersonation or requested
impersonated writes are off. Check it after every deployment.

## 3. Reverse proxy trust (`TRUST_PROXY`)

`TRUST_PROXY` is the number of proxies between the internet and the API that append to
`X-Forwarded-For`. Express then takes the client address from that many hops from the right. It
decides the address used by rate limits and recorded in the audit log, so it is never guessed:

1. List the hops: e.g. CDN → load balancer → API is 2; load balancer → API is 1; a directly
   exposed API is 0.
2. Make sure every hop appends (not replaces) `X-Forwarded-For`, and the first hop discards a
   client-supplied one if the provider supports it.
3. Set `TRUST_PROXY` to that number and deploy.
4. Verify: the API logs a `ProxyTrust` error once per process when what arrives does not match:
   - `TRUST_PROXY is 0` but requests carry `X-Forwarded-For`: a proxy is in front; set the count;
   - `fewer forwarded hops than TRUST_PROXY`: the API is reachable around the proxy, or the count
     is too high. Close the direct path or lower the count.
5. Sign in once and check the address in the audit entry (super admin, Audit log, entry details)
   is your real public address.

## 4. Rate limiting and brute-force protection

| Layer                            | Scope                                  | Where it lives                   |
| -------------------------------- | -------------------------------------- | -------------------------------- |
| Per-account sign-in limit        | 10 wrong passwords per 15 minutes      | PostgreSQL (shared by instances) |
| Impersonation step-up limit      | 5 wrong passwords per 15 minutes       | PostgreSQL (shared by instances) |
| Per-address limits (`@Throttle`) | e.g. sign-in 10 per minute per address | Each API instance's memory       |
| Per-address limits at the edge   | Configured by operations               | Gateway, CDN or load balancer    |

- **Per-account sign-in limit.** After 10 wrong passwords in 15 minutes an account refuses every
  password, the right one included, until the window moves on. The answer is the same as for a
  wrong password or an unknown email, so it never reveals whether an account exists. A password
  reset ends it at once. Attempts on one email are serialised (at most 2 seconds of waiting; a
  request that cannot get its turn is refused like a wrong password), so floods on one account
  cannot hold database connections. Locked attempts are recorded as `AUTH_LOGIN_FAILED` with
  reason `LOCKED`.
- **Per-address limits in the API are per instance.** With N instances an address gets up to N
  times the limit, and a restart resets them. They are a first line only.
- **Configure per-address limits at the edge** (required before production), at least for:
  `POST /v1/auth/login`, `POST /v1/auth/register`, `POST /v1/auth/forgot-password`,
  `POST /v1/auth/reset-password`, `POST /v1/auth/reauthenticate` and
  `POST /v1/auth/impersonation/exchange`. Suggested start: 20 requests per minute per address
  for each, with bursts of 10, then tune from the logs.

## 5. Secrets and signing-key rotation

- Keep `DATABASE_URL`, `SMTP_PASSWORD` and `CONSEQUENCE_SIGNING_KEYS` in the platform's secret
  manager. Never in the repository, images or logs; the API logs setting names only.
- Signing keys (only when impersonated writes are enabled): each entry is
  `<kid>:<base64url secret of at least 32 bytes>`, comma-separated; generate secrets with
  `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`.
- **Rotation** (no downtime; a confirmation token is valid for 5 minutes):
  1. Add the new key next to the old one (`old:...,new:...`), keep `ACTIVE_KEY=old`, deploy to
     every instance.
  2. Set `ACTIVE_KEY=new`, deploy to every instance.
  3. After at least 5 minutes, remove `old` and deploy.
- If a key may have leaked, do steps 1–3 at once (tokens signed with it fail and are re-previewed),
  or switch impersonated writes off until the new key is everywhere.

## 6. Database migrations

### Before every deployment

1. **Backup**: `pg_dump --format=custom --file=coobra-<date>.dump "$DATABASE_URL"`; store it
   outside the database host. Record its SHA-256.
2. **Validate the backup**: `pg_restore --list` succeeds, and the dump restores into a scratch
   database whose table counts match production.
3. **Rehearse**: run `prisma migrate deploy` on that restored copy, then
   `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`
   (no drift), and compare the pre-existing columns of every table (they must be unchanged).
4. Only then deploy to production: migrations first, then the API, then the admin console, then
   the merchant and driver web apps.

### Locking: `20261030120000_impersonation_foundation`

It adds nullable columns (instant), new tables, indexes, foreign keys, CHECK constraints and
triggers. On existing tables (`audit_logs`, `sessions`, `shipments`, `shipment_status_history`,
`return_records`, `pricing_quotes`, `financial_adjustments`) the index builds take a SHARE lock and
the new constraints are validated under a lock: **writes to those tables wait until each step
finishes** (reads continue). `lock_timeout` (5 s) only limits waiting to acquire a lock; it does
not shorten a step once started.

- Small tables (seconds): run it in a quiet period.
- Large tables: schedule a maintenance window, stop or drain writers (sign-ins and shipment
  updates wait otherwise), and time the step on the rehearsal copy first.
- `20261029090000_audit_log_viewer_indexes`: see that PR's note; on a large `audit_logs` create its
  four indexes with `CREATE INDEX CONCURRENTLY` first and mark the migration applied.

### Recovery

- **Prefer fixing forward** with a new migration.
- **Rollback script** (manual, never automatic):
  `packages/database/prisma/rollback/20261030120000_impersonation_foundation.down.sql`. Withdraw
  the API version that uses impersonation first, take a fresh backup, then run it in one
  transaction (`psql -v ON_ERROR_STOP=1 -1 -f ...`). It refuses to run once any impersonation or
  linked adjustment exists, because it would delete audit attribution; after go-live, fix forward.
- **Last resort**: restore the pre-deployment backup into a new database, verify it, and switch
  the API to it. Everything written after the backup is lost; record what was written in between
  from the audit log first.

## 7. Monitoring the notification outbox

The account holder's impersonation summary is sent from `notification_outbox` by every
instance's sweeper (each minute; up to 5 attempts with back-off; then `FAILED`).

```sql
-- Alert when > 0: summaries that will not be sent automatically.
SELECT count(*) FROM notification_outbox WHERE status = 'FAILED';
-- Alert when > 0 for 15 minutes: the sweeper is not running or the mail provider is down.
SELECT count(*) FROM notification_outbox
WHERE status = 'PENDING' AND next_attempt_at < now() - interval '15 minutes';
```

`last_error` holds a short error text (never message content). After fixing the cause, a failed
row can be queued again (one row at a time, recorded in the change log):

```sql
UPDATE notification_outbox
SET status = 'PENDING', attempts = 0, next_attempt_at = now(), lease_token = NULL,
    lease_expires_at = NULL
WHERE id = '<id>' AND status = 'FAILED';
```

Also watch the API logs for `Impersonation sweep failed` and `ProxyTrust` errors, and alert on a
burst of `AUTH_LOGIN_FAILED` audit entries with reason `LOCKED`.
