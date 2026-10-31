import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@coobra/database';
import {
  IMPERSONATION_EXCHANGE_CODE_TTL_SECONDS,
  IMPERSONATION_MAX_DURATION_MINUTES,
  IMPERSONATION_STEP_UP_WINDOW_MINUTES,
  IMPERSONATION_TARGET_ROLES,
  type ExchangeImpersonationInput,
  type ImpersonationInfo,
  type ImpersonationStartResponse,
  type StartImpersonationInput,
  type UserRole,
} from '@coobra/shared';
import { AuditService } from '../audit/audit.service.js';
import { isUniqueViolation } from '../auth/auth.service.js';
import { PasswordService } from '../auth/password.service.js';
import { generateOpaqueToken, hashToken } from '../auth/token.util.js';
import { AppException, Errors } from '../common/app-exception.js';
import { CLOCK, type Clock } from '../common/clock.js';
import type { RequestAuth, RequestMeta } from '../common/request.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  adminOrigin,
  appOriginFor,
  endImpersonationIn,
  impersonationInfoInclude,
  toImpersonationInfo,
} from './impersonation-records.js';

const MINUTE = 60_000;
/** Step-up brute-force limit, shared across instances through the database. */
const STEP_UP_MAX_FAILURES = 5;
const STEP_UP_WINDOW_MS = 15 * MINUTE;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notAllowed = () =>
  new AppException(
    HttpStatus.FORBIDDEN,
    'IMPERSONATION_NOT_ALLOWED',
    'This account cannot be impersonated',
  );
const alreadyActive = () =>
  new AppException(
    HttpStatus.CONFLICT,
    'IMPERSONATION_ACTIVE',
    'An impersonation is already active for this administrator or this account',
  );
const disabled = () =>
  new AppException(
    HttpStatus.FORBIDDEN,
    'IMPERSONATION_NOT_ALLOWED',
    'Impersonation is disabled on this deployment',
  );
const stepUpLocked = () =>
  new AppException(
    HttpStatus.TOO_MANY_REQUESTS,
    'RATE_LIMITED',
    'Too many failed password attempts; try again later',
  );
const reauthRequired = () =>
  new AppException(
    HttpStatus.FORBIDDEN,
    'REAUTH_REQUIRED',
    'Re-enter your password before starting an impersonation',
  );
const codeInvalid = () =>
  new AppException(
    HttpStatus.UNAUTHORIZED,
    'IMPERSONATION_CODE_INVALID',
    'The impersonation code is invalid, used or expired',
  );

