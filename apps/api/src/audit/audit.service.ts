import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@coobra/database';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RequestMeta } from '../common/request.js';

export type AuditAction =
  | 'AUTH_REGISTERED'
  | 'AUTH_LOGIN_SUCCEEDED'
  | 'AUTH_LOGIN_FAILED'
  | 'AUTH_LOGOUT'
  | 'AUTH_PASSWORD_RESET_REQUESTED'
  | 'AUTH_PASSWORD_RESET_COMPLETED'
  | 'AUTH_EMAIL_VERIFIED'
  | 'USER_CREATED'
  | 'USER_PREFERENCES_UPDATED'
  | 'SHIPMENT_CREATED'
  | 'SHIPMENT_ASSIGNED'
  | 'SHIPMENT_STATUS_CHANGED'
  | 'SHIPMENT_CANCELLED'
  | 'ZONE_KIND_CREATED'
  | 'ZONE_KIND_UPDATED'
  | 'ZONE_CREATED'
  | 'ZONE_UPDATED'
  | 'PRICING_RULE_CREATED'
  | 'PRICING_RULE_REVISED'
  | 'PRICING_RULE_DEACTIVATED'
  | 'MERCHANT_PICKUP_ZONE_SET'
  | 'SHIPMENT_FEE_OVERRIDDEN';

export interface AuditEntry {
  action: AuditAction;
  /** The real human who performed the action (never an impersonated identity). */
  actorUserId?: string | null;
  targetUserId?: string | null;
  meta?: RequestMeta;
  metadata?: Prisma.InputJsonObject;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Writes an audit entry. Failures are logged but never break the user's request. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.client.auditLog.create({
        data: {
          action: entry.action,
          actorUserId: entry.actorUserId ?? null,
          targetUserId: entry.targetUserId ?? null,
          ipAddress: entry.meta?.ipAddress ?? null,
          userAgent: entry.meta?.userAgent ?? null,
          metadata: entry.metadata,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to write audit log ${entry.action}`, error as Error);
    }
  }
}
