import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, type User } from '@coobra/database';
import {
  ASSIGNABLE_STATUSES,
  DRIVER_ACTIVE_STATUSES,
  findShipmentTransition,
  normalizePhone,
  SHIPMENT_STATUSES,
  shipmentActorForRole,
  type AdminCreateShipmentInput,
  type CreateShipmentInput,
  type DriverOption,
  type ListShipmentsQuery,
  type MerchantOption,
  type Paginated,
  type ShipmentDetails,
  type ShipmentListItem,
  type ShipmentStatus,
  type ShipmentSummary,
  type TransitionShipmentInput,
} from '@coobra/shared';
import { AuditService } from '../audit/audit.service.js';
import { isUniqueViolation } from '../auth/auth.service.js';
import { Errors } from '../common/app-exception.js';
import type { RequestMeta } from '../common/request.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  shipmentDetailsInclude,
  shipmentListInclude,
  toShipmentDetails,
  toShipmentListItem,
} from './shipment.mapper.js';

type Tx = Prisma.TransactionClient;
type Actor = Pick<User, 'id' | 'role'>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACKING_NUMBER_ATTEMPTS = 5;
const PEOPLE_LIMIT = 20;

/** CB- followed by 8 digits: short, unambiguous and easy to read out over the phone. */
export function generateTrackingNumber(): string {
  return `CB-${randomInt(10_000_000, 100_000_000)}`;
}

/**
 * Shipments, their lifecycle and access rules. Every query is scoped to what the actor may
 * see: merchants their own shipments, drivers the shipments assigned to them, staff all.
 * Other users' shipments are reported as "not found" so their existence is never revealed.
 */
