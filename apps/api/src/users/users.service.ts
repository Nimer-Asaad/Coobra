import { Injectable, Logger } from '@nestjs/common';
import type { User } from '@coobra/database';
import type { CreateUserInput, Language } from '@coobra/shared';
import { AuditService } from '../audit/audit.service.js';
import { AuthTokenService, TOKEN_TTL_MS } from '../auth/auth-token.service.js';
import { isUniqueViolation } from '../auth/auth.service.js';
import { Errors } from '../common/app-exception.js';
import type { RequestMeta } from '../common/request.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { UserWithProfile } from './user.mapper.js';

const LIST_LIMIT = 100;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AuthTokenService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  async updateLanguage(user: UserWithProfile, language: Language, meta: RequestMeta) {
    const updated = await this.prisma.client.user.update({
      where: { id: user.id },
      data: { language },
      include: { merchantProfile: true },
    });
    await this.audit.record({
      action: 'USER_PREFERENCES_UPDATED',
      actorUserId: user.id,
      targetUserId: user.id,
      meta,
      metadata: { language },
    });
    return updated;
  }

  list(): Promise<User[]> {
    return this.prisma.client.user.findMany({ orderBy: { createdAt: 'desc' }, take: LIST_LIMIT });
  }

  /**
   * Creates a staff member or driver without a password. The user receives a single-use
   * link to set their own password, so administrators never handle credentials.
   */
  async createInvitedUser(input: CreateUserInput, actorUserId: string, meta: RequestMeta) {
    let created: { user: User; token: string };
    try {
      created = await this.prisma.client.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: input.email,
            fullName: input.fullName,
            phone: input.phone ?? null,
            role: input.role,
            language: input.language,
            createdById: actorUserId,
          },
        });
        const token = await this.tokens.issue(user.id, 'ACCOUNT_SETUP', tx);
        return { user, token };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw Errors.emailAlreadyRegistered();
      throw error;
    }

    await this.audit.record({
      action: 'USER_CREATED',
      actorUserId,
      targetUserId: created.user.id,
      meta,
      metadata: { role: created.user.role },
    });

    try {
      await this.mail.sendAccountSetup(
        created.user,
        created.token,
        TOKEN_TTL_MS.ACCOUNT_SETUP / (60 * 60 * 1000),
      );
    } catch (error) {
      // The account exists; the admin can trigger "forgot password" for the user later.
      this.logger.error(
        `Failed to send account setup email to user ${created.user.id}`,
        error as Error,
      );
    }
    return created.user;
  }
}
