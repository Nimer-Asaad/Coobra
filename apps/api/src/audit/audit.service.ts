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
  | 'USER_PROFILE_UPDATED'
  | 'USER_DEACTIVATED'
  | 'USER_REACTIVATED'
  | 'USER_ROLE_CHANGED'
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
  | 'PICKUP_ZONE_CHANGE_REQUESTED'
  | 'PICKUP_ZONE_REQUEST_WITHDRAWN'
  | 'PICKUP_ZONE_CHANGE_APPROVED'
  | 'PICKUP_ZONE_CHANGE_REJECTED'
  | 'SHIPMENT_FEE_OVERRIDDEN'
  | 'FINANCE_SETTING_CHANGED'
  | 'COD_COLLECTED'
  | 'SHORTFALL_PROPOSED'
  | 'SHORTFALL_APPROVED'
  | 'SHORTFALL_REJECTED'
  | 'SHORTFALL_MERCHANT_ACCEPTED'
  | 'SHORTFALL_MERCHANT_DECLINED'
  | 'FEE_CORRECTION_REQUESTED'
  | 'FEE_CORRECTION_APPROVED'
  | 'FEE_CORRECTION_REJECTED'
  | 'ADJUSTMENT_REQUESTED'
  | 'ADJUSTMENT_APPROVED'
  | 'ADJUSTMENT_REJECTED'
  | 'SETTLEMENT_SUBMITTED'
  | 'SETTLEMENT_CONFIRMED'
  | 'SETTLEMENT_REJECTED'
  | 'DRIVER_SHORTAGE_PROPOSED'
  | 'DRIVER_SHORTAGE_APPROVED'
  | 'DRIVER_SHORTAGE_REJECTED'
  | 'DRIVER_REPAYMENT_RECORDED'
  | 'PAYOUT_CREATED'
  | 'PAYOUT_APPROVED'
  | 'PAYOUT_PAID'
  | 'PAYOUT_CANCELLED'
  | 'MERCHANT_PAYMENT_RECORDED'
  | 'TREASURY_TRANSFER'
  | 'RETURN_APPROVED'
  | 'RETURN_FEE_SET'
  | 'RETURN_FEE_WAIVED'
  | 'RETURN_CLOSED';

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
