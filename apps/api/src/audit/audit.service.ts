import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@coobra/database';
import type { AuditAction } from '@coobra/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RequestMeta } from '../common/request.js';
import { currentActingContext } from '../common/acting-context.js';
import { redactForLog } from '../common/log-redaction.js';

/** The action list lives in @coobra/shared so the audit log viewer can label and filter it. */
export type { AuditAction };

export interface AuditEntry {
  action: AuditAction;
  /** The real human who performed the action (never an impersonated identity). */
  actorUserId?: string | null;
  targetUserId?: string | null;
  meta?: RequestMeta;
  metadata?: Prisma.InputJsonObject;
  /** When it happened, if the caller compares it with its own clock (rate limits); else now. */
  at?: Date;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Writes an audit entry. Failures are logged but never break the user's request. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.recordIn(this.prisma.client, entry);
    } catch (error) {
      this.logger.error(`Failed to write audit log ${entry.action}: ${redactForLog(error)}`);
    }
  }

  /**
   * Writes an audit entry inside the caller's transaction: the change and its audit entry
   * commit together, and a failed write rolls the change back.
   */
  async recordIn(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    // During an impersonation every entry also names the account and the impersonation
    // (ADR 0003 §11.1); the database checks they belong to that impersonation's actor.
    const impersonation = currentActingContext()?.impersonation ?? null;
    const principal = currentActingContext()?.principal ?? null;
    await tx.auditLog.create({
      data: {
        action: entry.action,
        actorUserId: entry.actorUserId ?? null,
        // Only set while impersonating: ordinary entries are written exactly as before.
        ...(impersonation && principal
          ? { effectiveUserId: principal.id, impersonationId: impersonation.id }
          : {}),
        targetUserId: entry.targetUserId ?? null,
        ipAddress: entry.meta?.ipAddress ?? null,
        userAgent: entry.meta?.userAgent ?? null,
        metadata: entry.metadata,
        ...(entry.at ? { createdAt: entry.at } : {}),
      },
    });
  }
}
