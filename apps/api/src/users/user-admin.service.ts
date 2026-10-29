import { Injectable } from '@nestjs/common';
import { Prisma, type User } from '@coobra/database';
import {
  isRoleChangeable,
  type ChangeUserRoleInput,
  type ChangeUserStatusInput,
  type ListUsersQuery,
  type Paginated,
  type UpdateUserProfileInput,
  type UserDetails,
  type UserListItem,
  type UserRole,
} from '@coobra/shared';
import { redactMetadata } from '../audit/audit-redaction.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../auth/session.service.js';
import { Errors } from '../common/app-exception.js';
import type { RequestMeta } from '../common/request.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toUserListItem } from './user.mapper.js';

type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: UserRole };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_LIMIT = 25;
const USER_ACTIONS = [
  'USER_CREATED',
  'USER_PROFILE_UPDATED',
  'USER_DEACTIVATED',
  'USER_REACTIVATED',
  'USER_ROLE_CHANGED',
  'AUTH_PASSWORD_RESET_COMPLETED',
  'AUTH_EMAIL_VERIFIED',
];

/**
 * Administrative user management (SUPER_ADMIN only: the routes require it and every method
 * checks it again). Changes lock the user row and compare the version the administrator saw;
 * anything that can remove a super admin also locks every active super admin, so concurrent
 * changes can never leave the platform without one. The change, the session revocation and
 * the audit entry commit in one transaction (a failed audit write rolls the change back).
 */
