import { Injectable } from '@nestjs/common';
import { Prisma } from '@coobra/database';
import {
  isRoleAllowedForApp,
  type ForgotPasswordInput,
  type LoginInput,
  type RegisterMerchantInput,
  type ResetPasswordInput,
  type VerifyEmailInput,
} from '@coobra/shared';
import { Errors } from '../common/app-exception.js';
import type { RequestMeta } from '../common/request.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { UserWithProfile } from '../users/user.mapper.js';
import { AuthTokenService, TOKEN_TTL_MS } from './auth-token.service.js';
import { PasswordService } from './password.service.js';
import { SessionService, type CreatedSession } from './session.service.js';

export interface AuthResult extends CreatedSession {
  user: UserWithProfile;
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/**
 * Per-account failed-login limit, shared by every API instance through the database: wrong
 * passwords are the AUTH_LOGIN_FAILED audit entries themselves. After LOGIN_MAX_FAILURES within
 * LOGIN_FAILURE_WINDOW_MS (counted from the last password change, so a reset clears it) the
 * account refuses every password, the right one included, until the window moves on.
 */
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_FAILURE_WINDOW_MS = 15 * MINUTE_MS;
/** How long one attempt may wait for another attempt on the same email (PostgreSQL interval). */
const LOGIN_LOCK_WAIT = '2s';

/** PostgreSQL lock_not_available (55P03), however the driver reports it. */
function isLockTimeout(error: unknown): boolean {
  return /55P03|lock timeout/i.test(
    String(error) + JSON.stringify((error as { meta?: unknown })?.meta ?? {}),
  );
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly tokens: AuthTokenService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  /** Public self-registration. Always creates a MERCHANT — the role is never taken from input. */
  async registerMerchant(input: RegisterMerchantInput, meta: RequestMeta): Promise<AuthResult> {
    const passwordHash = await this.passwords.hash(input.password);

    let created: { user: UserWithProfile; verificationToken: string };
    try {
      created = await this.prisma.client.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: input.email,
            passwordHash,
            fullName: input.fullName,
            phone: input.phone,
            role: 'MERCHANT',
            language: input.language,
            passwordChangedAt: new Date(),
            merchantProfile: { create: { businessName: input.businessName } },
          },
          include: { merchantProfile: true },
        });
        const verificationToken = await this.tokens.issue(user.id, 'EMAIL_VERIFICATION', tx);
        return { user, verificationToken };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw Errors.emailAlreadyRegistered();
      throw error;
    }

    const { user, verificationToken } = created;
    this.mail.sendInBackground(
      this.mail.sendEmailVerification(
        user,
        verificationToken,
        TOKEN_TTL_MS.EMAIL_VERIFICATION / HOUR_MS,
      ),
    );
    await this.audit.record({
      action: 'AUTH_REGISTERED',
      actorUserId: user.id,
      targetUserId: user.id,
      meta,
    });

    const session = await this.sessions.create(user.id, 'MERCHANT_APP', meta);
    return { user, ...session };
  }

  async login(input: LoginInput, meta: RequestMeta): Promise<AuthResult> {
    const user = await this.prisma.client.user.findUnique({
      where: { email: input.email },
      include: { merchantProfile: true },
    });

    if (!(await this.checkPassword(input, user, meta)) || !user?.passwordHash) {
      throw Errors.invalidCredentials();
    }

    if (user.status !== 'ACTIVE') throw Errors.accountDisabled();
    if (!isRoleAllowedForApp(user.role, input.clientApp)) throw Errors.roleNotAllowedForApp();

    if (this.passwords.needsRehash(user.passwordHash)) {
      await this.prisma.client.user.update({
        where: { id: user.id },
        data: { passwordHash: await this.passwords.hash(input.password) },
      });
    }

    // A deactivation or role change in progress holds the user row: wait for it and check
    // again, so a session is never created after the change has revoked the user's sessions.
    const { current, session } = await this.prisma.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR SHARE`;
      const fresh = await tx.user.findUniqueOrThrow({
        where: { id: user.id },
        include: { merchantProfile: true },
      });
      if (fresh.status !== 'ACTIVE') throw Errors.accountDisabled();
      if (!isRoleAllowedForApp(fresh.role, input.clientApp)) throw Errors.roleNotAllowedForApp();
      return {
        current: fresh,
        session: await this.sessions.create(user.id, input.clientApp, meta, tx),
      };
    });
    await this.audit.record({
      action: 'AUTH_LOGIN_SUCCEEDED',
      actorUserId: user.id,
      targetUserId: user.id,
      meta,
      metadata: { clientApp: input.clientApp, sessionId: session.session.id },
    });
    return { user: current, ...session };
  }

  /**
   * The password check, under the per-account limit (shared by every API instance).
   *
   * Attempts for one email are serialised by a transaction-scoped advisory lock keyed by the
   * email, so at most LOGIN_MAX_FAILURES wrong passwords are ever evaluated in a window, however
   * many requests arrive at once. Unknown emails take the same lock and the same work, so neither
   * the answer, its timing nor contention tells whether an email has an account. A locked
   * account answers exactly like a wrong password. Waiting for the lock is capped
   * (LOGIN_LOCK_WAIT): a request that cannot get it is refused like a wrong password without a
   * password check, so a flood on one account cannot hold database connections.
   */
  private async checkPassword(
    input: LoginInput,
    user: { id: string } | null,
    meta: RequestMeta,
  ): Promise<boolean> {
    const lockKey = `coobra:login:${input.email}`;
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOGIN_LOCK_WAIT}'`);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        const now = new Date();
        const failed = async (reason: string) => {
          await this.audit.recordIn(tx, {
            action: 'AUTH_LOGIN_FAILED',
            targetUserId: user?.id ?? null,
            meta,
            metadata: { reason, clientApp: input.clientApp },
            at: now,
          });
          return false;
        };
        const account = user
          ? await tx.user.findUnique({
              where: { id: user.id },
              select: { passwordHash: true, passwordChangedAt: true },
            })
          : null;
        if (!account?.passwordHash) {
          await this.passwords.verifyAgainstDummy(input.password);
          return failed(account ? 'NO_PASSWORD' : 'UNKNOWN_EMAIL');
        }
        const windowStart = new Date(now.getTime() - LOGIN_FAILURE_WINDOW_MS);
        const since =
          account.passwordChangedAt && account.passwordChangedAt > windowStart
            ? account.passwordChangedAt
            : windowStart;
        const failures = await tx.auditLog.count({
          where: {
            action: 'AUTH_LOGIN_FAILED',
            targetUserId: user!.id,
            createdAt: { gte: since },
            metadata: { path: ['reason'], equals: 'WRONG_PASSWORD' },
          },
        });
        if (failures >= LOGIN_MAX_FAILURES) {
          await this.passwords.verifyAgainstDummy(input.password);
          // Recorded for the audit log, but not counted: the lock does not extend itself.
          return failed('LOCKED');
        }
        if (await this.passwords.verify(account.passwordHash, input.password)) return true;
        return failed('WRONG_PASSWORD');
      });
    } catch (error) {
      if (isLockTimeout(error)) return false;
      throw error;
    }
  }

  async logout(userId: string, sessionId: string, meta: RequestMeta): Promise<void> {
    await this.sessions.revoke(sessionId, meta);
    await this.audit.record({
      action: 'AUTH_LOGOUT',
      actorUserId: userId,
      targetUserId: userId,
      meta,
      metadata: { sessionId },
    });
  }

  /** Always succeeds from the caller's point of view, so it cannot be used to discover accounts. */
  async requestPasswordReset(input: ForgotPasswordInput, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.client.user.findUnique({ where: { email: input.email } });
    if (!user || user.status !== 'ACTIVE') return;

    const token = await this.tokens.issue(user.id, 'PASSWORD_RESET');
    this.mail.sendInBackground(
      this.mail.sendPasswordReset(user, token, TOKEN_TTL_MS.PASSWORD_RESET / MINUTE_MS),
    );
    await this.audit.record({
      action: 'AUTH_PASSWORD_RESET_REQUESTED',
      targetUserId: user.id,
      meta,
    });
  }

  /** Completes a password reset or an invited user's account setup. Signs out every session. */
  async resetPassword(input: ResetPasswordInput, meta: RequestMeta): Promise<void> {
    const passwordHash = await this.passwords.hash(input.password);
    const userId = await this.prisma.client.$transaction(async (tx) => {
      const token = await this.tokens.consume(input.token, ['PASSWORD_RESET', 'ACCOUNT_SETUP'], tx);
      if (!token) return null;

      const user = await tx.user.findUnique({ where: { id: token.userId } });
      if (!user || user.status !== 'ACTIVE') return null;

      const now = new Date();
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangedAt: now,
          // Following an emailed link proves ownership of the address.
          emailVerifiedAt: user.emailVerifiedAt ?? now,
        },
      });
      await tx.authToken.deleteMany({
        where: {
          userId: user.id,
          purpose: { in: ['PASSWORD_RESET', 'ACCOUNT_SETUP'] },
          usedAt: null,
        },
      });
      await this.sessions.revokeAllForUser(user.id, tx);
      return user.id;
    });

    if (!userId) throw Errors.tokenInvalid();
    await this.audit.record({
      action: 'AUTH_PASSWORD_RESET_COMPLETED',
      actorUserId: userId,
      targetUserId: userId,
      meta,
    });
  }

  async verifyEmail(input: VerifyEmailInput, meta: RequestMeta): Promise<void> {
    const userId = await this.prisma.client.$transaction(async (tx) => {
      const token = await this.tokens.consume(input.token, ['EMAIL_VERIFICATION'], tx);
      if (!token) return null;
      await tx.user.updateMany({
        where: { id: token.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date() },
      });
      return token.userId;
    });

    if (!userId) throw Errors.tokenInvalid();
    await this.audit.record({
      action: 'AUTH_EMAIL_VERIFIED',
      actorUserId: userId,
      targetUserId: userId,
      meta,
    });
  }

  async resendVerification(user: UserWithProfile): Promise<void> {
    if (user.emailVerifiedAt) throw Errors.emailAlreadyVerified();
    const token = await this.tokens.issue(user.id, 'EMAIL_VERIFICATION');
    await this.mail.sendEmailVerification(user, token, TOKEN_TTL_MS.EMAIL_VERIFICATION / HOUR_MS);
  }
}