@Injectable()
export class ShipmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private scopeFor(actor: Actor): Prisma.ShipmentWhereInput {
    if (actor.role === 'MERCHANT') return { merchantId: actor.id };
    if (actor.role === 'DRIVER') return { driverId: actor.id };
    return {};
  }

  async list(actor: Actor, query: ListShipmentsQuery): Promise<Paginated<ShipmentListItem>> {
    const filters: Prisma.ShipmentWhereInput[] = [this.scopeFor(actor)];
    if (query.status) filters.push({ status: query.status });
    if (query.governorate) filters.push({ governorate: query.governorate });
    if (actor.role !== 'MERCHANT' && actor.role !== 'DRIVER') {
      if (query.merchantId) filters.push({ merchantId: query.merchantId });
      if (query.driverId) filters.push({ driverId: query.driverId });
    }
    if (query.createdFrom) filters.push({ createdAt: { gte: new Date(query.createdFrom) } });
    if (query.createdTo) filters.push({ createdAt: { lt: new Date(query.createdTo) } });
    if (query.scope === 'active') filters.push({ status: { in: [...DRIVER_ACTIVE_STATUSES] } });
    if (query.scope === 'history') {
      filters.push({ status: { notIn: [...DRIVER_ACTIVE_STATUSES] } });
    }
    if (query.q) filters.push({ OR: this.searchConditions(query.q) });

    const where: Prisma.ShipmentWhereInput = { AND: filters };
    const [total, rows] = await this.prisma.client.$transaction([
      this.prisma.client.shipment.count({ where }),
      this.prisma.client.shipment.findMany({
        where,
        include: shipmentListInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: rows.map(toShipmentListItem),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  private searchConditions(q: string): Prisma.ShipmentWhereInput[] {
    const conditions: Prisma.ShipmentWhereInput[] = [
      { trackingNumber: { contains: q.toUpperCase(), mode: 'insensitive' } },
      { recipientName: { contains: q, mode: 'insensitive' } },
    ];
    const phone = normalizePhone(q).replace(/^\+/, '');
    if (/^\d{3,}$/.test(phone)) conditions.push({ recipientPhone: { contains: phone } });
    return conditions;
  }

  async summary(): Promise<ShipmentSummary> {
    const groups = await this.prisma.client.shipment.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const counts = Object.fromEntries(SHIPMENT_STATUSES.map((status) => [status, 0])) as Record<
      ShipmentStatus,
      number
    >;
    let total = 0;
    for (const group of groups) {
      counts[group.status] = group._count._all;
      total += group._count._all;
    }
    return { counts, total };
  }

  async get(actor: Actor, id: string): Promise<ShipmentDetails> {
    return toShipmentDetails(await this.findScoped(this.prisma.client, actor, id));
  }

  private async findScoped(db: Tx, actor: Actor, id: string) {
    if (!UUID_PATTERN.test(id)) throw Errors.notFound();
    const shipment = await db.shipment.findFirst({
      where: { AND: [{ id }, this.scopeFor(actor)] },
      include: shipmentDetailsInclude,
    });
    if (!shipment) throw Errors.notFound();
    return shipment;
  }

  /** A merchant creates a shipment for their own account. */
  createForMerchant(merchant: Actor, input: CreateShipmentInput, meta: RequestMeta) {
    return this.create(merchant, merchant.id, { ...input, deliveryFee: undefined }, meta);
  }

  /** Staff create a shipment on behalf of an existing, active merchant (recorded as staff). */
  async createForMerchantByStaff(staff: Actor, input: AdminCreateShipmentInput, meta: RequestMeta) {
    const merchant = await this.prisma.client.user.findFirst({
      where: { id: input.merchantId, role: 'MERCHANT', status: 'ACTIVE' },
      select: { id: true },
    });
    if (!merchant) throw Errors.shipmentMerchantInvalid();
    const { merchantId, ...fields } = input;
    return this.create(staff, merchantId, fields, meta);
  }

  private async create(
    creator: Actor,
    merchantId: string,
    input: CreateShipmentInput & { deliveryFee?: string },
    meta: RequestMeta,
  ): Promise<ShipmentDetails> {
    for (let attempt = 1; ; attempt++) {
      try {
        const shipment = await this.prisma.client.$transaction(async (tx) => {
          const created = await tx.shipment.create({
            data: {
              trackingNumber: generateTrackingNumber(),
              merchantId,
              createdById: creator.id,
              creatorRole: creator.role,
              recipientName: input.recipientName,
              recipientPhone: input.recipientPhone,
              recipientPhoneAlt: input.recipientPhoneAlt ?? null,
              governorate: input.governorate,
              city: input.city,
              addressLine: input.addressLine,
              landmark: input.landmark ?? null,
              recipientNotes: input.recipientNotes ?? null,
              merchantNotes: input.merchantNotes ?? null,
              codAmount: input.codAmount,
              deliveryFee: input.deliveryFee ?? null,
            },
          });
          await tx.shipmentStatusHistory.create({
            data: {
              shipmentId: created.id,
              fromStatus: null,
              toStatus: 'CREATED',
              actorUserId: creator.id,
              actorRole: creator.role,
            },
          });
          return this.findScoped(tx, creator, created.id);
        });
        await this.audit.record({
          action: 'SHIPMENT_CREATED',
          actorUserId: creator.id,
          targetUserId: merchantId,
          meta,
          metadata: {
            shipmentId: shipment.id,
            trackingNumber: shipment.trackingNumber,
            onBehalfOfMerchant: creator.id !== merchantId,
          },
        });
        return toShipmentDetails(shipment);
      } catch (error) {
        // Tracking number collision: retry with a new random number.
        if (isUniqueViolation(error) && attempt < TRACKING_NUMBER_ATTEMPTS) continue;
        throw error;
      }
    }
  }

  /** Assigns or reassigns a driver. Atomic and protected against concurrent changes. */
  async assign(
    staff: Actor,
    id: string,
    driverId: string,
    note: string | undefined,
    meta: RequestMeta,
  ): Promise<ShipmentDetails> {
    const driver = await this.prisma.client.user.findFirst({
      where: { id: driverId, role: 'DRIVER', status: 'ACTIVE' },
      select: { id: true },
    });
    if (!driver) throw Errors.shipmentDriverInvalid();

    const { shipment, changed, previousDriverId, fromStatus } =
      await this.prisma.client.$transaction(async (tx) => {
        const current = await this.findScoped(tx, staff, id);
        if (!(ASSIGNABLE_STATUSES as readonly ShipmentStatus[]).includes(current.status)) {
          throw Errors.shipmentInvalidTransition();
        }
        const unchanged = {
          shipment: current,
          changed: false,
          previousDriverId: current.driverId,
          fromStatus: current.status,
        };
        // Assigning the same driver again is a no-op.
        if (current.status === 'ASSIGNED' && current.driverId === driverId) return unchanged;

        await this.applyUpdate(tx, current, {
          status: 'ASSIGNED',
          driverId,
          assignedAt: new Date(),
        });
        await tx.shipmentStatusHistory.create({
          data: {
            shipmentId: id,
            fromStatus: current.status,
            toStatus: 'ASSIGNED',
            actorUserId: staff.id,
            actorRole: staff.role,
            driverId,
            note: note ?? null,
          },
        });
        return { ...unchanged, shipment: await this.findScoped(tx, staff, id), changed: true };
      });

    if (changed) {
      await this.audit.record({
        action: 'SHIPMENT_ASSIGNED',
        actorUserId: staff.id,
        targetUserId: driverId,
        meta,
        metadata: {
          shipmentId: id,
          trackingNumber: shipment.trackingNumber,
          previousDriverId,
          fromStatus,
        },
      });
    }
    return toShipmentDetails(shipment);
  }

  /**
   * Moves a shipment through its lifecycle. Validates the transition table, the actor's role
   * and ownership, mandatory reasons and the COD confirmation, then updates the shipment,
   * appends history and records COD in one transaction guarded by the version column.
   */
  async transition(
    actor: Actor,
    id: string,
    input: TransitionShipmentInput,
    meta: RequestMeta,
  ): Promise<ShipmentDetails> {
    const role = shipmentActorForRole(actor.role);
    if (!role) throw Errors.forbidden();

    const { shipment, fromStatus } = await this.prisma.client.$transaction(async (tx) => {
      const current = await this.findScoped(tx, actor, id);
      const rule = findShipmentTransition(current.status, input.toStatus);
      if (!rule) throw Errors.shipmentInvalidTransition();
      if (!rule.actors.includes(role)) throw Errors.forbidden();
      if (rule.requiresReason && !input.reason) {
        throw Errors.validation({ reason: 'validation.reason.required' });
      }

      const now = new Date();
      const data: Prisma.ShipmentUncheckedUpdateManyInput = { status: input.toStatus };
      switch (input.toStatus) {
        case 'PICKED_UP':
          data.pickedUpAt = now;
          break;
        case 'OUT_FOR_DELIVERY':
          data.deliveryAttempts = { increment: 1 };
          break;
        case 'DELIVERED':
          data.deliveredAt = now;
          data.deliveredById = actor.id;
          break;
        case 'DELIVERY_FAILED':
          data.failureReason = input.reason ?? null;
          break;
        case 'RETURN_REQUESTED':
          data.returnReason = input.reason ?? null;
          break;
        case 'CANCELLED':
          data.cancellationReason = input.reason ?? null;
          break;
        default:
          break;
      }

      let cod: { collected: boolean; amount: string } | null = null;
      if (rule.requiresCodConfirmation) {
        if (!input.cod) throw Errors.validation({ cod: 'validation.cod.confirmRequired' });
        const expected = current.codAmount;
        const collected = new Prisma.Decimal(input.cod.amount);
        const matches = expected.isZero()
          ? !input.cod.collected && collected.isZero()
          : input.cod.collected && collected.equals(expected);
        if (!matches) throw Errors.shipmentCodMismatch();
        cod = input.cod;
      }

      await this.applyUpdate(tx, current, data);
      await tx.shipmentStatusHistory.create({
        data: {
          shipmentId: id,
          fromStatus: current.status,
          toStatus: input.toStatus,
          actorUserId: actor.id,
          actorRole: actor.role,
          note: input.reason ?? null,
        },
      });
      if (cod) {
        await tx.codCollection.create({
          data: {
            shipmentId: id,
            driverId: actor.id,
            collected: cod.collected,
            expectedAmount: current.codAmount,
            collectedAmount: cod.amount,
            currency: current.currency,
            recordedAt: now,
          },
        });
      }
      return { shipment: await this.findScoped(tx, actor, id), fromStatus: current.status };
    });

    await this.audit.record({
      action: input.toStatus === 'CANCELLED' ? 'SHIPMENT_CANCELLED' : 'SHIPMENT_STATUS_CHANGED',
      actorUserId: actor.id,
      targetUserId: shipment.merchantId,
      meta,
      metadata: {
        shipmentId: id,
        trackingNumber: shipment.trackingNumber,
        fromStatus,
        toStatus: input.toStatus,
      },
    });
    return toShipmentDetails(shipment);
  }

  /**
   * Optimistic concurrency: the update only applies if nobody changed the shipment since it
   * was read (same version and status). Concurrent writers get SHIPMENT_CONCURRENT_UPDATE.
   */
  private async applyUpdate(
    tx: Tx,
    current: { id: string; version: number; status: ShipmentStatus },
    data: Prisma.ShipmentUncheckedUpdateManyInput,
  ): Promise<void> {
    const result = await tx.shipment.updateMany({
      where: { id: current.id, version: current.version, status: current.status },
      data: { ...data, version: { increment: 1 } },
    });
    if (result.count !== 1) throw Errors.shipmentConcurrentUpdate();
  }

  async merchants(q: string | undefined): Promise<MerchantOption[]> {
    const rows = await this.prisma.client.user.findMany({
      where: {
        role: 'MERCHANT',
        status: 'ACTIVE',
        ...(q
          ? {
              OR: [
                { fullName: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
                { phone: { contains: normalizePhone(q) } },
                { merchantProfile: { businessName: { contains: q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: { merchantProfile: { select: { businessName: true } } },
      orderBy: { fullName: 'asc' },
      take: PEOPLE_LIMIT,
    });
    return rows.map((user) => ({
      id: user.id,
      fullName: user.fullName,
      businessName: user.merchantProfile?.businessName ?? user.fullName,
      phone: user.phone,
      email: user.email,
    }));
  }

  async drivers(q: string | undefined): Promise<DriverOption[]> {
    const rows = await this.prisma.client.user.findMany({
      where: {
        role: 'DRIVER',
        status: 'ACTIVE',
        ...(q
          ? {
              OR: [
                { fullName: { contains: q, mode: 'insensitive' } },
                { phone: { contains: normalizePhone(q) } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        fullName: true,
        phone: true,
        _count: {
          select: { driverShipments: { where: { status: { in: [...DRIVER_ACTIVE_STATUSES] } } } },
        },
      },
      orderBy: { fullName: 'asc' },
      take: PEOPLE_LIMIT,
    });
    return rows.map((user) => ({
      id: user.id,
      fullName: user.fullName,
      phone: user.phone,
      activeShipments: user._count.driverShipments,
    }));
  }
}
