import { Inject, Injectable } from '@nestjs/common';
import type { ClientApp, Prisma, Session } from '@coobra/database';
import { isRoleAllowedForApp } from '@coobra/shared';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RequestMeta } from '../common/request.js';
import type { UserWithProfile } from '../users/user.mapper.js';
import { generateOpaqueToken, hashToken } from './token.util.js';

/** `lastUsedAt` is refreshed at most this often to avoid a write on every request. */
const LAST_USED_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

export interface CreatedSession {
  session: Session;
  token: string;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
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

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.client.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revokes every open session of the user; returns how many were open. */
  async revokeAllForUser(
    userId: string,
    tx: Prisma.TransactionClient = this.prisma.client,
  ): Promise<number> {
    const result = await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}
