# COOBRA handoff (2026-10-30)

Branch: `feature/phase4c-impersonation` (not merged into main). Design record:
`docs/adr/0003-phase4c-impersonation.md` (§17–§22).

## Phases

| Phase                                        | State                          | Commit    |
| -------------------------------------------- | ------------------------------ | --------- |
| 4C.0/4C.1 Design, migration 14               | Approved                       | `1b7c0ab` |
| 4C.2 ActingContext                           | Approved                       | `bfd1b21` |
| 4C.3 Lifecycle and security gate             | Approved                       | `de7506b` |
| 4C.4 Impersonated writes (off by default)    | Approved                       | `bef8bc9` |
| 4C.5 Impersonation UI                        | **WIP, awaiting owner review** | `826a3b2` |
| 4C.6 E2E journeys, security review, docs, PR | Not started                    | —         |

## Pending

1. Owner review of the 4C.5 report; on approval, reword the WIP commit (or add an approval
   commit) and mark ADR §16 row 4C.5 as approved.
2. Fix the race in `packages/e2e/tests/audit-log.spec.ts`: it types a search right after
   "Clear filters", before the form re-mounts. It also fails on the 4C.4 audit panel, so it is
   not a 4C.5 regression.
3. Not built from the 4C.5 plan: the "Act as" entry in the users list row menu, and disabling
   adjustment Approve in advance for a conflicted reviewer (the API's 403 is shown instead).
4. Then Phase 4C.6 (needs owner approval to start).

## Last test results (4C.5)

- Typecheck and lint: clean. Prettier: clean.
- Unit and component: 249 passed (shared 84, i18n 5, mobile-core 21, api 60, admin-web 79).
- API integration (scratch database): 17 files, 204 passed (run as two halves: 133 + 71).
- E2E, isolated stack: impersonation spec 3/3; full suite 8/9 (the audit-log race above).

## Safety rules

- `IMPERSONATION_WRITES_ENABLED` stays unset/false in development. It is enabled only by the
  isolated E2E stack (`packages/e2e/playwright.config.ts`, random signing key per run).
- Never commit `.env` files, keys, dumps, `.auth/`, `test-results/`, `.e2e-dist/`,
  `.next-e2e/`, `.web/`, or the AI-tool folders (`.claude/`, `packages/database/.agents|.claude|.windsurf`,
  `skills-lock.json`).
- The development database (`coobra_dev`) has 14 migrations; don't reset it. Tests use
  `TEST_DATABASE_URL` (wiped by tests) and the disposable `coobra_e2e` only.

## Resume on another PC

```bash
git clone https://github.com/Nimer-Asaad/Coobra.git
cd Coobra
git checkout feature/phase4c-impersonation
pnpm install
cp .env.example .env    # fill in local values; also apps/*/.env.example
docker compose up -d    # PostgreSQL and Mailpit
pnpm --filter @coobra/database exec prisma migrate deploy
pnpm turbo run build --filter=@coobra/database --filter=@coobra/shared --filter=@coobra/i18n
```

Checks:

```bash
pnpm turbo run typecheck lint
pnpm turbo run test
```

API integration tests need `TEST_DATABASE_URL` pointing at a separate database:

```bash
cd apps/api && npx vitest run --config ./vitest.config.integration.ts
```

Isolated E2E (its own `coobra_e2e` database and ports 4100/3100/8181/8182). Without
Playwright's own browsers, use an installed Chrome:

```bash
cd packages/e2e
E2E_BROWSER_CHANNEL=chrome pnpm test:e2e
```
