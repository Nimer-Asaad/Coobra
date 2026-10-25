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
    'TRUNCATE TABLE shipment_fee_overrides, shipment_pricing, pricing_quotes, pricing_rules, cod_collections, shipment_status_history, shipments, audit_logs, auth_tokens, sessions, merchant_profiles, users CASCADE',
  );
  for (;;) {
    const deleted = await prisma.$executeRawUnsafe(
      `DELETE FROM zones WHERE code NOT IN (${SEEDED_ZONES}) AND id NOT IN (SELECT parent_id FROM zones WHERE parent_id IS NOT NULL)`,
    );
    if (deleted === 0) break;
  }
  await prisma.$executeRawUnsafe('UPDATE zones SET active = true WHERE active = false');
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

const TEST_PASSWORD = 'test-password-123';
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
