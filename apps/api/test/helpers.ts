import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { clientAppForRole, GOVERNORATES, type UserRole } from '@coobra/shared';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaClient } from '@coobra/database';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { APP_CONFIG, loadConfig, type AppConfig } from '../src/config/env.js';
import { loadRootEnvFile } from '../src/config/load-env-file.js';
import {
  MAIL_TRANSPORT,
  type MailMessage,
  type MailTransport,
} from '../src/mail/mail-transport.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PasswordService } from '../src/auth/password.service.js';

/** Captures outgoing emails so tests can follow the links a real user would receive. */
export class CapturingMailTransport implements MailTransport {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }

  /** Waits for a background email to `to` and returns the `token` query param of its link. */
  async tokenFor(to: string, subjectIncludes?: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const message = [...this.sent]
        .reverse()
        .find((m) => m.to === to && (!subjectIncludes || m.subject.includes(subjectIncludes)));
      const match = message?.text.match(/[?&]token=([A-Za-z0-9_-]+)/);
      if (match?.[1]) return match[1];
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`No email with a token was sent to ${to}`);
  }
}

export interface TestContext {
  app: NestExpressApplication;
  config: AppConfig;
  mail: CapturingMailTransport;
  prisma: PrismaClient;
}

export const ALLOWED_ORIGIN = 'http://localhost:3000';

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestContext> {
  loadRootEnvFile();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    CORS_ORIGINS: ALLOWED_ORIGIN,
    ADMIN_WEB_URL: 'http://localhost:3000',
    MERCHANT_APP_URL: 'http://localhost:8082',
    DRIVER_APP_URL: 'http://localhost:8081',
    MAIL_FROM: 'COOBRA Test <test@coobra.local>',
    RATE_LIMIT_ENABLED: 'false',
    ...overrides,
  });
  const mail = new CapturingMailTransport();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(mail)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
  configureApp(app, config);
  await app.init();
  return { app, config, mail, prisma: app.get(PrismaService).client };
}

const SEEDED_ZONES = GOVERNORATES.map((code) => `'${code}'`).join(', ');

