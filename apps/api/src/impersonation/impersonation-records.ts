import type { ImpersonationEndReason, Prisma } from '@coobra/database';
import {
  IMPERSONATION_COOKIE_NAME,
  IMPERSONATION_SECURE_COOKIE_NAME,
  type ImpersonationInfo,
  type ImpersonationTargetRole,
} from '@coobra/shared';
import type { RequestMeta } from '../common/request.js';
import type { AppConfig } from '../config/env.js';

/*
 * Dependency-free impersonation helpers shared by the session service (revocation), the auth
 * service (logout) and the impersonation service. Every function runs inside the caller's
 * transaction, so an end and the change that caused it commit together.
 */

type Tx = Prisma.TransactionClient;

export const summaryDedupeKey = (impersonationId: string) =>
  `impersonation-summary:${impersonationId}`;

/** The exact browser origin allowed to use an impersonation of this client app. */
export function appOriginFor(config: AppConfig, clientApp: 'MERCHANT_APP' | 'DRIVER_APP'): string {
  const url =
    clientApp === 'MERCHANT_APP' ? config.links.merchantAppUrl : config.links.driverAppUrl;
  return new URL(url).origin;
}

export function adminOrigin(config: AppConfig): string {
  return new URL(config.links.adminWebUrl).origin;
}

/**
 * Ends one impersonation, idempotently. A single conditional update decides the winner, so
 * concurrent enders (banner, admin, sweeper, revocation) end it exactly once; only the winner
 * revokes the temporary session, writes `IMPERSONATION_ENDED` and queues the summary email.
 * Returns false when it had already ended.
 */
export async function endImpersonationIn(
  tx: Tx,
  input: {
    impersonationId: string;
    reason: ImpersonationEndReason;
    now: Date;
    /** Who ended it; defaults to the impersonating admin (expiry, revocation). */
    endedById?: string | null;
    meta?: RequestMeta;
  },
): Promise<boolean> {
  const { impersonationId: id, reason, now } = input;
  const ended = await tx.impersonationSession.updateMany({
    where: { id, endedAt: null },
    data: { endedAt: now, endedReason: reason, activeActorId: null, activeTargetId: null },
  });
  if (ended.count === 0) return false;
  const row = await tx.impersonationSession.findUniqueOrThrow({
    where: { id },
    select: { actorUserId: true, targetUserId: true },
  });
  await tx.session.updateMany({
    where: { impersonationId: id, revokedAt: null },
    data: { revokedAt: now },
  });
  // An action of the admin (not of the impersonated account): no effective user (ADR §11.1).
  await tx.auditLog.create({
    data: {
      action: 'IMPERSONATION_ENDED',
      actorUserId: input.endedById ?? row.actorUserId,
      targetUserId: row.targetUserId,
      ipAddress: input.meta?.ipAddress ?? null,
      userAgent: input.meta?.userAgent ?? null,
      metadata: { impersonationId: id, endReason: reason },
    },
  });
  await tx.notificationOutbox.createMany({
    data: [
      {
        kind: 'IMPERSONATION_SUMMARY',
        dedupeKey: summaryDedupeKey(id),
        recipientUserId: row.targetUserId,
        impersonationId: id,
      },
    ],
    skipDuplicates: true,
  });
  return true;
}

/** Ends every active impersonation by or of this user (deactivation, role change, reset). */
export async function endImpersonationsInvolving(tx: Tx, userId: string, now: Date) {
  const active = await tx.impersonationSession.findMany({
    where: { endedAt: null, OR: [{ actorUserId: userId }, { targetUserId: userId }] },
    select: { id: true, actorUserId: true },
  });
  for (const row of active) {
    await endImpersonationIn(tx, {
      impersonationId: row.id,
      reason: row.actorUserId === userId ? 'ACTOR_REVOKED' : 'TARGET_REVOKED',
      now,
    });
  }
  return active.length;
}

/** Ends the impersonations started from an admin session that is ending (logout). */
export async function endImpersonationsStartedFrom(
  tx: Tx,
  actorSessionId: string,
  now: Date,
  meta?: RequestMeta,
) {
  const active = await tx.impersonationSession.findMany({
    where: { endedAt: null, actorSessionId },
    select: { id: true },
  });
  for (const row of active) {
    await endImpersonationIn(tx, { impersonationId: row.id, reason: 'ACTOR_LOGOUT', now, meta });
  }
  return active.length;
}

export const impersonationInfoInclude = {
  actor: { select: { id: true, fullName: true } },
  target: { select: { id: true, fullName: true } },
} satisfies Prisma.ImpersonationSessionInclude;

type ImpersonationWithPeople = Prisma.ImpersonationSessionGetPayload<{
  include: typeof impersonationInfoInclude;
}>;

export function toImpersonationInfo(
  row: ImpersonationWithPeople,
  now: Date,
  config: AppConfig,
): ImpersonationInfo {
  return {
    id: row.id,
    actor: row.actor,
    target: { ...row.target, role: row.targetRole as ImpersonationTargetRole },
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    endedReason: row.endedReason ?? null,
    serverNow: now.toISOString(),
    writesEnabled: config.impersonationWrites.enabled,
  };
}

export async function loadImpersonationInfo(
  db: Tx,
  id: string,
  now: Date,
  config: AppConfig,
): Promise<ImpersonationInfo | null> {
  const row = await db.impersonationSession.findUnique({
    where: { id },
    include: impersonationInfoInclude,
  });
  return row ? toImpersonationInfo(row, now, config) : null;
}

/** The separate httpOnly impersonation cookie (host-only, `SameSite=Strict`, ADR §8.2). */
export function impersonationCookie(config: AppConfig) {
  return {
    name: config.session.cookieSecure
      ? IMPERSONATION_SECURE_COOKIE_NAME
      : IMPERSONATION_COOKIE_NAME,
    options: {
      httpOnly: true,
      secure: config.session.cookieSecure,
      sameSite: 'strict' as const,
      path: '/',
    },
  };
}