@Injectable()
export class UserAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  private assertSuperAdmin(actor: Actor) {
    if (actor.role !== 'SUPER_ADMIN') throw Errors.forbidden();
  }

  async list(actor: Actor, query: ListUsersQuery): Promise<Paginated<UserListItem>> {
    this.assertSuperAdmin(actor);
    const q = query.q;
    const where: Prisma.UserWhereInput = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(q
        ? {
            OR: [
              { fullName: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
              { merchantProfile: { businessName: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.client.$transaction([
      this.prisma.client.user.count({ where }),
      this.prisma.client.user.findMany({
        where,
        include: { merchantProfile: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { items: rows.map(toUserListItem), page: query.page, pageSize: query.pageSize, total };
  }

  async details(actor: Actor, id: string): Promise<UserDetails> {
    this.assertSuperAdmin(actor);
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    const db = this.prisma.client;
    const user = await db.user.findUnique({
      where: { id },
      include: { merchantProfile: true, createdBy: { select: { id: true, fullName: true } } },
    });
    if (!user) throw Errors.notFound();
    const now = new Date();
    const [activeSessions, lastSession, history] = await Promise.all([
      db.session.count({ where: { userId: id, revokedAt: null, expiresAt: { gt: now } } }),
      db.session.findFirst({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      db.auditLog.findMany({
        where: { targetUserId: id, action: { in: USER_ACTIONS } },
        include: { actor: { select: { id: true, fullName: true } } },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_LIMIT,
      }),
    ]);
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      role: user.role,
      status: user.status,
      language: user.language,
      emailVerified: user.emailVerifiedAt !== null,
      merchant: user.merchantProfile ? { businessName: user.merchantProfile.businessName } : null,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      createdBy: user.createdBy,
      lastSignInAt: lastSession?.createdAt.toISOString() ?? null,
      activeSessions,
      history: history.map((entry) => ({
        id: entry.id,
        action: entry.action,
        actor: entry.actor,
        createdAt: entry.createdAt.toISOString(),
        // The same redaction as the audit log viewer.
        metadata: redactMetadata(entry.metadata).value,
      })),
    };
  }

  /**
   * Locks the target (and, when the target is a super admin, every active super admin first,
   * always in the same order, so concurrent changes queue instead of deadlocking) and checks
   * the version the administrator saw.
   */
  private async lockTarget(tx: Tx, id: string, expectedUpdatedAt: string): Promise<User> {
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    const peek = await tx.user.findUnique({ where: { id }, select: { role: true } });
    if (!peek) throw Errors.notFound();
    if (peek.role === 'SUPER_ADMIN') {
      await tx.$queryRaw`
        SELECT id FROM users WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE'
        ORDER BY id FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id } });
    // A role change between the peek and the lock also changes the version.
    if (user.updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()) {
      throw Errors.userChanged();
    }
    return user;
  }

  /**
   * Refuses to leave the platform without a super admin who can sign in (rows already
   * locked). An invited super admin who has not set a password yet does not count.
   */
  private async assertAnotherActiveSuperAdmin(tx: Tx, user: User) {
    if (user.role !== 'SUPER_ADMIN' || user.status !== 'ACTIVE') return;
    const others = await tx.user.count({
      where: {
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        passwordHash: { not: null },
        emailVerifiedAt: { not: null },
        id: { not: user.id },
      },
    });
    if (others === 0) throw Errors.lastSuperAdmin();
  }

  async updateProfile(
    actor: Actor,
    id: string,
    input: UpdateUserProfileInput,
    meta: RequestMeta,
  ): Promise<UserDetails> {
    this.assertSuperAdmin(actor);
    await this.prisma.client.$transaction(async (tx) => {
      const user = await this.lockTarget(tx, id, input.expectedUpdatedAt);
      const profile = await tx.merchantProfile.findUnique({ where: { userId: id } });
      if (input.businessName !== undefined && !profile) {
        throw Errors.validation({ businessName: 'validation.user.merchantOnly' });
      }
      const phone = input.phone === undefined ? undefined : input.phone || null;
      const before: Record<string, string | null> = {};
      const after: Record<string, string | null> = {};
      const track = (field: string, from: string | null, to: string | null | undefined) => {
        if (to === undefined || to === from) return;
        before[field] = from;
        after[field] = to;
      };
      track('fullName', user.fullName, input.fullName);
      track('phone', user.phone, phone);
      track('language', user.language, input.language);
      track('businessName', profile?.businessName ?? null, input.businessName);
      if (Object.keys(after).length === 0) return;
      await tx.user.update({
        where: { id },
        data: {
          ...(after.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...('phone' in after ? { phone } : {}),
          ...(after.language !== undefined ? { language: input.language } : {}),
        },
      });
      if ('businessName' in after) {
        await tx.merchantProfile.update({
          where: { userId: id },
          data: { businessName: input.businessName },
        });
        // The profile lives in another table: bump the user version too.
        await tx.user.update({ where: { id }, data: { updatedAt: new Date() } });
      }
      await this.audit.recordIn(tx, {
        action: 'USER_PROFILE_UPDATED',
        actorUserId: actor.id,
        targetUserId: id,
        meta,
        metadata: { before, after },
      });
    });
    return this.details(actor, id);
  }

  async setActive(
    actor: Actor,
    id: string,
    active: boolean,
    input: ChangeUserStatusInput,
    meta: RequestMeta,
  ): Promise<UserDetails> {
    this.assertSuperAdmin(actor);
    if (id === actor.id) throw Errors.userSelfChangeForbidden();
    await this.prisma.client.$transaction(async (tx) => {
      const user = await this.lockTarget(tx, id, input.expectedUpdatedAt);
      const target = active ? 'ACTIVE' : 'DISABLED';
      if (user.status === target) {
        throw Errors.invalidState(active ? 'The account is already active' : 'Already disabled');
      }
      if (!active) await this.assertAnotherActiveSuperAdmin(tx, user);
      await tx.user.update({ where: { id }, data: { status: target } });
      // A deactivated account is signed out everywhere at once.
      const sessionsRevoked = active ? 0 : await this.sessions.revokeAllForUser(id, tx);
      await this.audit.recordIn(tx, {
        action: active ? 'USER_REACTIVATED' : 'USER_DEACTIVATED',
        actorUserId: actor.id,
        targetUserId: id,
        meta,
        metadata: { reason: input.reason, role: user.role, sessionsRevoked },
      });
    });
    return this.details(actor, id);
  }

  async changeRole(
    actor: Actor,
    id: string,
    input: ChangeUserRoleInput,
    meta: RequestMeta,
  ): Promise<UserDetails> {
    this.assertSuperAdmin(actor);
    if (id === actor.id) throw Errors.userSelfChangeForbidden();
    await this.prisma.client.$transaction(async (tx) => {
      const user = await this.lockTarget(tx, id, input.expectedUpdatedAt);
      if (!isRoleChangeable(user.role)) throw Errors.userRoleNotChangeable();
      if (user.role === input.role) throw Errors.invalidState('The user already has this role');
      if (input.role !== 'SUPER_ADMIN') await this.assertAnotherActiveSuperAdmin(tx, user);
      await tx.user.update({ where: { id }, data: { role: input.role } });
      // New permissions apply from a fresh sign-in.
      const sessionsRevoked = await this.sessions.revokeAllForUser(id, tx);
      await this.audit.recordIn(tx, {
        action: 'USER_ROLE_CHANGED',
        actorUserId: actor.id,
        targetUserId: id,
        meta,
        metadata: { from: user.role, to: input.role, reason: input.reason, sessionsRevoked },
      });
    });
    return this.details(actor, id);
  }
}