/** Wipes test data. Seeded root zones and zone kinds (from the migration) are kept. */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE notification_outbox, impersonation_exchange_codes, impersonation_sessions, pickup_zone_requests, return_records, treasury_transfers, merchant_payments, merchant_payouts, driver_repayments, cash_clearings, driver_cash_shortages, driver_settlements, idempotency_records, finance_setting_changes, financial_adjustments, cod_shortfalls, journal_lines, journal_entries, financial_accounts, shipment_fee_overrides, shipment_pricing, pricing_quotes, pricing_rules, cod_collections, shipment_status_history, shipments, audit_logs, auth_tokens, sessions, merchant_profiles, users CASCADE',
  );
  for (;;) {
    const deleted = await prisma.$executeRawUnsafe(
      `DELETE FROM zones WHERE code NOT IN (${SEEDED_ZONES}) AND id NOT IN (SELECT parent_id FROM zones WHERE parent_id IS NOT NULL)`,
    );
    if (deleted === 0) break;
  }
  await prisma.$executeRawUnsafe('UPDATE zones SET active = true WHERE active = false');
  await prisma.$executeRawUnsafe(
    `UPDATE finance_settings SET value = '200.00', updated_by_id = NULL WHERE key = 'APPROVAL_THRESHOLD'`,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM zone_kinds WHERE code NOT IN ('REGION', 'GOVERNORATE', 'CITY', 'TOWN', 'SUBZONE')`,
  );
}

export async function zoneId(prisma: PrismaClient, code: string): Promise<string> {
  return (await prisma.zone.findUniqueOrThrow({ where: { code } })).id;
}

/** Pickup zone Ramallah for the merchants and two general route rules: R→R 15, R→Nablus 25. */
export async function setupBasicPricing(prisma: PrismaClient, merchantIds: string[]) {
  const ramallah = await zoneId(prisma, 'RAMALLAH_ALBIREH');
  const nablus = await zoneId(prisma, 'NABLUS');
  await prisma.merchantProfile.updateMany({
    where: { userId: { in: merchantIds } },
    data: { defaultPickupZoneId: ramallah },
  });
  await prisma.pricingRule.createMany({
    data: [
      {
        ruleGroupId: randomUUID(),
        originZoneId: ramallah,
        destinationZoneId: ramallah,
        deliveryFee: '15',
        returnFee: '10',
      },
      {
        ruleGroupId: randomUUID(),
        originZoneId: ramallah,
        destinationZoneId: nablus,
        deliveryFee: '25',
      },
    ],
  });
  return { ramallah, nablus };
}

/** Inserts a verified SUPER_ADMIN directly, as the bootstrap CLI does. */
export async function createSuperAdmin(prisma: PrismaClient, email: string, password: string) {
  return prisma.user.create({
    data: {
      email,
      fullName: 'Root Admin',
      role: 'SUPER_ADMIN',
      language: 'en',
      passwordHash: await new PasswordService().hash(password),
      emailVerifiedAt: new Date(),
    },
  });
}

export interface TestUser {
  id: string;
  email: string;
  role: UserRole;
  token: string;
}

export const TEST_PASSWORD = 'test-password-123';
let passwordHash: string | undefined;

/** Inserts an active, verified user of any role and signs them in to their app (Bearer token). */
export async function createSignedInUser(
  ctx: TestContext,
  role: UserRole,
  email: string,
  extra: { fullName?: string; businessName?: string; phone?: string } = {},
): Promise<TestUser> {
  passwordHash ??= await new PasswordService().hash(TEST_PASSWORD);
  const user = await ctx.prisma.user.create({
    data: {
      email,
      fullName: extra.fullName ?? `Test ${role}`,
      phone: extra.phone ?? null,
      role,
      language: 'en',
      passwordHash,
      emailVerifiedAt: new Date(),
      ...(role === 'MERCHANT'
        ? { merchantProfile: { create: { businessName: extra.businessName ?? `${email} store` } } }
        : {}),
    },
  });
  const res = await request(ctx.app.getHttpServer() as Server)
    .post('/v1/auth/login')
    .send({ email, password: TEST_PASSWORD, clientApp: clientAppForRole(role) })
    .expect(200);
  return { id: user.id, email, role, token: res.body.token as string };
}

/** Ledger balance of an account code (asset/expense: debit − credit; others: credit − debit). */
export async function ledgerBalance(prisma: PrismaClient, code: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ balance: string | null }[]>`
    SELECT (CASE WHEN a.type IN ('ASSET', 'EXPENSE')
                 THEN SUM(CASE WHEN l.side = 'DEBIT' THEN l.amount ELSE -l.amount END)
                 ELSE SUM(CASE WHEN l.side = 'CREDIT' THEN l.amount ELSE -l.amount END) END)::text AS balance
    FROM financial_accounts a JOIN journal_lines l ON l.account_id = a.id
    WHERE a.code = ${code} GROUP BY a.type`;
  return Number(rows[0]?.balance ?? 0).toFixed(2);
}

/**
 * The ADR invariants, recomputed from operational tables and compared with the ledger:
 * trial balance, driver custody, merchant pending COD, and per-shipment collections.
 */
export async function assertLedgerInvariants(prisma: PrismaClient): Promise<void> {
  const [trial] = await prisma.$queryRaw<{ debits: string | null; credits: string | null }[]>`
    SELECT SUM(CASE WHEN side = 'DEBIT' THEN amount END)::text AS debits,
           SUM(CASE WHEN side = 'CREDIT' THEN amount END)::text AS credits FROM journal_lines`;
  if ((trial?.debits ?? null) !== (trial?.credits ?? null)) {
    throw new Error(`Trial balance off: ${trial?.debits} vs ${trial?.credits}`);
  }
  const custody = await prisma.$queryRaw<{ driver_id: string; expected: string }[]>`
    SELECT driver_id, SUM(collected_amount - cleared_amount)::text AS expected
    FROM cod_collections GROUP BY driver_id`;
  for (const row of custody) {
    const actual = await ledgerBalance(prisma, `DRIVER_CUSTODY:${row.driver_id}`);
    if (actual !== Number(row.expected).toFixed(2)) {
      throw new Error(
        `Driver custody ${row.driver_id}: ledger ${actual} vs operational ${row.expected}`,
      );
    }
  }
  const pending = await prisma.$queryRaw<{ merchant_id: string; expected: string }[]>`
    SELECT s.merchant_id, SUM(c.collected_amount - c.cleared_amount)::text AS expected
    FROM cod_collections c JOIN shipments s ON s.id = c.shipment_id GROUP BY s.merchant_id`;
  for (const row of pending) {
    const actual = await ledgerBalance(prisma, `MERCHANT_COD_PENDING:${row.merchant_id}`);
    if (actual !== Number(row.expected).toFixed(2)) {
      throw new Error(
        `Merchant pending ${row.merchant_id}: ledger ${actual} vs operational ${row.expected}`,
      );
    }
  }
  const shipments = await prisma.$queryRaw<{ id: string }[]>`
    SELECT s.id FROM shipments s LEFT JOIN cod_collections c ON c.shipment_id = s.id
    GROUP BY s.id HAVING s.cod_collected_amount <> COALESCE(SUM(c.collected_amount), 0)
       OR COALESCE(SUM(c.collected_amount), 0) > s.cod_amount`;
  if (shipments.length > 0)
    throw new Error(`Collected totals inconsistent for ${shipments.length} shipments`);
}
