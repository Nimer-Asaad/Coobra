import { Injectable } from '@nestjs/common';
import type { AuthToken, AuthTokenPurpose, Prisma } from '@coobra/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { generateOpaqueToken, hashToken } from './token.util.js';

export const TOKEN_TTL_MS: Record<AuthTokenPurpose, number> = {
  EMAIL_VERIFICATION: 24 * 60 * 60 * 1000,
  PASSWORD_RESET: 30 * 60 * 1000,
  ACCOUNT_SETUP: 72 * 60 * 60 * 1000,
};

/** Single-use, expiring tokens for email links. Only hashes are stored. */
@Injectable()
export class AuthTokenService {
  constructor(private readonly prisma: PrismaService) {}

  /** Issues a new token and invalidates older unused tokens with the same purpose. */
  async issue(
    userId: string,
    purpose: AuthTokenPurpose,
    tx: Prisma.TransactionClient = this.prisma.client,
  ): Promise<string> {
    const token = generateOpaqueToken();
    await tx.authToken.deleteMany({ where: { userId, purpose, usedAt: null } });
    await tx.authToken.create({
      data: {
        userId,
        purpose,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS[purpose]),
      },
    });
    return token;
  }

  /**
   * Atomically marks a valid token as used and returns it. Returns null if the token
   * is unknown, expired, already used or issued for another purpose.
   */
  async consume(
    token: string,
    purposes: AuthTokenPurpose[],
    tx: Prisma.TransactionClient,
  ): Promise<AuthToken | null> {
    const tokenHash = hashToken(token);
    const now = new Date();
    const { count } = await tx.authToken.updateMany({
      where: { tokenHash, purpose: { in: purposes }, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (count !== 1) return null;
    return tx.authToken.findUnique({ where: { tokenHash } });
  }
}
