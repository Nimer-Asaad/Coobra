// Recreates the disposable end-to-end database (coobra_e2e) from the migrations and seeds the
// accounts and prices the smoke tests use. It never touches any other database.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import { createPrismaClient } from '@coobra/database';

const E2E_DATABASE = 'coobra_e2e';
const root = fileURLToPath(new URL('../../', import.meta.url));

function baseUrl() {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  const envFile = `${root}.env`;
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set E2E_DATABASE_URL or DATABASE_URL in the root .env');
  const parsed = new URL(url);
  parsed.pathname = `/${E2E_DATABASE}`;
  return parsed.toString();
}

const url = baseUrl();
const target = new URL(url);
if (target.pathname !== `/${E2E_DATABASE}`) {
  throw new Error(
    `Refusing to reset ${target.pathname.slice(1)}: only ${E2E_DATABASE} is disposable`,
  );
}

// 1. Drop and recreate the database (through the maintenance database).
const admin = new URL(url);
admin.pathname = '/postgres';
admin.search = '';
const maintenance = createPrismaClient({ connectionString: admin.toString() });
await maintenance.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${E2E_DATABASE} WITH (FORCE)`);
await maintenance.$executeRawUnsafe(`CREATE DATABASE ${E2E_DATABASE}`);
await maintenance.$disconnect();

// 2. Apply every migration (the same path as a fresh production install).
execFileSync('pnpm', ['--filter', '@coobra/database', 'exec', 'prisma', 'migrate', 'deploy'], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: url },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

// 3. Seed: one account per role (random passwords kept in .auth/, never committed).
const db = createPrismaClient({ connectionString: url });
const zone = async (code) => (await db.zone.findFirstOrThrow({ where: { code } })).id;
const ramallah = await zone('RAMALLAH_ALBIREH');

const roles = {
  admin: 'SUPER_ADMIN',
  accountant: 'ACCOUNTANT',
  accountant2: 'ACCOUNTANT',
  ops: 'OPERATIONS',
  viewer: 'OWNER_VIEWER',
  merchant: 'MERCHANT',
  driver: 'DRIVER',
};
const accounts = {};
for (const [name, role] of Object.entries(roles)) {
  const password = `E2e-${randomBytes(9).toString('base64url')}7k`;
  const user = await db.user.create({
    data: {
      email: `${name}@e2e.coobra.test`,
      fullName: `E2E ${name}`,
      phone: role === 'MERCHANT' || role === 'DRIVER' ? '0599000100' : null,
      role,
      language: 'en',
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      emailVerifiedAt: new Date(),
      ...(role === 'MERCHANT'
        ? {
            merchantProfile: {
              create: { businessName: 'E2E Shop', defaultPickupZoneId: ramallah },
            },
          }
        : {}),
    },
  });
  accounts[name] = { id: user.id, email: user.email, password };
}

await db.pricingRule.create({
  data: {
    ruleGroupId: crypto.randomUUID(),
    originZoneId: ramallah,
    destinationZoneId: ramallah,
    deliveryFee: '15',
    returnFee: '10',
  },
});
await db.$disconnect();

mkdirSync(new URL('./.auth/', import.meta.url), { recursive: true });
// The isolated admin rewrites next-env.d.ts; global-setup.ts restores this copy after the run.
const nextEnv = new URL('../../apps/admin-web/next-env.d.ts', import.meta.url);
if (existsSync(nextEnv)) {
  copyFileSync(nextEnv, new URL('./.auth/next-env.d.ts.backup', import.meta.url));
}
writeFileSync(
  new URL('./.auth/accounts.json', import.meta.url),
  JSON.stringify({ databaseUrl: url, zones: { ramallah }, accounts }, null, 2),
);
console.log(`coobra_e2e ready (${Object.keys(accounts).length} accounts)`);
