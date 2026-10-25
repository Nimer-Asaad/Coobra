# @coobra/database

Prisma schema, migrations and the generated Prisma Client for COOBRA (PostgreSQL).

Phase 1 contains only authentication and user models: `User`, `MerchantProfile`,
`Session`, `AuthToken` and `AuditLog`.

| Command            | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `pnpm db:validate` | Validate the schema (no database needed)     |
| `pnpm db:generate` | Generate the client into `src/generated`     |
| `pnpm db:migrate`  | Create/apply migrations in development       |
| `pnpm db:deploy`   | Apply committed migrations (CI / production) |

`DATABASE_URL` is read from the repository root `.env`.