/** base64url SHA-256 of the verifier, compared in constant time with the stored challenge. */
function verifierMatches(verifier: string, challenge: string): boolean {
  const actual = Buffer.from(createHash('sha256').update(verifier, 'utf8').digest('base64url'));
  const expected = Buffer.from(challenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface ExchangeResult {
  token: string;
  impersonation: ImpersonationInfo;
}

/**
 * The impersonation lifecycle (ADR 0003 §5, §8, §9): password step-up, start, the single-use
 * code exchange, end, and the admin console's reads. Every state change is one transaction; the
 * database guarantees one active impersonation per actor and per target.
 */
@Injectable()
export class ImpersonationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Admin-only operations must come from an ordinary admin-console session. A browser cookie
   * also needs the exact admin origin (CSRF); the console's server calls with a Bearer token.
   */
  private assertAdminRequest(auth: RequestAuth, origin: string | undefined): void {
    if (!this.config.impersonation.enabled) throw disabled();
    if (auth.acting.impersonation || auth.session.impersonationId) {
      throw Errors.impersonationForbiddenAction();
    }
    if (auth.session.clientApp !== 'ADMIN_WEB' || auth.user.role !== 'SUPER_ADMIN') {
      throw Errors.forbidden();
    }
    if (auth.transport === 'cookie' && origin !== adminOrigin(this.config)) {
      throw Errors.csrfOriginRejected();
    }
  }

  /**
   * Password re-entry on the admin session; allows one impersonation start within 5 minutes.
   *
   * Distributed brute-force protection (shared by every API instance, no per-instance memory):
   * failed attempts are the audit entries themselves. A transaction-scoped advisory lock per user
   * serialises attempts across instances, so at most STEP_UP_MAX_FAILURES failures are evaluated
   * in any STEP_UP_WINDOW; after that every attempt, even with the right password, gets 429.
   */
  async reauthenticate(
    auth: RequestAuth,
    password: string,
    origin: string | undefined,
    meta: RequestMeta,
  ): Promise<void> {
    this.assertAdminRequest(auth, origin);
    const userId = auth.user.id;
    const outcome = await this.prisma.client.$transaction(async (tx) => {
      const lockKey = `coobra:step-up:${userId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const now = this.clock.now();
      const failures = await tx.auditLog.count({
        where: {
          action: 'AUTH_REAUTHENTICATION_FAILED',
          actorUserId: userId,
          createdAt: { gte: new Date(now.getTime() - STEP_UP_WINDOW_MS) },
        },
      });
      if (failures >= STEP_UP_MAX_FAILURES) return 'LOCKED' as const;
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { passwordHash: true },
      });
      const valid = user.passwordHash
        ? await this.passwords.verify(user.passwordHash, password)
        : (await this.passwords.verifyAgainstDummy(password), false);
      if (!valid) {
        await this.audit.recordIn(tx, {
          action: 'AUTH_REAUTHENTICATION_FAILED',
          actorUserId: userId,
          targetUserId: userId,
          meta,
          metadata: { sessionId: auth.session.id },
          at: now,
        });
        return 'INVALID' as const;
      }
      await tx.session.update({
        where: { id: auth.session.id },
        data: { reauthenticatedAt: now },
      });
      await this.audit.recordIn(tx, {
        action: 'AUTH_REAUTHENTICATED',
        actorUserId: userId,
        targetUserId: userId,
        meta,
        metadata: { sessionId: auth.session.id },
        at: now,
      });
      return 'OK' as const;
    });
    if (outcome === 'LOCKED') throw stepUpLocked();
    if (outcome === 'INVALID') throw Errors.invalidCredentials();
  }

  async start(
    auth: RequestAuth,
    input: StartImpersonationInput,
    origin: string | undefined,
    meta: RequestMeta,
  ): Promise<ImpersonationStartResponse> {
    this.assertAdminRequest(auth, origin);
    const actorId = auth.user.id;
    const targetId = input.targetUserId;
    if (targetId === actorId) throw notAllowed();
    const now = this.clock.now();
    const code = generateOpaqueToken();
    try {
      const row = await this.prisma.client.$transaction(async (tx) => {
        // Fixed lock order (by id) so two starts can never deadlock (ADR §9).
        const people = await tx.$queryRaw<{ id: string; role: UserRole; status: string }[]>`
          SELECT id, role::text AS role, status::text AS status FROM users
          WHERE id IN (${actorId}::uuid, ${targetId}::uuid) ORDER BY id FOR UPDATE`;
        // The admin again, under the lock: a deactivation or role change that committed after
        // this request was authenticated must not leave an impersonation behind.
        const actor = people.find((p) => p.id === actorId);
        if (actor?.status !== 'ACTIVE' || actor.role !== 'SUPER_ADMIN') throw Errors.forbidden();
        const target = people.find((p) => p.id === targetId);
        if (!target) throw Errors.notFound();
        if (
          target.status !== 'ACTIVE' ||
          !(IMPERSONATION_TARGET_ROLES as readonly string[]).includes(target.role)
        ) {
          throw notAllowed();
        }
        // The step-up is used up by this start (and kept if the start fails: rolled back). The
        // admin session must still be live: the condition is re-checked on the locked row, so a
        // sign-out committed meanwhile refuses the start.
        const stepUp = await tx.session.updateMany({
          where: {
            id: auth.session.id,
            revokedAt: null,
            expiresAt: { gt: now },
            reauthenticatedAt: {
              gte: new Date(now.getTime() - IMPERSONATION_STEP_UP_WINDOW_MINUTES * MINUTE),
            },
          },
          data: { reauthenticatedAt: null },
        });
        if (stepUp.count !== 1) throw reauthRequired();
        // Release the slots of impersonations that expired without anyone noticing.
        const stale = await tx.impersonationSession.findMany({
          where: {
            endedAt: null,
            expiresAt: { lte: now },
            OR: [{ actorUserId: actorId }, { targetUserId: targetId }],
          },
          select: { id: true },
        });
        for (const s of stale) {
          await endImpersonationIn(tx, { impersonationId: s.id, reason: 'EXPIRED', now });
        }
        const active = await tx.impersonationSession.count({
          where: { OR: [{ activeActorId: actorId }, { activeTargetId: targetId }] },
        });
        if (active > 0) throw alreadyActive();

        const clientApp = target.role === 'MERCHANT' ? 'MERCHANT_APP' : 'DRIVER_APP';
        const created = await tx.impersonationSession.create({
          data: {
            actorUserId: actorId,
            actorSessionId: auth.session.id,
            targetUserId: targetId,
            targetRole: target.role,
            clientApp,
            reason: input.reason,
            ticketReference: input.ticketReference ?? null,
            activeActorId: actorId,
            activeTargetId: targetId,
            startedAt: now,
            expiresAt: new Date(now.getTime() + IMPERSONATION_MAX_DURATION_MINUTES * MINUTE),
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
          include: impersonationInfoInclude,
        });
        await tx.impersonationExchangeCode.create({
          data: {
            impersonationId: created.id,
            codeHash: hashToken(code),
            codeChallenge: input.codeChallenge,
            createdAt: now,
            expiresAt: new Date(now.getTime() + IMPERSONATION_EXCHANGE_CODE_TTL_SECONDS * 1000),
          },
        });
        await this.audit.recordIn(tx, {
          action: 'IMPERSONATION_STARTED',
          actorUserId: actorId,
          targetUserId: targetId,
          meta,
          metadata: {
            impersonationId: created.id,
            targetRole: created.targetRole,
            clientApp,
            expiresAt: created.expiresAt.toISOString(),
            reason: input.reason,
          },
        });
        return created;
      });
      return {
        impersonation: toImpersonationInfo(row, now, this.config),
        code,
        appOrigin: appOriginFor(this.config, row.clientApp as 'MERCHANT_APP' | 'DRIVER_APP'),
      };
    } catch (error) {
      // A start that raced another one hits the database's unique active slots.
      if (isUniqueViolation(error)) throw alreadyActive();
      throw error;
    }
  }

  /**
   * The opened app tab redeems its code: exact app origin, single use (one conditional update;
   * a wrong verifier still burns the code), unexpired, and the impersonation, its admin and the
   * admin's session still valid. Creates the temporary session; its token goes only into the
   * httpOnly impersonation cookie.
   */
  async exchange(
    input: ExchangeImpersonationInput,
    origin: string | undefined,
    meta: RequestMeta,
  ): Promise<ExchangeResult> {
    if (!this.config.impersonation.enabled) throw disabled();
    const now = this.clock.now();
    const stored = await this.prisma.client.impersonationExchangeCode.findUnique({
      where: { codeHash: hashToken(input.code) },
      select: {
        id: true,
        codeChallenge: true,
        impersonation: { select: { clientApp: true } },
      },
    });
    if (!stored) throw codeInvalid();
    const clientApp = stored.impersonation.clientApp as 'MERCHANT_APP' | 'DRIVER_APP';
    if (origin !== appOriginFor(this.config, clientApp)) throw Errors.csrfOriginRejected();

    const outcome = await this.prisma.client.$transaction(async (tx) => {
      const claimed = await tx.impersonationExchangeCode.updateMany({
        where: { id: stored.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return { ok: false as const };
      if (!verifierMatches(input.codeVerifier, stored.codeChallenge)) return { ok: false as const };

      const code = await tx.impersonationExchangeCode.findUniqueOrThrow({
        where: { id: stored.id },
        select: { impersonationId: true },
      });
      await tx.$queryRaw`SELECT id FROM impersonation_sessions WHERE id = ${code.impersonationId}::uuid FOR UPDATE`;
      const imp = await tx.impersonationSession.findUniqueOrThrow({
        where: { id: code.impersonationId },
        include: { ...impersonationInfoInclude, actorSession: true },
      });
      const people = await tx.user.findMany({
        where: { id: { in: [imp.actorUserId, imp.targetUserId] } },
        select: { id: true, role: true, status: true },
      });
      const actor = people.find((p) => p.id === imp.actorUserId);
      const target = people.find((p) => p.id === imp.targetUserId);
      const valid =
        !imp.endedAt &&
        imp.expiresAt > now &&
        actor?.status === 'ACTIVE' &&
        actor.role === 'SUPER_ADMIN' &&
        target?.status === 'ACTIVE' &&
        target.role === imp.targetRole &&
        !imp.actorSession.revokedAt &&
        imp.actorSession.expiresAt > now;
      if (!valid) return { ok: false as const };

      const token = generateOpaqueToken();
      await tx.session.create({
        data: {
          userId: imp.targetUserId,
          clientApp: imp.clientApp,
          tokenHash: hashToken(token),
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          // Absolute and non-renewable: the session ends with the impersonation.
          expiresAt: imp.expiresAt,
          impersonationId: imp.id,
        },
      });
      return { ok: true as const, token, imp };
    });
    if (!outcome.ok) throw codeInvalid();
    return {
      token: outcome.token,
      impersonation: toImpersonationInfo(outcome.imp, now, this.config),
    };
  }

  /** Ends an impersonation (idempotent): returns its final state either way. */
  async end(id: string, endedById: string, meta: RequestMeta): Promise<ImpersonationInfo> {
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    const now = this.clock.now();
    return this.prisma.client.$transaction(async (tx) => {
      const exists = await tx.impersonationSession.count({ where: { id } });
      if (exists === 0) throw Errors.notFound();
      await endImpersonationIn(tx, { impersonationId: id, reason: 'MANUAL', now, endedById, meta });
      const row = await tx.impersonationSession.findUniqueOrThrow({
        where: { id },
        include: impersonationInfoInclude,
      });
      return toImpersonationInfo(row, now, this.config);
    });
  }

  /** The admin console's view of one impersonation or the recent ones. */
  async get(id: string): Promise<ImpersonationInfo> {
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    const row = await this.prisma.client.impersonationSession.findUnique({
      where: { id },
      include: impersonationInfoInclude,
    });
    if (!row) throw Errors.notFound();
    return toImpersonationInfo(row, this.clock.now(), this.config);
  }

  async list(active: boolean | undefined): Promise<ImpersonationInfo[]> {
    const now = this.clock.now();
    const where: Prisma.ImpersonationSessionWhereInput =
      active === undefined
        ? {}
        : active
          ? { endedAt: null, expiresAt: { gt: now } }
          : { OR: [{ endedAt: { not: null } }, { expiresAt: { lte: now } }] };
    const rows = await this.prisma.client.impersonationSession.findMany({
      where,
      include: impersonationInfoInclude,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    return rows.map((row) => toImpersonationInfo(row, now, this.config));
  }
}
