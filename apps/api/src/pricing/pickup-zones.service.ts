import { Injectable } from '@nestjs/common';
import type { Prisma } from '@coobra/database';
import type { MerchantPickupZoneState, PickupZoneRequestItem, UserRole } from '@coobra/shared';
import { AuditService } from '../audit/audit.service.js';
import { Errors } from '../common/app-exception.js';
import type { RequestMeta } from '../common/request.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ZonesService } from './zones.service.js';

type Actor = { id: string; role: UserRole };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requestInclude = {
  merchant: {
    select: { id: true, fullName: true, merchantProfile: { select: { businessName: true } } },
  },
  decidedBy: { select: { id: true, fullName: true } },
} as const satisfies Prisma.PickupZoneRequestInclude;

type RequestRow = Prisma.PickupZoneRequestGetPayload<{ include: typeof requestInclude }>;

/**
 * Merchant pickup-zone changes. Every merchant price is calculated from the approved zone on the
 * merchant profile, so a merchant may only request a change; it takes effect when staff approve
 * it. Staff can also set the zone directly (PricingService.setPickupZone).
 */
@Injectable()
export class PickupZonesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly zones: ZonesService,
    private readonly audit: AuditService,
  ) {}

  private toItem(row: RequestRow): PickupZoneRequestItem {
    return {
      id: row.id,
      merchant: {
        id: row.merchant.id,
        businessName: row.merchant.merchantProfile?.businessName ?? row.merchant.fullName,
      },
      requestedZoneId: row.requestedZoneId,
      previousZoneId: row.previousZoneId,
      status: row.status,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionNote: row.decisionNote,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async stateFor(merchantId: string): Promise<MerchantPickupZoneState> {
    const db = this.prisma.client;
    const [profile, pending, lastDecision] = await Promise.all([
      db.merchantProfile.findUnique({ where: { userId: merchantId } }),
      db.pickupZoneRequest.findFirst({
        where: { merchantId, status: 'PENDING' },
        include: requestInclude,
      }),
      db.pickupZoneRequest.findFirst({
        where: { merchantId, status: { in: ['APPROVED', 'REJECTED'] } },
        include: requestInclude,
        orderBy: { decidedAt: 'desc' },
      }),
    ]);
    return {
      approvedZoneId: profile?.defaultPickupZoneId ?? null,
      pending: pending ? this.toItem(pending) : null,
      lastDecision: lastDecision ? this.toItem(lastDecision) : null,
    };
  }

  /**
   * Asks for a new pickup zone. Replaces an earlier pending request; choosing the approved zone
   * again just withdraws it. The approved zone keeps pricing shipments until staff decide.
   */
  async request(merchant: Actor, zoneId: string, meta: RequestMeta) {
    const outcome = await this.prisma.client.$transaction(async (tx) => {
      // Serialises a merchant's requests (the partial unique index backs this up).
      const locked = await tx.$queryRaw<{ default_pickup_zone_id: string | null }[]>`
        SELECT default_pickup_zone_id FROM merchant_profiles
        WHERE user_id = ${merchant.id}::uuid FOR UPDATE`;
      const profile = locked[0];
      if (!profile) throw Errors.shipmentMerchantInvalid();
      await this.zones.activePath(tx, zoneId);
      const withdrawn = await tx.pickupZoneRequest.updateMany({
        where: { merchantId: merchant.id, status: 'PENDING' },
        data: { status: 'WITHDRAWN', decidedAt: new Date() },
      });
      if (zoneId === profile.default_pickup_zone_id) {
        if (withdrawn.count === 0) throw Errors.validation({ zoneId: 'validation.zone.unchanged' });
        return { requestId: null, withdrawn: withdrawn.count };
      }
      const created = await tx.pickupZoneRequest.create({
        data: {
          merchantId: merchant.id,
          requestedZoneId: zoneId,
          previousZoneId: profile.default_pickup_zone_id,
        },
      });
      return { requestId: created.id, withdrawn: withdrawn.count };
    });
    await this.audit.record({
      action: outcome.requestId ? 'PICKUP_ZONE_CHANGE_REQUESTED' : 'PICKUP_ZONE_REQUEST_WITHDRAWN',
      actorUserId: merchant.id,
      targetUserId: merchant.id,
      meta,
      metadata: { zoneId, ...outcome },
    });
    return this.stateFor(merchant.id);
  }

  async withdraw(merchant: Actor, meta: RequestMeta) {
    const withdrawn = await this.prisma.client.pickupZoneRequest.updateMany({
      where: { merchantId: merchant.id, status: 'PENDING' },
      data: { status: 'WITHDRAWN', decidedAt: new Date() },
    });
    if (withdrawn.count === 0) throw Errors.invalidState('There is no pending pickup zone request');
    await this.audit.record({
      action: 'PICKUP_ZONE_REQUEST_WITHDRAWN',
      actorUserId: merchant.id,
      targetUserId: merchant.id,
      meta,
    });
    return this.stateFor(merchant.id);
  }

  async pending(): Promise<PickupZoneRequestItem[]> {
    const rows = await this.prisma.client.pickupZoneRequest.findMany({
      where: { status: 'PENDING' },
      include: requestInclude,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toItem(row));
  }

  /** Staff decision. Approval makes the requested zone the merchant's approved pickup zone. */
  async decide(
    staff: Actor,
    id: string,
    approve: boolean,
    note: string | undefined,
    meta: RequestMeta,
  ): Promise<PickupZoneRequestItem> {
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    const row = await this.prisma.client.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM pickup_zone_requests WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw Errors.notFound();
      const request = await tx.pickupZoneRequest.findUniqueOrThrow({ where: { id } });
      if (request.status !== 'PENDING') {
        throw Errors.invalidState('This pickup zone request is not waiting for a decision');
      }
      if (approve) {
        // The zone may have been deactivated since the merchant asked.
        await this.zones.activePath(tx, request.requestedZoneId);
        await tx.merchantProfile.update({
          where: { userId: request.merchantId },
          data: { defaultPickupZoneId: request.requestedZoneId },
        });
      }
      return tx.pickupZoneRequest.update({
        where: { id },
        data: {
          status: approve ? 'APPROVED' : 'REJECTED',
          decidedById: staff.id,
          decidedAt: new Date(),
          decisionNote: note ?? null,
        },
        include: requestInclude,
      });
    });
    await this.audit.record({
      action: approve ? 'PICKUP_ZONE_CHANGE_APPROVED' : 'PICKUP_ZONE_CHANGE_REJECTED',
      actorUserId: staff.id,
      targetUserId: row.merchantId,
      meta,
      metadata: {
        requestId: id,
        previousZoneId: row.previousZoneId,
        requestedZoneId: row.requestedZoneId,
        note: note ?? null,
      },
    });
    return this.toItem(row);
  }
}
