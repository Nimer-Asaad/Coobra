import { Inject, Injectable } from '@nestjs/common';
import type { ClientApp, ImpersonationSession, Prisma, Session } from '@coobra/database';
import { isRoleAllowedForApp } from '@coobra/shared';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RequestMeta } from '../common/request.js';
import type { UserWithProfile } from '../users/user.mapper.js';
import { CLOCK, systemClock, type Clock } from '../common/clock.js';
import {
  endImpersonationsInvolving,
  endImpersonationsStartedFrom,
} from '../impersonation/impersonation-records.js';
import { generateOpaqueToken, hashToken } from './token.util.js';

/** `lastUsedAt` is refreshed at most this often to avoid a write on every request. */
const LAST_USED_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

/** An impersonation session that passed every per-request check (ADR 0003 §5). */
export interface AuthenticatedImpersonation {
  session: Session;
  /** The impersonated account (the principal). */
  user: UserWithProfile;
  impersonation: ImpersonationSession;
}

export interface CreatedSession {
  session: Session;
  token: string;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock = systemClock,
  ) {}

  ttlFor(clientApp: ClientApp): number {
    return clientApp === 'ADMIN_WEB'
      ? this.config.session.adminTtlMs
      : this.config.session.mobileTtlMs;
  }

  async create(
    userId: string,
    clientApp: ClientApp,
    meta: RequestMeta,
    tx: Prisma.TransactionClient = this.prisma.client,
  ): Promise<CreatedSession> {
    const token = generateOpaqueToken();
    const session = await tx.session.create({
      data: {
        userId,
        clientApp,
        tokenHash: hashToken(token),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        expiresAt: new Date(Date.now() + this.ttlFor(clientApp)),
      },
    });
    return { session, token };
  }

  /** Resolves a raw token to an active session and user, or null if it is not valid. */
  async authenticate(token: string): Promise<{ session: Session; user: UserWithProfile } | null> {
    if (token.length < 20 || token.length > 200) return null;
    const found = await this.prisma.client.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { include: { merchantProfile: true } } },
    });
    if (!found) return null;

    const now = Date.now();
    const { user, ...session } = found;
    if (session.revokedAt || session.expiresAt.getTime() <= now) return null;
    // An impersonation session is only ever accepted by authenticateImpersonation (with the
    // impersonation header and exact app origin); it can never act as an ordinary session.
    if (session.impersonationId !== null) return null;
    if (user.status !== 'ACTIVE') return null;
    // A role change must not keep a session open in an app the user no longer belongs to.
    if (!isRoleAllowedForApp(user.role, session.clientApp)) return null;

    if (now - session.lastUsedAt.getTime() > LAST_USED_UPDATE_INTERVAL_MS) {
      await this.prisma.client.session.update({
        where: { id: session.id },
        data: { lastUsedAt: new Date(now) },
      });
    }
    return { session, user };
  }

  /**
   * Validates an impersonation session on every request: the session, the impersonation (active,
   * within its 30 minutes), the real actor (active SUPER_ADMIN), the admin session it was started
   * from (unrevoked, unexpired, admin app, itself not an impersonation) and the target (active,
   * still the recorded role, in its own app). Any failure refuses the request.
   */
  async authenticateImpersonation(token: string): Promise<AuthenticatedImpersonation | null> {
    if (token.length < 20 || token.length > 200) return null;
    const found = await this.prisma.client.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        user: { include: { merchantProfile: true } },
        impersonation: { include: { actor: true, actorSession: true } },
      },
    });
    if (!found?.impersonation) return null;
    const now = this.clock.now().getTime();
    const { user, impersonation, ...session } = found;
    const { actor, actorSession, ...record } = impersonation;
    if (session.revokedAt || session.expiresAt.getTime() <= now) return null;
    if (record.endedAt || record.expiresAt.getTime() <= now) return null;
    if (actor.status !== 'ACTIVE' || actor.role !== 'SUPER_ADMIN') return null;
    if (
      actorSession.revokedAt ||
      actorSession.expiresAt.getTime() <= now ||
      actorSession.clientApp !== 'ADMIN_WEB' ||
      actorSession.impersonationId !== null
    ) {
      return null;
    }
    if (user.status !== 'ACTIVE' || user.role !== record.targetRole) return null;
    if (
      session.clientApp !== record.clientApp ||
      !isRoleAllowedForApp(user.role, session.clientApp)
    ) {
      return null;
    }
    return { session, user, impersonation: record };
  }

  /** Ends a session; an admin session also ends the impersonations started from it. */
  async revoke(sessionId: string, meta?: RequestMeta): Promise<void> {
    const now = this.clock.now();
    await this.prisma.client.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: now },
      });
      await endImpersonationsStartedFrom(tx, sessionId, now, meta);
    });
  }

  /** Revokes every open session of the user; returns how many were open. */
  async revokeAllForUser(
    userId: string,
    tx: Prisma.TransactionClient = this.prisma.client,
  ): Promise<number> {
    const now = this.clock.now();
    const result = await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    // Deactivation, a role change or a password reset also ends every impersonation by or of
    // this user, in the same transaction.
    await endImpersonationsInvolving(tx, userId, now);
    return result.count;
  }
}
