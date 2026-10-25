import { Injectable } from '@nestjs/common';
import { Prisma } from '@coobra/database';
import {
  FINANCE_ROLES,
  type FinanceSettingItem,
  type UpdateFinanceSettingInput,
  type UserRole,
} from '@coobra/shared';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/app-exception.js';
import type { RequestMeta } from '../common/request.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: UserRole };

const DEFAULT_THRESHOLD = '200.00';

/**
 * Separation of duties for financial decisions: the approver is never the proposer, and above
 * the configurable threshold only a SUPER_ADMIN may approve.
 */
@Injectable()
export class ApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async threshold(db: Tx): Promise<Prisma.Decimal> {
    const setting = await db.financeSetting.findUnique({ where: { key: 'APPROVAL_THRESHOLD' } });
    return new Prisma.Decimal(setting?.value ?? DEFAULT_THRESHOLD);
  }

  async assertCanApprove(
    db: Tx,
    approver: Actor,
    proposerId: string,
    amount: Prisma.Decimal,
  ): Promise<void> {
    if (!(FINANCE_ROLES as readonly UserRole[]).includes(approver.role)) throw Errors.forbidden();
    if (approver.id === proposerId) throw Errors.selfApprovalForbidden();
    if (amount.greaterThan(await this.threshold(db)) && approver.role !== 'SUPER_ADMIN') {
      throw Errors.approvalLimitExceeded();
    }
  }

  async settings(): Promise<FinanceSettingItem[]> {
    const db = this.prisma.client;
    const setting = await db.financeSetting.findUnique({ where: { key: 'APPROVAL_THRESHOLD' } });
    const history = await db.financeSettingChange.findMany({
      where: { key: 'APPROVAL_THRESHOLD' },
      include: { changedBy: { select: { id: true, fullName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const updatedBy = setting?.updatedById
      ? await db.user.findUnique({
          where: { id: setting.updatedById },
          select: { id: true, fullName: true },
        })
      : null;
    return [
      {
        key: 'APPROVAL_THRESHOLD',
        value: new Prisma.Decimal(setting?.value ?? DEFAULT_THRESHOLD).toFixed(2),
        updatedAt: (setting?.updatedAt ?? new Date(0)).toISOString(),
        updatedBy,
        history: history.map((change) => ({
          oldValue: change.oldValue,
          newValue: change.newValue,
          reason: change.reason,
          changedBy: change.changedBy,
          createdAt: change.createdAt.toISOString(),
        })),
      },
    ];
  }

  /** SUPER_ADMIN only (enforced by the route); every change is kept with its reason. */
  async updateThreshold(actor: Actor, input: UpdateFinanceSettingInput, meta: RequestMeta) {
    const old = await this.prisma.client.$transaction(async (tx) => {
      const current = await tx.financeSetting.findUnique({ where: { key: 'APPROVAL_THRESHOLD' } });
      await tx.financeSetting.upsert({
        where: { key: 'APPROVAL_THRESHOLD' },
        update: { value: input.value, updatedById: actor.id, updatedAt: new Date() },
        create: { key: 'APPROVAL_THRESHOLD', value: input.value, updatedById: actor.id },
      });
      await tx.financeSettingChange.create({
        data: {
          key: 'APPROVAL_THRESHOLD',
          oldValue: current?.value ?? null,
          newValue: input.value,
          reason: input.reason,
          changedById: actor.id,
        },
      });
      return current?.value ?? null;
    });
    await this.audit.record({
      action: 'FINANCE_SETTING_CHANGED',
      actorUserId: actor.id,
      meta,
      metadata: {
        key: 'APPROVAL_THRESHOLD',
        oldValue: old,
        newValue: input.value,
        reason: input.reason,
      },
    });
  }
}
