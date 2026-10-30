import { randomUUID } from 'node:crypto';
import type { PrismaClient, UserRole } from '@coobra/database';
import { hashToken } from '../src/auth/token.util.js';
import { createTestApp, resetDatabase, type TestContext } from './helpers.js';

/*
 * Phase 4C.1: the impersonation schema (migration 20261030120000_impersonation_foundation)
 * enforces its rules in PostgreSQL itself, whatever code path writes the rows (ADR 0003 §9,
 * §11). Nothing here uses an API route: impersonation is not enabled yet.
 */

const CHALLENGE = '3Ev4DHdHPRMPoN6GukAY_pi7IUAF5qWJHRK6kURvnoE';
const MINUTE = 60_000;

/** The PostgreSQL error raised by a statement, as text (constraint names included). */
async function failure(statement: Promise<unknown>): Promise<string> {
  try {
    await statement;
  } catch (error) {
    const parts = [String(error)];
    const meta = (error as { meta?: unknown; cause?: unknown }).meta;
    if (meta) parts.push(JSON.stringify(meta));
    const cause = (error as { cause?: unknown }).cause;
    if (cause) parts.push(String(cause), JSON.stringify(cause));
    return parts.join(' ');
  }
  throw new Error('Expected the statement to be rejected by the database');
}

