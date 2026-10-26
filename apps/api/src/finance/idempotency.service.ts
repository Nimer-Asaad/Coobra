import { createHash } from 'node:crypto';
import { createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import type { Prisma } from '@coobra/database';
import { IDEMPOTENCY_HEADER } from '@coobra/shared';
import { isUniqueViolation } from '../auth/auth.service.js';
import { Errors } from '../common/app-exception.js';
import type { AppRequest } from '../common/request.js';
import { PrismaService } from '../prisma/prisma.service.js';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

/** Injects the mandatory Idempotency-Key header of a money-moving request. */
export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const value = ctx.switchToHttp().getRequest<AppRequest>().headers[IDEMPOTENCY_HEADER];
  const key = Array.isArray(value) ? value[0] : value;
  if (!key || !KEY_PATTERN.test(key)) throw Errors.idempotencyKeyRequired();
  return key;
});

/**
 * Replay protection: the first request with a key runs; a retry with the same key and body
 * gets the stored result; the same key with a different body is rejected. Failed requests
 * release the key so the client can retry.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(
    userId: string,
    scope: string,
    key: string,
    body: unknown,
    action: () => Promise<T>,
  ): Promise<T> {
    const requestHash = createHash('sha256')
      .update(JSON.stringify(body ?? null))
      .digest('hex');
    const db = this.prisma.client;
    let recordId: string;
    try {
      recordId = (await db.idempotencyRecord.create({ data: { userId, scope, key, requestHash } }))
        .id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await db.idempotencyRecord.findUniqueOrThrow({
        where: { userId_scope_key: { userId, scope, key } },
      });
      if (existing.requestHash !== requestHash) throw Errors.idempotencyKeyReused();
      if (!existing.completedAt) throw Errors.idempotencyInProgress();
      return existing.responseBody as T;
    }

    try {
      const result = await action();
      await db.idempotencyRecord.update({
        where: { id: recordId },
        data: {
          completedAt: new Date(),
          responseStatus: 200,
          responseBody: (result ?? null) as Prisma.InputJsonValue,
        },
      });
      return result;
    } catch (error) {
      await db.idempotencyRecord.delete({ where: { id: recordId } }).catch(() => undefined);
      throw error;
    }
  }
}
