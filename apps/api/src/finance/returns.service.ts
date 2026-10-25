import { Injectable } from '@nestjs/common';
import { Prisma, type ReturnRecord, type Shipment } from '@coobra/database';
import type {
  ReturnListItem,
  SetReturnFeeInput,
  ShipmentReturnInfo,
  UserRole,
  WaiveReturnFeeInput,
} from '@coobra/shared';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/app-exception.js';
import type { RequestMeta } from '../common/request.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { accounts, credit, debit, LedgerService } from './ledger.service.js';

type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: UserRole };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (value: Prisma.Decimal) => value.toFixed(2);

export const returnInclude = {
  requestedBy: { select: { id: true, fullName: true } },
  approvedBy: { select: { id: true, fullName: true } },
  returnDriver: { select: { id: true, fullName: true, phone: true } },
} as const satisfies Prisma.ReturnRecordInclude;

export function toReturnInfo(
  row: Prisma.ReturnRecordGetPayload<{ include: typeof returnInclude }>,
): ShipmentReturnInfo {
  return {
    id: row.id,
    requestedAt: row.requestedAt.toISOString(),
    requestedBy: row.requestedBy,
    requestReason: row.requestReason,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy,
    returnDriver: row.returnDriver,
    feeStatus: row.feeStatus,
    feeAmount: row.feeAmount ? money(row.feeAmount) : null,
    feeReason: row.feeReason,
    completedAt: row.completedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

/**
 * Return records and return fees. The fee comes from the shipment's pricing snapshot; without
 * one it is RETURN_FEE_UNCONFIGURED until a finance user sets it or waives it with a reason.
 * It is posted once, when the shipment is RETURNED and the fee is set. Nothing is refunded or
 * reversed automatically.
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  /** Creates the record (once) with the fee from the pricing snapshot, if any. */
  async ensureRecord(
    tx: Tx,
    shipment: Pick<Shipment, 'id'>,
    requested?: { actorId: string; reason: string | null },
  ): Promise<ReturnRecord> {
    const existing = await tx.returnRecord.findUnique({ where: { shipmentId: shipment.id } });
    if (existing) return existing;
    const pricing = await tx.shipmentPricing.findUnique({ where: { shipmentId: shipment.id } });
    const configured = pricing?.returnFee ?? null;
    return tx.returnRecord.create({
      data: {
        shipmentId: shipment.id,
        requestedById: requested?.actorId ?? null,
        requestReason: requested?.reason ?? null,
        feeStatus: configured ? 'SET' : 'RETURN_FEE_UNCONFIGURED',
        feeAmount: configured,
        feeReason: configured ? 'Return fee from the pricing rule' : null,
      },
    });
  }

  onRequested(tx: Tx, shipment: Shipment, actor: Actor, reason: string | null) {
    return this.ensureRecord(tx, shipment, { actorId: actor.id, reason });
  }

  async onApproved(
    tx: Tx,
    shipment: Shipment,
    actor: Actor,
    returnDriverId: string | null,
  ): Promise<void> {
    const record = await this.ensureRecord(tx, shipment);
    await tx.returnRecord.update({
      where: { id: record.id },
      data: {
        approvedById: actor.id,
        approvedAt: new Date(),
        returnDriverId,
        originalDriverId: record.originalDriverId ?? shipment.driverId,
      },
    });
  }

  /** The parcel is back with the merchant: post the fee if it is decided, then close. */
  async onReturned(tx: Tx, shipment: Shipment, actor: Actor, now: Date): Promise<void> {
    const record = await this.ensureRecord(tx, shipment);
    await tx.returnRecord.update({ where: { id: record.id }, data: { completedAt: now } });
    await this.settleFee(tx, { ...shipment, status: 'RETURNED' }, record.id, actor.id);
  }

  /** Posts a decided fee once the shipment is RETURNED; closes the record when nothing is left. */
  private async settleFee(
    tx: Tx,
    shipment: Pick<Shipment, 'id' | 'status' | 'merchantId' | 'trackingNumber'>,
    recordId: string,
    actorId: string,
  ) {
    const record = await tx.returnRecord.findUniqueOrThrow({ where: { id: recordId } });
    if (shipment.status !== 'RETURNED' || record.closedAt) return;
    if (record.feeStatus === 'WAIVED') {
      await tx.returnRecord.update({ where: { id: recordId }, data: { closedAt: new Date() } });
      return;
    }
    if (record.feeStatus !== 'SET' || !record.feeAmount) return;
    let journalEntryId: string | null = null;
    if (record.feeAmount.greaterThan(0)) {
      const entry = await this.ledger.post(tx, {
        kind: 'RETURN_FEE',
        sourceType: 'return_record',
        sourceId: recordId,
        createdById: actorId,
        description: `Return fee ${shipment.trackingNumber}`,
        lines: [
          debit(accounts.merchantBalance(shipment.merchantId), record.feeAmount, shipment.id),
          credit(accounts.returnFeeRevenue(), record.feeAmount, shipment.id),
        ],
      });
      journalEntryId = entry.id;
    }
    await tx.returnRecord.update({
      where: { id: recordId },
      data: { feeStatus: 'POSTED', journalEntryId, closedAt: new Date() },
    });
  }

  private async lockRecord(tx: Tx, shipmentId: string) {
    if (!UUID_PATTERN.test(shipmentId)) throw Errors.notFound();
    const shipment = await tx.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw Errors.notFound();
    const record = await tx.returnRecord.findUnique({ where: { shipmentId } });
    if (!record) throw Errors.invalidState('No return was requested for this shipment');
    await tx.$queryRaw`SELECT id FROM return_records WHERE id = ${record.id}::uuid FOR UPDATE`;
    const locked = await tx.returnRecord.findUniqueOrThrow({ where: { id: record.id } });
    if (locked.feeStatus === 'POSTED' || locked.closedAt) {
      throw Errors.invalidState('The return fee is already posted; use a financial adjustment');
    }
    return { shipment, record: locked };
  }

  async setFee(actor: Actor, shipmentId: string, input: SetReturnFeeInput, meta: RequestMeta) {
    await this.prisma.client.$transaction(async (tx) => {
      const { shipment, record } = await this.lockRecord(tx, shipmentId);
      await tx.returnRecord.update({
        where: { id: record.id },
        data: {
          feeStatus: 'SET',
          feeAmount: input.amount,
          feeReason: input.reason,
          feeSetById: actor.id,
          feeSetAt: new Date(),
        },
      });
      await this.settleFee(tx, shipment, record.id, actor.id);
    });
    await this.audit.record({
      action: 'RETURN_FEE_SET',
      actorUserId: actor.id,
      meta,
      metadata: { shipmentId, amount: input.amount, reason: input.reason },
    });
    return this.get(shipmentId);
  }

  async waive(actor: Actor, shipmentId: string, input: WaiveReturnFeeInput, meta: RequestMeta) {
    await this.prisma.client.$transaction(async (tx) => {
      const { shipment, record } = await this.lockRecord(tx, shipmentId);
      await tx.returnRecord.update({
        where: { id: record.id },
        data: {
          feeStatus: 'WAIVED',
          feeAmount: 0,
          feeReason: input.reason,
          feeSetById: actor.id,
          feeSetAt: new Date(),
        },
      });
      await this.settleFee(tx, shipment, record.id, actor.id);
    });
    await this.audit.record({
      action: 'RETURN_FEE_WAIVED',
      actorUserId: actor.id,
      meta,
      metadata: { shipmentId, reason: input.reason },
    });
    return this.get(shipmentId);
  }

  async get(shipmentId: string): Promise<ShipmentReturnInfo> {
    const row = await this.prisma.client.returnRecord.findUnique({
      where: { shipmentId },
      include: returnInclude,
    });
    if (!row) throw Errors.notFound();
    return toReturnInfo(row);
  }

  async list(filter: {
    open?: boolean;
    feeStatus?: ReturnListItem['feeStatus'];
  }): Promise<ReturnListItem[]> {
    const rows = await this.prisma.client.returnRecord.findMany({
      where: {
        ...(filter.open ? { closedAt: null } : {}),
        ...(filter.feeStatus ? { feeStatus: filter.feeStatus } : {}),
      },
      include: {
        ...returnInclude,
        shipment: {
          select: {
            id: true,
            trackingNumber: true,
            status: true,
            recipientName: true,
            merchant: {
              select: {
                id: true,
                fullName: true,
                merchantProfile: { select: { businessName: true } },
              },
            },
          },
        },
      },
      orderBy: { requestedAt: 'desc' },
      take: 200,
    });
    return rows.map((row) => ({
      ...toReturnInfo(row),
      shipment: {
        id: row.shipment.id,
        trackingNumber: row.shipment.trackingNumber,
        status: row.shipment.status,
        recipientName: row.shipment.recipientName,
      },
      merchant: {
        id: row.shipment.merchant.id,
        businessName:
          row.shipment.merchant.merchantProfile?.businessName ?? row.shipment.merchant.fullName,
      },
    }));
  }
}
