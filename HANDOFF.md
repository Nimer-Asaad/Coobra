# COOBRA handoff (2026-10-31)

Branch: `feature/phase4c-impersonation` (not merged into main). Design record:
`docs/adr/0003-phase4c-impersonation.md` (§17–§22).

## Phases

| Phase                                        | State       | Commit    |
| -------------------------------------------- | ----------- | --------- |
| 4C.0/4C.1 Design, migration 14               | Approved    | `1b7c0ab` |
| 4C.2 ActingContext                           | Approved    | `bfd1b21` |
| 4C.3 Lifecycle and security gate             | Approved    | `de7506b` |
| 4C.4 Impersonated writes (off by default)    | Approved    | `bef8bc9` |
| 4C.5 Impersonation UI                        | Approved    | `9ac5a5e` |
| 4C.6 E2E journeys, security review, docs, PR | Not started | —         |

## Pending

1. Phase 4C.6 (needs owner approval to start): release-readiness review, E2E journeys, docs, PR.

4C.5 was approved on 2026-10-31 at `9ac5a5e` (with the ADR §22 follow-ups: the audit-log E2E
race, "Act as" in the users list, server-computed adjustment review eligibility). `826a3b2`
keeps its WIP title: pushed commits are not rewritten.

Known risks carried into 4C.6 (ADR §22): eligibility can be stale until the decision (which
re-checks everything); a few queries per pending adjustment; shortfall and fee-correction
approvals are not disabled in advance; the adjustment review screen has no E2E journey.

## Last test results (4C.5, 2026-10-31)

- Typecheck, lint and Prettier: clean.
- Unit and component: 259 passed (shared 84, i18n 5, mobile-core 21, api 60, admin-web 89).
- API integration (scratch database): 17 files, 205 passed.
- E2E, isolated stack: full suite 9/9; the audit-log test 5/5 repeated.

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