describe('Impersonation schema integrity (PostgreSQL integration)', () => {
  let ctx: TestContext;
  let prisma: PrismaClient;
  let admin: string;
  let otherAdmin: string;
  let merchant: string;
  let otherMerchant: string;
  let driver: string;
  let accountant: string;
  let adminSession: string;
  let otherAdminSession: string;

  async function user(role: UserRole, name: string): Promise<string> {
    const row = await prisma.user.create({
      data: {
        email: `${name}-${randomUUID()}@impersonation.test`,
        fullName: name,
        role,
        language: 'en',
        emailVerifiedAt: new Date(),
      },
    });
    return row.id;
  }

  async function session(userId: string, clientApp: 'ADMIN_WEB' | 'MERCHANT_APP' | 'DRIVER_APP') {
    const row = await prisma.session.create({
      data: {
        userId,
        clientApp,
        tokenHash: hashToken(randomUUID() + randomUUID()),
        expiresAt: new Date(Date.now() + 60 * MINUTE),
      },
    });
    return row.id;
  }

  /** An active impersonation through the generated Prisma client. */
  function start(options: { actor?: string; actorSession?: string; target?: string } = {}) {
    const actorUserId = options.actor ?? admin;
    const targetUserId = options.target ?? merchant;
    const isDriver = targetUserId === driver;
    const startedAt = new Date();
    return prisma.impersonationSession.create({
      data: {
        actorUserId,
        actorSessionId: options.actorSession ?? adminSession,
        targetUserId,
        targetRole: isDriver ? 'DRIVER' : 'MERCHANT',
        clientApp: isDriver ? 'DRIVER_APP' : 'MERCHANT_APP',
        reason: 'Support ticket: cannot create a shipment',
        activeActorId: actorUserId,
        activeTargetId: targetUserId,
        startedAt,
        expiresAt: new Date(startedAt.getTime() + 30 * MINUTE),
      },
    });
  }

  function end(id: string, endedReason: 'MANUAL' | 'EXPIRED' = 'MANUAL') {
    return prisma.impersonationSession.updateMany({
      where: { id, endedAt: null },
      data: { endedAt: new Date(), endedReason, activeActorId: null, activeTargetId: null },
    });
  }

  async function shipment(merchantId: string, createdById: string, impersonationId?: string) {
    return prisma.shipment.create({
      data: {
        trackingNumber: `CB-${randomUUID().slice(0, 8)}`,
        merchantId,
        createdById,
        creatorRole: createdById === merchantId ? 'MERCHANT' : 'SUPER_ADMIN',
        recipientName: 'Recipient',
        recipientPhone: '0599000000',
        governorate: 'RAMALLAH',
        city: 'Ramallah',
        addressLine: 'Main street',
        codAmount: '100.00',
        createdImpersonationId: impersonationId ?? null,
      },
    });
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    prisma = ctx.prisma;
  });

  afterAll(async () => {
    await resetDatabase(prisma);
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    admin = await user('SUPER_ADMIN', 'Admin');
    otherAdmin = await user('SUPER_ADMIN', 'Other admin');
    merchant = await user('MERCHANT', 'Merchant');
    otherMerchant = await user('MERCHANT', 'Other merchant');
    driver = await user('DRIVER', 'Driver');
    accountant = await user('ACCOUNTANT', 'Accountant');
    adminSession = await session(admin, 'ADMIN_WEB');
    otherAdminSession = await session(otherAdmin, 'ADMIN_WEB');
  });

  describe('Prisma client compatibility', () => {
    it('writes and reads every new model and relation through the generated client', async () => {
      const imp = await start();
      const temporary = await prisma.session.create({
        data: {
          userId: merchant,
          clientApp: 'MERCHANT_APP',
          tokenHash: hashToken(randomUUID()),
          expiresAt: imp.expiresAt,
          impersonationId: imp.id,
        },
      });
      await prisma.impersonationExchangeCode.create({
        data: {
          impersonationId: imp.id,
          codeHash: hashToken('code'),
          codeChallenge: CHALLENGE,
          expiresAt: new Date(Date.now() + 59_000),
        },
      });
      await prisma.auditLog.create({
        data: {
          action: 'SHIPMENT_CREATED',
          actorUserId: admin,
          targetUserId: merchant,
          effectiveUserId: merchant,
          impersonationId: imp.id,
        },
      });
      const created = await shipment(merchant, admin, imp.id);
      await prisma.shipmentStatusHistory.create({
        data: {
          shipmentId: created.id,
          toStatus: 'CREATED',
          actorUserId: admin,
          actorRole: 'SUPER_ADMIN',
          impersonationId: imp.id,
        },
      });
      await prisma.notificationOutbox.create({
        data: {
          kind: 'IMPERSONATION_SUMMARY',
          dedupeKey: `impersonation-summary:${imp.id}`,
          recipientUserId: merchant,
          impersonationId: imp.id,
        },
      });

      const loaded = await prisma.impersonationSession.findUniqueOrThrow({
        where: { id: imp.id },
        include: {
          actor: true,
          target: true,
          actorSession: true,
          temporarySessions: true,
          exchangeCode: true,
          auditEntriesAsActor: true,
          historyEntries: true,
          createdShipmentsForTarget: true,
          notifications: true,
        },
      });
      expect(loaded.actor.id).toBe(admin);
      expect(loaded.target.id).toBe(merchant);
      expect(loaded.actorSession.id).toBe(adminSession);
      expect(loaded.temporarySessions.map((s) => s.id)).toEqual([temporary.id]);
      expect(loaded.exchangeCode?.codeChallenge).toBe(CHALLENGE);
      expect(loaded.auditEntriesAsActor).toHaveLength(1);
      expect(loaded.historyEntries).toHaveLength(1);
      expect(loaded.createdShipmentsForTarget.map((s) => s.id)).toEqual([created.id]);
      expect(loaded.notifications[0]?.status).toBe('PENDING');
    });

    it('keeps writes made outside impersonation unchanged (new columns stay NULL)', async () => {
      const own = await shipment(merchant, merchant);
      const entry = await prisma.auditLog.create({
        data: { action: 'SHIPMENT_CREATED', actorUserId: merchant, targetUserId: merchant },
      });
      expect(own.createdImpersonationId).toBeNull();
      expect(entry.effectiveUserId).toBeNull();
      expect(entry.impersonationId).toBeNull();
      const plain = await prisma.session.findUniqueOrThrow({ where: { id: adminSession } });
      expect(plain.impersonationId).toBeNull();
      expect(plain.reauthenticatedAt).toBeNull();
    });
  });

  describe('one active impersonation per actor and per target', () => {
    it('rejects a second active impersonation for the same actor', async () => {
      await start({ target: merchant });
      expect(await failure(start({ target: otherMerchant }))).toMatch(/active_actor_id/);
    });

    it('rejects a second active impersonation of the same target by another admin', async () => {
      await start({ actor: admin, target: merchant });
      expect(
        await failure(
          start({ actor: otherAdmin, actorSession: otherAdminSession, target: merchant }),
        ),
      ).toMatch(/active_target_id/);
    });

    it('releases both slots when an impersonation ends, and keeps every ended row', async () => {
      const first = await start();
      expect((await end(first.id)).count).toBe(1);
      expect((await end(first.id)).count).toBe(0); // exactly one ender wins
      const second = await start();
      await end(second.id, 'EXPIRED');
      await start({ target: driver });
      expect(await prisma.impersonationSession.count({ where: { actorUserId: admin } })).toBe(3);
      expect(
        await prisma.impersonationSession.count({ where: { actorUserId: admin, endedAt: null } }),
      ).toBe(1);
    });

    it('lets exactly one of two concurrent starts for the same target commit', async () => {
      const attempt = (actor: string, actorSession: string) =>
        prisma.$transaction(async (tx) => {
          const startedAt = new Date();
          await tx.impersonationSession.create({
            data: {
              actorUserId: actor,
              actorSessionId: actorSession,
              targetUserId: merchant,
              targetRole: 'MERCHANT',
              clientApp: 'MERCHANT_APP',
              reason: 'Concurrent start',
              activeActorId: actor,
              activeTargetId: merchant,
              startedAt,
              expiresAt: new Date(startedAt.getTime() + 30 * MINUTE),
            },
          });
          // Hold the uncommitted row so the other transaction waits on the unique index.
          await tx.$executeRawUnsafe('SELECT pg_sleep(0.3)');
        });
      const results = await Promise.allSettled([
        attempt(admin, adminSession),
        attempt(otherAdmin, otherAdminSession),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(await failure(Promise.reject(rejected[0]!.reason))).toMatch(/active_target_id/);
      expect(
        await prisma.impersonationSession.count({
          where: { targetUserId: merchant, endedAt: null },
        }),
      ).toBe(1);
    });

    it('cannot be bypassed with an active row that leaves its slot NULL', async () => {
      // A CHECK passes when it evaluates to NULL; the slot check must not (regression test).
      await start();
      const nullSlot = prisma.$executeRawUnsafe(
        `INSERT INTO impersonation_sessions (id, actor_user_id, actor_session_id, target_user_id, target_role, client_app, reason, active_actor_id, active_target_id, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'MERCHANT', 'MERCHANT_APP', 'raw', NULL, NULL, now() + interval '10 minutes')`,
        randomUUID(),
        admin,
        adminSession,
        otherMerchant,
      );
      expect(await failure(nullSlot)).toMatch(/impersonation_sessions_active_slots_check/);
      expect(
        await prisma.impersonationSession.count({ where: { actorUserId: admin, endedAt: null } }),
      ).toBe(1);
    });

    it('enforces the slots even for a raw insert that skips the application', async () => {
      await start();
      const raw = prisma.$executeRawUnsafe(
        `INSERT INTO impersonation_sessions (id, actor_user_id, actor_session_id, target_user_id, target_role, client_app, reason, active_actor_id, active_target_id, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'MERCHANT', 'MERCHANT_APP', 'raw', $2::uuid, $4::uuid, now() + interval '10 minutes')`,
        randomUUID(),
        otherAdmin,
        otherAdminSession,
        merchant,
      );
      expect(await failure(raw)).toMatch(/active_target_id/);
    });
  });

  describe('CHECK constraints on impersonation_sessions', () => {
    async function rawImpersonation(overrides: Record<string, string>) {
      const values = {
        actor: `'${admin}'`,
        target: `'${merchant}'`,
        role: `'MERCHANT'`,
        app: `'MERCHANT_APP'`,
        reason: `'Support'`,
        activeActor: `'${admin}'`,
        activeTarget: `'${merchant}'`,
        started: 'now()',
        expires: `now() + interval '30 minutes'`,
        ended: 'NULL',
        endedReason: 'NULL',
        ticket: 'NULL',
        actorSession: `'${adminSession}'`,
        ...overrides,
      };
      return failure(
        prisma.$executeRawUnsafe(
          `INSERT INTO impersonation_sessions (id, actor_user_id, actor_session_id, target_user_id, target_role, client_app, reason, ticket_reference, active_actor_id, active_target_id, started_at, expires_at, ended_at, ended_reason)
           VALUES ('${randomUUID()}', ${values.actor}, ${values.actorSession}, ${values.target}, ${values.role}, ${values.app}, ${values.reason}, ${values.ticket}, ${values.activeActor}, ${values.activeTarget}, ${values.started}, ${values.expires}, ${values.ended}, ${values.endedReason})`,
        ),
      );
    }

    it('accepts only merchant and driver targets, each in its own app', async () => {
      expect(
        await rawImpersonation({
          target: `'${accountant}'`,
          activeTarget: `'${accountant}'`,
          role: `'ACCOUNTANT'`,
          app: `'ADMIN_WEB'`,
        }),
      ).toMatch(/impersonation_sessions_target_check/);
      expect(await rawImpersonation({ app: `'DRIVER_APP'` })).toMatch(
        /impersonation_sessions_target_check/,
      );
    });

    it('refuses self-impersonation', async () => {
      expect(
        await rawImpersonation({
          target: `'${admin}'`,
          activeTarget: `'${admin}'`,
        }),
      ).toMatch(/impersonation_sessions_people_check|impersonation_sessions_not_self_check/);
    });

    it('caps the duration at 30 minutes and requires it to be positive', async () => {
      expect(await rawImpersonation({ expires: `now() + interval '31 minutes'` })).toMatch(
        /impersonation_sessions_duration_check/,
      );
      expect(await rawImpersonation({ expires: 'now()' })).toMatch(
        /impersonation_sessions_duration_check/,
      );
    });

    it('ties the active slots to the actor and target exactly while active', async () => {
      expect(await rawImpersonation({ activeActor: 'NULL' })).toMatch(
        /impersonation_sessions_active_slots_check/,
      );
      expect(await rawImpersonation({ activeTarget: `'${otherMerchant}'` })).toMatch(
        /impersonation_sessions_active_slots_check/,
      );
      expect(await rawImpersonation({ ended: 'now()', endedReason: `'MANUAL'` })).toMatch(
        /impersonation_sessions_active_slots_check/,
      );
    });

    it('records an end reason exactly when ended', async () => {
      expect(
        await rawImpersonation({
          activeActor: 'NULL',
          activeTarget: 'NULL',
          ended: 'now()',
        }),
      ).toMatch(/impersonation_sessions_end_check/);
    });

    it('requires a reason and caps the ticket reference', async () => {
      expect(await rawImpersonation({ reason: `'   '` })).toMatch(
        /impersonation_sessions_reason_check/,
      );
      expect(await rawImpersonation({ ticket: `'${'T'.repeat(101)}'` })).toMatch(
        /impersonation_sessions_reason_check/,
      );
      expect(await rawImpersonation({ ticket: `'  '` })).toMatch(
        /impersonation_sessions_reason_check/,
      );
    });

    it('cannot extend an impersonation, even by moving its start', async () => {
      const imp = await start();
      const update = (set: string) =>
        failure(
          prisma.$executeRawUnsafe(
            `UPDATE impersonation_sessions SET ${set} WHERE id = $1::uuid`,
            imp.id,
          ),
        );
      expect(await update(`expires_at = expires_at + interval '1 minute'`)).toMatch(
        /impersonation_sessions_immutable/,
      );
      expect(
        await update(
          `started_at = started_at + interval '20 minutes', expires_at = expires_at + interval '20 minutes'`,
        ),
      ).toMatch(/impersonation_sessions_immutable/);
    });
  });

  describe('people check when an impersonation is created', () => {
    it('requires an active SUPER_ADMIN actor', async () => {
      const accountantSession = await session(accountant, 'ADMIN_WEB');
      expect(await failure(start({ actor: accountant, actorSession: accountantSession }))).toMatch(
        /impersonation_sessions_people_check/,
      );
      await prisma.user.update({ where: { id: admin }, data: { status: 'DISABLED' } });
      expect(await failure(start())).toMatch(/impersonation_sessions_people_check/);
    });

    it('requires an active target whose real role is the recorded one', async () => {
      const mislabelled = prisma.$executeRawUnsafe(
        `INSERT INTO impersonation_sessions (id, actor_user_id, actor_session_id, target_user_id, target_role, client_app, reason, active_actor_id, active_target_id, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'MERCHANT', 'MERCHANT_APP', 'raw', $2::uuid, $4::uuid, now() + interval '10 minutes')`,
        randomUUID(),
        admin,
        adminSession,
        driver,
      );
      expect(await failure(mislabelled)).toMatch(/impersonation_sessions_people_check/);
      await prisma.user.update({ where: { id: merchant }, data: { status: 'DISABLED' } });
      expect(await failure(start())).toMatch(/impersonation_sessions_people_check/);
    });

    it("requires the actor's own unrevoked admin session, never an impersonation session", async () => {
      expect(await failure(start({ actorSession: otherAdminSession }))).toMatch(
        /impersonation_sessions_people_check/,
      );
      const merchantSession = await session(merchant, 'MERCHANT_APP');
      expect(await failure(start({ actorSession: merchantSession }))).toMatch(
        /impersonation_sessions_people_check/,
      );
      await prisma.session.update({ where: { id: adminSession }, data: { revokedAt: new Date() } });
      expect(await failure(start())).toMatch(/impersonation_sessions_people_check/);
    });

    it('refuses nesting: a temporary session cannot start another impersonation', async () => {
      const imp = await start();
      const temporary = await prisma.session.create({
        data: {
          userId: merchant,
          clientApp: 'MERCHANT_APP',
          tokenHash: hashToken(randomUUID()),
          expiresAt: imp.expiresAt,
          impersonationId: imp.id,
        },
      });
      expect(
        await failure(start({ actor: otherAdmin, actorSession: temporary.id, target: driver })),
      ).toMatch(/impersonation_sessions_people_check/);
    });
  });

  describe('an impersonation is permanent history', () => {
    it('can be ended once and never changed again', async () => {
      const imp = await start();
      expect((await end(imp.id)).count).toBe(1);
      const reopen = prisma.$executeRawUnsafe(
        `UPDATE impersonation_sessions SET ended_at = NULL, ended_reason = NULL, active_actor_id = actor_user_id, active_target_id = target_user_id WHERE id = $1::uuid`,
        imp.id,
      );
      expect(await failure(reopen)).toMatch(/impersonation_sessions_immutable/);
      const relabel = prisma.$executeRawUnsafe(
        `UPDATE impersonation_sessions SET ended_reason = 'EXPIRED' WHERE id = $1::uuid`,
        imp.id,
      );
      expect(await failure(relabel)).toMatch(/impersonation_sessions_immutable/);
    });

    it('keeps the reason and the people of an active impersonation unchanged', async () => {
      const imp = await start();
      const rewrite = prisma.$executeRawUnsafe(
        `UPDATE impersonation_sessions SET reason = 'rewritten' WHERE id = $1::uuid`,
        imp.id,
      );
      expect(await failure(rewrite)).toMatch(/impersonation_sessions_immutable/);
    });
  });

  describe('attribution written during impersonation is permanent (R1 relies on it)', () => {
    it('cannot clear or move the impersonation recorded on a shipment, or change its creator', async () => {
      const imp = await start();
      const created = await shipment(merchant, admin, imp.id);
      const update = (set: string) =>
        failure(
          prisma.$executeRawUnsafe(`UPDATE shipments SET ${set} WHERE id = $1::uuid`, created.id),
        );
      expect(await update('created_impersonation_id = NULL')).toMatch(
        /shipments_attribution_immutable/,
      );
      expect(await update(`created_by_id = '${otherAdmin}'`)).toMatch(
        /shipments_attribution_immutable/,
      );
      expect(await update(`creator_role = 'MERCHANT'`)).toMatch(/shipments_attribution_immutable/);
      expect(await failure(prisma.shipment.delete({ where: { id: created.id } }))).toMatch(
        /shipments_attribution_immutable/,
      );
      // Ordinary operational updates still work.
      await prisma.shipment.update({ where: { id: created.id }, data: { status: 'CANCELLED' } });
    });

    it('cannot mark a shipment as impersonated after it was written', async () => {
      const imp = await start();
      const own = await shipment(merchant, merchant);
      const backdate = prisma.$executeRawUnsafe(
        `UPDATE shipments SET created_impersonation_id = $1::uuid, created_by_id = $2::uuid WHERE id = $3::uuid`,
        imp.id,
        admin,
        own.id,
      );
      expect(await failure(backdate)).toMatch(/shipments_attribution_immutable/);
    });

    it('cannot clear or rewrite impersonated history, audit or return records', async () => {
      const imp = await start();
      const created = await shipment(merchant, merchant);
      const history = await prisma.shipmentStatusHistory.create({
        data: {
          shipmentId: created.id,
          toStatus: 'CANCELLED',
          actorUserId: admin,
          actorRole: 'SUPER_ADMIN',
          impersonationId: imp.id,
        },
      });
      const entry = await prisma.auditLog.create({
        data: {
          action: 'SHIPMENT_CANCELLED',
          actorUserId: admin,
          targetUserId: merchant,
          effectiveUserId: merchant,
          impersonationId: imp.id,
        },
      });
      const returned = await prisma.returnRecord.create({
        data: {
          shipmentId: created.id,
          requestedById: admin,
          feeStatus: 'RETURN_FEE_UNCONFIGURED',
          requestedImpersonationId: imp.id,
        },
      });
      const raw = (sql: string, id: string) => failure(prisma.$executeRawUnsafe(sql, id));
      expect(
        await raw(
          'UPDATE shipment_status_history SET impersonation_id = NULL WHERE id = $1::uuid',
          history.id,
        ),
      ).toMatch(/shipment_status_history_attribution_immutable/);
      expect(
        await raw(
          `UPDATE shipment_status_history SET actor_user_id = '${otherAdmin}' WHERE id = $1::uuid`,
          history.id,
        ),
      ).toMatch(/shipment_status_history_attribution_immutable/);
      expect(
        await raw('DELETE FROM shipment_status_history WHERE id = $1::uuid', history.id),
      ).toMatch(/shipment_status_history_attribution_immutable/);
      expect(
        await raw(
          'UPDATE audit_logs SET impersonation_id = NULL, effective_user_id = NULL WHERE id = $1::uuid',
          entry.id,
        ),
      ).toMatch(/audit_logs_attribution_immutable/);
      expect(await raw('DELETE FROM audit_logs WHERE id = $1::uuid', entry.id)).toMatch(
        /audit_logs_attribution_immutable/,
      );
      expect(
        await raw(
          'UPDATE return_records SET requested_impersonation_id = NULL WHERE id = $1::uuid',
          returned.id,
        ),
      ).toMatch(/return_records_attribution_immutable/);
      expect(
        await raw(
          `UPDATE return_records SET requested_by_id = '${merchant}' WHERE id = $1::uuid`,
          returned.id,
        ),
      ).toMatch(/return_records_attribution_immutable/);
      // Ordinary updates of the return record (approval, return driver) still work.
      await prisma.returnRecord.update({
        where: { id: returned.id },
        data: { approvedById: otherAdmin, approvedAt: new Date(), returnDriverId: driver },
      });
    });

    it('leaves records written outside impersonation as editable as before', async () => {
      const own = await shipment(merchant, merchant);
      const entry = await prisma.auditLog.create({
        data: { action: 'SHIPMENT_CREATED', actorUserId: merchant, targetUserId: merchant },
      });
      await prisma.$executeRawUnsafe(
        'UPDATE shipments SET created_by_id = NULL WHERE id = $1::uuid',
        own.id,
      );
      await prisma.$executeRawUnsafe(
        'UPDATE audit_logs SET target_user_id = NULL WHERE id = $1::uuid',
        entry.id,
      );
      expect(await prisma.auditLog.count({ where: { id: entry.id, targetUserId: null } })).toBe(1);
    });

    it('installs the guard triggers on every table that records an impersonation', async () => {
      const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
        `SELECT tgrelid::regclass || '.' || tgname AS name FROM pg_trigger
         WHERE NOT tgisinternal AND tgname LIKE ANY (ARRAY['%attribution_immutable', 'impersonation_%']) ORDER BY 1`,
      );
      expect(rows.map((r) => r.name)).toEqual([
        'audit_logs.audit_logs_attribution_immutable',
        'impersonation_exchange_codes.impersonation_exchange_codes_immutable',
        'impersonation_sessions.impersonation_sessions_immutable',
        'impersonation_sessions.impersonation_sessions_people_check',
        'pricing_quotes.pricing_quotes_attribution_immutable',
        'return_records.return_records_attribution_immutable',
        'sessions.sessions_attribution_immutable',
        'shipment_status_history.shipment_status_history_attribution_immutable',
        'shipments.shipments_attribution_immutable',
      ]);
    });
  });

  describe('attribution (composite foreign keys and checks)', () => {
    it('ties audit entries to the impersonation actor and target', async () => {
      const imp = await start();
      const insert = (actor: string, effective: string | null, impersonationId: string | null) =>
        prisma.auditLog.create({
          data: {
            action: 'SHIPMENT_CREATED',
            actorUserId: actor,
            targetUserId: merchant,
            effectiveUserId: effective,
            impersonationId,
          },
        });
      await insert(admin, merchant, imp.id);
      expect(await failure(insert(otherAdmin, merchant, imp.id))).toMatch(
        /audit_logs_impersonation_id_actor_user_id_fkey/,
      );
      expect(await failure(insert(admin, otherMerchant, imp.id))).toMatch(
        /audit_logs_impersonation_id_effective_user_id_fkey/,
      );
      expect(await failure(insert(admin, null, imp.id))).toMatch(/audit_logs_impersonation_check/);
      expect(await failure(insert(admin, merchant, null))).toMatch(
        /audit_logs_impersonation_check/,
      );
    });

    it('never lets an impersonated audit entry lose its real actor', async () => {
      const imp = await start();
      const anonymous = prisma.$executeRawUnsafe(
        `INSERT INTO audit_logs (id, action, actor_user_id, effective_user_id, impersonation_id) VALUES ($1::uuid, 'SHIPMENT_CREATED', NULL, $2::uuid, $3::uuid)`,
        randomUUID(),
        merchant,
        imp.id,
      );
      expect(await failure(anonymous)).toMatch(/audit_logs_impersonation_check/);
    });

    it('ties shipment history to the impersonation actor', async () => {
      const imp = await start();
      const created = await shipment(merchant, merchant);
      const history = (actorUserId: string | null) =>
        prisma.shipmentStatusHistory.create({
          data: {
            shipmentId: created.id,
            toStatus: 'CANCELLED',
            actorUserId,
            actorRole: 'SUPER_ADMIN',
            impersonationId: imp.id,
          },
        });
      await history(admin);
      expect(await failure(history(otherAdmin))).toMatch(
        /shipment_status_history_impersonation_id_actor_user_id_fkey/,
      );
      expect(await failure(history(null))).toMatch(/shipment_status_history_impersonation_check/);
    });

    it('records the real admin as creator and the impersonated merchant as owner', async () => {
      const imp = await start();
      await shipment(merchant, admin, imp.id);
      expect(await failure(shipment(merchant, otherAdmin, imp.id))).toMatch(
        /shipments_created_impersonation_id_created_by_id_fkey/,
      );
      expect(await failure(shipment(otherMerchant, admin, imp.id))).toMatch(
        /shipments_created_impersonation_id_merchant_id_fkey/,
      );
      const noCreator = prisma.$executeRawUnsafe(
        `UPDATE shipments SET created_by_id = NULL WHERE created_impersonation_id = $1::uuid`,
        imp.id,
      );
      expect(await failure(noCreator)).toMatch(/shipments_attribution_immutable/);
    });

    it('ties an impersonated return request to the impersonation actor', async () => {
      const imp = await start();
      const created = await shipment(merchant, merchant);
      const request = (requestedById: string) =>
        prisma.returnRecord.create({
          data: {
            shipmentId: created.id,
            requestedById,
            feeStatus: 'RETURN_FEE_UNCONFIGURED',
            requestedImpersonationId: imp.id,
          },
        });
      expect(await failure(request(otherAdmin))).toMatch(
        /return_records_requested_impersonation_id_requested_by_id_fkey/,
      );
      await request(admin);
    });

    it('binds a temporary session to the target, outside the admin app, without step-up', async () => {
      const imp = await start();
      const temporary = (userId: string, clientApp: 'ADMIN_WEB' | 'MERCHANT_APP', reauth = false) =>
        prisma.session.create({
          data: {
            userId,
            clientApp,
            tokenHash: hashToken(randomUUID()),
            expiresAt: imp.expiresAt,
            impersonationId: imp.id,
            reauthenticatedAt: reauth ? new Date() : null,
          },
        });
      expect(await failure(temporary(otherMerchant, 'MERCHANT_APP'))).toMatch(
        /sessions_impersonation_id_user_id_fkey/,
      );
      expect(await failure(temporary(merchant, 'ADMIN_WEB'))).toMatch(
        /sessions_impersonation_check/,
      );
      expect(await failure(temporary(merchant, 'MERCHANT_APP', true))).toMatch(
        /sessions_impersonation_check/,
      );
      await temporary(merchant, 'MERCHANT_APP');
      expect(await failure(temporary(merchant, 'MERCHANT_APP'))).toMatch(/impersonation_id/);
    });
  });

  describe('history cannot be rewritten or removed', () => {
    it('restricts deleting an impersonation or changing its people once it is referenced', async () => {
      const imp = await start();
      await prisma.auditLog.create({
        data: {
          action: 'SHIPMENT_CREATED',
          actorUserId: admin,
          targetUserId: merchant,
          effectiveUserId: merchant,
          impersonationId: imp.id,
        },
      });
      expect(await failure(prisma.impersonationSession.delete({ where: { id: imp.id } }))).toMatch(
        /impersonation_sessions_immutable/,
      );
      const reassign = prisma.$executeRawUnsafe(
        `UPDATE impersonation_sessions SET actor_user_id = $1::uuid, active_actor_id = $1::uuid, actor_session_id = $2::uuid WHERE id = $3::uuid`,
        otherAdmin,
        otherAdminSession,
        imp.id,
      );
      expect(await failure(reassign)).toMatch(/impersonation_sessions_immutable/);
    });

    it('restricts deleting the people and admin session an impersonation names', async () => {
      await start();
      expect(await failure(prisma.user.delete({ where: { id: merchant } }))).toMatch(
        /fkey|Foreign key|foreign key/,
      );
      expect(await failure(prisma.session.delete({ where: { id: adminSession } }))).toMatch(
        /impersonation_sessions_actor_session_id_fkey/,
      );
    });
  });

  describe('exchange codes', () => {
    it('stores only a hash, with a 60-second limit, and redeems once', async () => {
      const imp = await start();
      const code = (expiresInMs: number, codeHash = hashToken(randomUUID())) =>
        prisma.impersonationExchangeCode.create({
          data: {
            impersonationId: imp.id,
            codeHash,
            codeChallenge: CHALLENGE,
            expiresAt: new Date(Date.now() + expiresInMs),
          },
        });
      expect(await failure(code(61_000))).toMatch(/impersonation_exchange_codes_ttl_check/);
      expect(await failure(code(30_000, 'raw-code-not-a-hash'))).toMatch(
        /impersonation_exchange_codes_format_check/,
      );
      const issued = await code(30_000);
      expect(await failure(code(30_000))).toMatch(/impersonation_id/); // one code per impersonation

      // The redemption pattern Phase 4C.3 uses: a single conditional update.
      const redeem = () =>
        prisma.impersonationExchangeCode.updateMany({
          where: { codeHash: issued.codeHash, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        });
      expect((await redeem()).count).toBe(1);
      expect((await redeem()).count).toBe(0);
      const reset = prisma.$executeRawUnsafe(
        'UPDATE impersonation_exchange_codes SET used_at = NULL WHERE id = $1::uuid',
        issued.id,
      );
      expect(await failure(reset)).toMatch(/impersonation_exchange_codes_immutable/);
      expect(
        await failure(prisma.impersonationExchangeCode.delete({ where: { id: issued.id } })),
      ).toMatch(/impersonation_exchange_codes_immutable/);
    });
  });

  describe('notification outbox', () => {
    it('creates one notification per event, however often it is enqueued', async () => {
      const imp = await start();
      const enqueue = () =>
        prisma.$executeRawUnsafe(
          `INSERT INTO notification_outbox (id, kind, dedupe_key, recipient_user_id, impersonation_id, updated_at)
           VALUES ($1::uuid, 'IMPERSONATION_SUMMARY', $2, $3::uuid, $4::uuid, now())
           ON CONFLICT (dedupe_key) DO NOTHING`,
          randomUUID(),
          `impersonation-summary:${imp.id}`,
          merchant,
          imp.id,
        );
      expect(await enqueue()).toBe(1);
      expect(await enqueue()).toBe(0);
      expect(await prisma.notificationOutbox.count()).toBe(1);
    });

    it('lets only the sender holding the lease complete a delivery, exactly once', async () => {
      const imp = await start();
      const row = await prisma.notificationOutbox.create({
        data: {
          kind: 'IMPERSONATION_SUMMARY',
          dedupeKey: `impersonation-summary:${imp.id}`,
          recipientUserId: merchant,
          impersonationId: imp.id,
        },
      });
      const lease = randomUUID();
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: { leaseToken: lease, leaseExpiresAt: new Date(Date.now() + MINUTE), attempts: 1 },
      });
      const complete = (token: string) =>
        prisma.notificationOutbox.updateMany({
          where: { id: row.id, leaseToken: token, status: 'PENDING' },
          data: { status: 'SENT', sentAt: new Date(), leaseToken: null, leaseExpiresAt: null },
        });
      expect((await complete(randomUUID())).count).toBe(0);
      expect((await complete(lease)).count).toBe(1);
      expect((await complete(lease)).count).toBe(0);
    });

    it('keeps the delivery state consistent', async () => {
      const imp = await start();
      const bad = (fields: string, values: string) =>
        failure(
          prisma.$executeRawUnsafe(
            `INSERT INTO notification_outbox (id, kind, dedupe_key, recipient_user_id, updated_at, ${fields})
             VALUES ('${randomUUID()}', 'IMPERSONATION_SUMMARY', '${randomUUID()}', '${merchant}', now(), ${values})`,
          ),
        );
      expect(await bad('impersonation_id, status', `'${imp.id}', 'SENT'`)).toMatch(
        /notification_outbox_state_check/,
      );
      expect(await bad('impersonation_id, lease_token', `'${imp.id}', '${randomUUID()}'`)).toMatch(
        /notification_outbox_state_check/,
      );
      expect(await bad('impersonation_id, attempts', `'${imp.id}', -1`)).toMatch(
        /notification_outbox_state_check/,
      );
      expect(await bad('status', `'PENDING'`)).toMatch(/notification_outbox_kind_check/);
    });
  });

  describe('financial adjustment provenance (ADR 0003 §10.4)', () => {
    /** A balanced posting: debit one account, credit another, optionally for a shipment. */
    async function posting(
      kind: string,
      debitAccount: string,
      creditAccount: string,
      shipmentId: string | null,
    ): Promise<string> {
      const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `WITH e AS (
           INSERT INTO journal_entries (id, kind, source_type, source_id)
           VALUES (gen_random_uuid(), $1::"JournalKind", 'test', gen_random_uuid()::text) RETURNING id
         ), l AS (
           INSERT INTO journal_lines (id, entry_id, account_id, side, amount, shipment_id)
           SELECT gen_random_uuid(), e.id, $2::uuid, 'DEBIT'::"EntrySide", 10, $4::uuid FROM e
           UNION ALL
           SELECT gen_random_uuid(), e.id, $3::uuid, 'CREDIT'::"EntrySide", 10, $4::uuid FROM e
           RETURNING entry_id
         )
         SELECT DISTINCT entry_id AS id FROM l`,
        kind,
        debitAccount,
        creditAccount,
        shipmentId,
      );
      return rows[0]!.id;
    }

    async function account(code: string, purpose: string, type: string, owner: string | null) {
      const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO financial_accounts (id, code, purpose, type, owner_user_id)
         VALUES (gen_random_uuid(), $1, $2::"AccountPurpose", $3::"AccountType", $4::uuid) RETURNING id`,
        code,
        purpose,
        type,
        owner,
      );
      return rows[0]!.id;
    }

    let merchantBalance: string;
    let otherBalance: string;
    let cash: string;
    let revenue: string;
    let ownShipment: string;
    let feePosting: string;
    let payoutPosting: string;
    let otherPosting: string;

    beforeEach(async () => {
      merchantBalance = await account(
        `MERCHANT_BALANCE:${merchant}`,
        'MERCHANT_BALANCE',
        'LIABILITY',
        merchant,
      );
      otherBalance = await account(
        `MERCHANT_BALANCE:${otherMerchant}`,
        'MERCHANT_BALANCE',
        'LIABILITY',
        otherMerchant,
      );
      cash = await account(`TEST_CASH:${randomUUID()}`, 'COMPANY_CASH_HUB', 'ASSET', null);
      revenue = await account(
        `TEST_REVENUE:${randomUUID()}`,
        'DELIVERY_FEE_REVENUE',
        'REVENUE',
        null,
      );
      ownShipment = (await shipment(merchant, merchant)).id;
      feePosting = await posting('DELIVERY_FEE', merchantBalance, revenue, ownShipment);
      // A posting with no shipment at all (e.g. a payout): JOURNAL_ENTRY provenance covers it.
      payoutPosting = await posting('MERCHANT_PAYOUT', merchantBalance, cash, null);
      otherPosting = await posting('MERCHANT_PAYOUT', otherBalance, cash, null);
    });

    const adjustment = (source: {
      sourceType?:
        | 'SHIPMENT_FEE'
        | 'RETURN_CHARGE'
        | 'COD_SHORTFALL'
        | 'JOURNAL_ENTRY'
        | 'UNLINKED';
      sourceShipmentId?: string | null;
      sourceJournalEntryId?: string | null;
      merchantId?: string;
    }) =>
      prisma.financialAdjustment.create({
        data: {
          type: 'MERCHANT_CREDIT',
          merchantId: source.merchantId ?? merchant,
          amount: '10.00',
          reason: 'Correction of a fee',
          requestedById: accountant,
          ...(source.sourceType ? { sourceType: source.sourceType } : {}),
          sourceShipmentId: source.sourceShipmentId ?? null,
          sourceJournalEntryId: source.sourceJournalEntryId ?? null,
        },
      });

    it('treats adjustments written without provenance (and all earlier ones) as UNLINKED', async () => {
      const row = await adjustment({});
      expect(row.sourceType).toBe('UNLINKED');
      expect(row.sourceShipmentId).toBeNull();
      expect(row.sourceJournalEntryId).toBeNull();
    });

    it('requires the source each provenance type names', async () => {
      expect(await failure(adjustment({ sourceType: 'SHIPMENT_FEE' }))).toMatch(
        /financial_adjustments_source_check/,
      );
      expect(await failure(adjustment({ sourceType: 'JOURNAL_ENTRY' }))).toMatch(
        /financial_adjustments_source_check/,
      );
      expect(
        await failure(adjustment({ sourceType: 'UNLINKED', sourceShipmentId: ownShipment })),
      ).toMatch(/financial_adjustments_source_check/);
    });

    it('links a shipment posting, and a posting that has no shipment', async () => {
      const fee = await adjustment({
        sourceType: 'SHIPMENT_FEE',
        sourceShipmentId: ownShipment,
        sourceJournalEntryId: feePosting,
      });
      expect(fee.sourceJournalEntryId).toBe(feePosting);
      const payout = await adjustment({
        sourceType: 'JOURNAL_ENTRY',
        sourceJournalEntryId: payoutPosting,
      });
      expect(payout.sourceShipmentId).toBeNull();
      await adjustment({ sourceType: 'RETURN_CHARGE', sourceShipmentId: ownShipment });
    });

    it('rejects provenance that does not belong to the merchant or does not match', async () => {
      const foreignShipment = (await shipment(otherMerchant, otherMerchant)).id;
      expect(
        await failure(
          adjustment({ sourceType: 'SHIPMENT_FEE', sourceShipmentId: foreignShipment }),
        ),
      ).toMatch(/financial_adjustments_provenance_check/);
      expect(
        await failure(
          adjustment({ sourceType: 'JOURNAL_ENTRY', sourceJournalEntryId: otherPosting }),
        ),
      ).toMatch(/financial_adjustments_provenance_check/);
      // A real posting of this merchant, but not one for the named shipment.
      expect(
        await failure(
          adjustment({
            sourceType: 'SHIPMENT_FEE',
            sourceShipmentId: ownShipment,
            sourceJournalEntryId: payoutPosting,
          }),
        ),
      ).toMatch(/financial_adjustments_provenance_check/);
    });

    it('keeps provenance, merchant, requester, type and amount fixed; only the decision is recorded', async () => {
      const row = await adjustment({
        sourceType: 'JOURNAL_ENTRY',
        sourceJournalEntryId: payoutPosting,
      });
      const change = (set: string) =>
        failure(
          prisma.$executeRawUnsafe(
            `UPDATE financial_adjustments SET ${set} WHERE id = $1::uuid`,
            row.id,
          ),
        );
      expect(await change(`source_type = 'UNLINKED', source_journal_entry_id = NULL`)).toMatch(
        /financial_adjustments_provenance_immutable/,
      );
      expect(await change(`amount = 999`)).toMatch(/financial_adjustments_provenance_immutable/);
      expect(await change(`requested_by_id = '${admin}'`)).toMatch(
        /financial_adjustments_provenance_immutable/,
      );
      expect(await change(`merchant_id = '${otherMerchant}'`)).toMatch(
        /financial_adjustments_provenance_immutable/,
      );
      await prisma.financialAdjustment.update({
        where: { id: row.id },
        data: { status: 'REJECTED', decidedById: admin, decidedAt: new Date(), decisionNote: 'No' },
      });
    });

    it('adds the provenance columns without touching existing rows', async () => {
      const rows = await prisma.$queryRawUnsafe<
        { column: string; nullable: string; def: string | null }[]
      >(
        `SELECT column_name AS column, is_nullable AS nullable, column_default AS def
         FROM information_schema.columns
         WHERE table_name = 'financial_adjustments' AND column_name LIKE 'source_%' ORDER BY 1`,
      );
      expect(rows).toEqual([
        { column: 'source_journal_entry_id', nullable: 'YES', def: null },
        { column: 'source_shipment_id', nullable: 'YES', def: null },
        { column: 'source_type', nullable: 'NO', def: `'UNLINKED'::"AdjustmentSourceType"` },
      ]);
    });
  });

  describe('financial tables', () => {
    it('adds no impersonation column to any ledger or money table', async () => {
      const rows = await prisma.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name LIKE '%imperson%' ORDER BY 1, 2`,
      );
      expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
        'audit_logs.impersonation_id',
        'impersonation_exchange_codes.impersonation_id',
        'notification_outbox.impersonation_id',
        'pricing_quotes.impersonation_id',
        'return_records.requested_impersonation_id',
        'sessions.impersonation_id',
        'shipment_status_history.impersonation_id',
        'shipments.created_impersonation_id',
      ]);
    });

    it('adds only nullable columns to existing tables', async () => {
      const rows = await prisma.$queryRawUnsafe<{ column: string; nullable: string }[]>(
        `SELECT table_name || '.' || column_name AS column, is_nullable AS nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND (table_name, column_name) IN (
           ('audit_logs', 'effective_user_id'), ('audit_logs', 'impersonation_id'),
           ('sessions', 'impersonation_id'), ('sessions', 'reauthenticated_at'),
           ('shipment_status_history', 'impersonation_id'),
           ('shipments', 'created_impersonation_id'),
           ('return_records', 'requested_impersonation_id'),
           ('pricing_quotes', 'impersonation_id'))
         ORDER BY 1`,
      );
      expect(rows).toHaveLength(8);
      expect(rows.every((r) => r.nullable === 'YES')).toBe(true);
    });
  });
});
