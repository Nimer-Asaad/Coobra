import { lastValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { accounts, credit, debit, LedgerService } from '../finance/ledger.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  ActingContextInterceptor,
  currentActingContext,
  runActing,
  selfActing,
  type ActingContext,
} from './acting-context.js';
import { AppException } from './app-exception.js';

const merchant = { id: '0190f2a4-0000-7000-8000-000000000001', role: 'MERCHANT' as const };
const admin = { id: '0190f2a4-0000-7000-8000-000000000002', role: 'SUPER_ADMIN' as const };

/** What Phase 4C.3 will build for an impersonated request (not reachable in 4C.2). */
const impersonating: ActingContext = {
  actor: admin,
  principal: merchant,
  impersonation: {
    id: '0190f2a4-0000-7000-8000-0000000000aa',
    actorSessionId: '0190f2a4-0000-7000-8000-0000000000bb',
    expiresAt: new Date(Date.now() + 60_000),
  },
};

describe('acting context', () => {
  it('makes the actor and the principal the same person outside impersonation', () => {
    const acting = selfActing({ ...merchant });
    expect(acting.actor).toEqual(merchant);
    expect(acting.principal).toEqual(merchant);
    expect(acting.impersonation).toBeNull();
  });

  it('is available across awaits inside a request and absent outside one', async () => {
    expect(currentActingContext()).toBeNull();
    const seen = await runActing(impersonating, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return currentActingContext();
    });
    expect(seen).toBe(impersonating);
    expect(currentActingContext()).toBeNull();
  });

  it('runs the handler inside the authenticated context (and leaves public routes alone)', async () => {
    const interceptor = new ActingContextInterceptor();
    const http = (auth: unknown) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ auth }) }) }) as unknown as ExecutionContext;
    const handler: CallHandler = { handle: () => of(currentActingContext()) };
    const acting = selfActing(merchant);
    expect(await lastValueFrom(interceptor.intercept(http({ acting }), handler))).toBe(acting);
    expect(await lastValueFrom(interceptor.intercept(http(undefined), handler))).toBeNull();
  });
});

describe('ledger hard stop (ADR 0003 §6)', () => {
  const ledger = new LedgerService();
  const posting = {
    kind: 'MERCHANT_ADJUSTMENT' as const,
    sourceType: 'test',
    sourceId: 'x',
    createdById: admin.id,
    lines: [
      debit(accounts.adjustmentExpense(), '1'),
      credit(accounts.merchantBalance(merchant.id), '1'),
    ],
  };
  /** A transaction that fails the test if the ledger touches it. */
  const untouchable = new Proxy(
    {},
    {
      get: () => {
        throw new Error('the ledger must refuse before touching the database');
      },
    },
  ) as never;

  it('refuses to post anything while impersonating, before touching the database', async () => {
    const error = await runActing(impersonating, () => ledger.post(untouchable, posting)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).code).toBe('IMPERSONATION_FORBIDDEN_ACTION');
  });

  it('does not interfere with a normal request or with the CLI (no context)', async () => {
    for (const run of [
      (work: () => Promise<unknown>) => runActing(selfActing(admin), work),
      (work: () => Promise<unknown>) => work(),
    ]) {
      const error = await run(() => ledger.post(untouchable, posting)).catch((e: unknown) => e);
      expect((error as Error).message).toBe('the ledger must refuse before touching the database');
    }
  });
});

describe('audit stamping (ADR 0003 §11.1)', () => {
  const service = new AuditService({} as PrismaService);
  function capture() {
    const create = vi.fn().mockResolvedValue({});
    return { tx: { auditLog: { create } } as never, create };
  }

  it('writes ordinary entries exactly as before (no impersonation fields)', async () => {
    const { tx, create } = capture();
    await runActing(selfActing(merchant), () =>
      service.recordIn(tx, { action: 'SHIPMENT_CREATED', actorUserId: merchant.id }),
    );
    const data = create.mock.calls[0]?.[0].data;
    // Not even set to null: ordinary entries are written exactly as before Phase 4C.2.
    expect(data.actorUserId).toBe(merchant.id);
    expect(data).not.toHaveProperty('effectiveUserId');
    expect(data).not.toHaveProperty('impersonationId');
  });

  it('names the account and the impersonation on every entry while impersonating', async () => {
    const { tx, create } = capture();
    await runActing(impersonating, () =>
      service.recordIn(tx, { action: 'SHIPMENT_CREATED', actorUserId: admin.id }),
    );
    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      actorUserId: admin.id,
      effectiveUserId: merchant.id,
      impersonationId: impersonating.impersonation!.id,
    });
  });
});

describe('impersonation sessions stay disabled (Phase 4C.2)', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://unused',
    ADMIN_WEB_URL: 'http://localhost:3000',
    MERCHANT_APP_URL: 'http://localhost:8082',
    DRIVER_APP_URL: 'http://localhost:8081',
    MAIL_FROM: 'test@example.com',
    CORS_ORIGINS: 'http://localhost:3000',
  });
  function sessions(impersonationId: string | null) {
    const now = Date.now();
    const found = {
      id: 's1',
      userId: merchant.id,
      tokenHash: 'h',
      clientApp: 'MERCHANT_APP',
      ipAddress: null,
      userAgent: null,
      createdAt: new Date(now),
      lastUsedAt: new Date(now),
      expiresAt: new Date(now + 60_000),
      revokedAt: null,
      reauthenticatedAt: null,
      impersonationId,
      user: { ...merchant, status: 'ACTIVE', merchantProfile: null },
    };
    const prisma = {
      client: { session: { findUnique: vi.fn().mockResolvedValue(found), update: vi.fn() } },
    } as unknown as PrismaService;
    return new SessionService(prisma, config);
  }
  const token = 'x'.repeat(43);

  it('never authenticates a session created by an impersonation', async () => {
    expect(await sessions('0190f2a4-0000-7000-8000-0000000000aa').authenticate(token)).toBeNull();
  });

  it('still authenticates an ordinary session', async () => {
    expect((await sessions(null).authenticate(token))?.user.id).toBe(merchant.id);
  });
});
