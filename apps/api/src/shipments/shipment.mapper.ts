import type { Prisma } from '@coobra/database';
import type {
  Currency,
  ShipmentDetails,
  ShipmentListItem,
  ShipmentPerson,
  ZoneLabel,
} from '@coobra/shared';

type Labels = Map<string, ZoneLabel>;

const personSelect = { id: true, fullName: true, phone: true } as const;

export const shipmentListInclude = {
  merchant: { select: { ...personSelect, merchantProfile: { select: { businessName: true } } } },
  driver: { select: personSelect },
} as const satisfies Prisma.ShipmentInclude;

export const shipmentDetailsInclude = {
  ...shipmentListInclude,
  createdBy: { select: { id: true, fullName: true, role: true } },
  history: {
    orderBy: { createdAt: 'asc' },
    include: {
      actor: { select: { id: true, fullName: true, role: true } },
      driver: { select: personSelect },
    },
  },
  codCollections: {
    orderBy: { recordedAt: 'desc' },
    include: { driver: { select: personSelect } },
  },
  shortfall: { select: { id: true, status: true, resolution: true } },
  pricing: true,
  feeOverrides: {
    orderBy: { createdAt: 'asc' },
    include: {
      actor: { select: { id: true, fullName: true, role: true } },
      approvedBy: { select: { id: true, fullName: true } },
    },
  },
} as const satisfies Prisma.ShipmentInclude;

type ShipmentForList = Prisma.ShipmentGetPayload<{ include: typeof shipmentListInclude }>;
type ShipmentForDetails = Prisma.ShipmentGetPayload<{ include: typeof shipmentDetailsInclude }>;

const money = (value: Prisma.Decimal) => value.toFixed(2);
const iso = (value: Date | null) => (value ? value.toISOString() : null);
const person = (value: ShipmentPerson | null): ShipmentPerson | null =>
  value ? { id: value.id, fullName: value.fullName, phone: value.phone } : null;

export function toShipmentListItem(shipment: ShipmentForList, labels: Labels): ShipmentListItem {
  return {
    id: shipment.id,
    trackingNumber: shipment.trackingNumber,
    status: shipment.status,
    recipientName: shipment.recipientName,
    recipientPhone: shipment.recipientPhone,
    governorate: shipment.governorate,
    city: shipment.city,
    destination: shipment.destinationZoneId
      ? (labels.get(shipment.destinationZoneId) ?? null)
      : null,
    codAmount: money(shipment.codAmount),
    deliveryFee: shipment.deliveryFee ? money(shipment.deliveryFee) : null,
    currency: shipment.currency as Currency,
    merchant: {
      id: shipment.merchant.id,
      fullName: shipment.merchant.fullName,
      phone: shipment.merchant.phone,
      businessName: shipment.merchant.merchantProfile?.businessName ?? shipment.merchant.fullName,
    },
    driver: person(shipment.driver),
    codStatus: shipment.codStatus,
    createdAt: shipment.createdAt.toISOString(),
    updatedAt: shipment.updatedAt.toISOString(),
  };
}

export function toShipmentDetails(shipment: ShipmentForDetails, labels: Labels): ShipmentDetails {
  const cod = shipment.codCollections[0];
  const label = (id: string | null | undefined) => (id ? (labels.get(id) ?? null) : null);
  const pricing = shipment.pricing;
  return {
    ...toShipmentListItem(shipment, labels),
    origin: label(shipment.originZoneId),
    codInfo: {
      status: shipment.codStatus,
      expected: money(shipment.codAmount),
      collected: money(shipment.codCollectedAmount),
      outstanding: money(shipment.codAmount.minus(shipment.codCollectedAmount)),
      collections: shipment.codCollections
        .filter((collection) => collection.collectedAmount.greaterThan(0))
        .map((collection) => ({
          id: collection.id,
          amount: money(collection.collectedAmount),
          clearedAmount: money(collection.clearedAmount),
          driver: { id: collection.driver.id, fullName: collection.driver.fullName },
          note: collection.note,
          recordedAt: collection.recordedAt.toISOString(),
        })),
      shortfall: shipment.shortfall,
    },
    pricing: pricing
      ? {
          source: pricing.source,
          ruleId: pricing.ruleId,
          ruleVersion: pricing.ruleVersion,
          origin: label(pricing.originZoneId),
          destination: label(pricing.destinationZoneId),
          baseFee: pricing.baseFee ? money(pricing.baseFee) : null,
          finalFee: money(pricing.finalFee),
          returnFee: pricing.returnFee ? money(pricing.returnFee) : null,
          pricedAt: pricing.pricedAt.toISOString(),
          overrides: shipment.feeOverrides.map((override) => ({
            id: override.id,
            phase: override.phase,
            status: override.status,
            previousFee: override.previousFee ? money(override.previousFee) : null,
            newFee: money(override.newFee),
            reason: override.reason,
            actor: override.actor,
            approvedBy: override.approvedBy,
            createdAt: override.createdAt.toISOString(),
          })),
        }
      : null,
    recipientPhoneAlt: shipment.recipientPhoneAlt,
    addressLine: shipment.addressLine,
    landmark: shipment.landmark,
    recipientNotes: shipment.recipientNotes,
    merchantNotes: shipment.merchantNotes,
    createdBy: shipment.createdBy,
    creatorRole: shipment.creatorRole,
    failureReason: shipment.failureReason,
    cancellationReason: shipment.cancellationReason,
    returnReason: shipment.returnReason,
    deliveryAttempts: shipment.deliveryAttempts,
    assignedAt: iso(shipment.assignedAt),
    pickedUpAt: iso(shipment.pickedUpAt),
    deliveredAt: iso(shipment.deliveredAt),
    cod: cod
      ? {
          collected: cod.collected,
          expectedAmount: money(cod.expectedAmount),
          collectedAmount: money(cod.collectedAmount),
          currency: cod.currency as Currency,
          recordedAt: cod.recordedAt.toISOString(),
          driver: person(cod.driver),
        }
      : null,
    history: shipment.history.map((entry) => ({
      id: entry.id,
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      note: entry.note,
      actor: entry.actor,
      driver: person(entry.driver),
      createdAt: entry.createdAt.toISOString(),
    })),
    version: shipment.version,
  };
}
