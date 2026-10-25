import type { Prisma } from '@coobra/database';
import type {
  Currency,
  Governorate,
  ShipmentDetails,
  ShipmentListItem,
  ShipmentPerson,
} from '@coobra/shared';

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
    take: 1,
    include: { driver: { select: personSelect } },
  },
} as const satisfies Prisma.ShipmentInclude;

type ShipmentForList = Prisma.ShipmentGetPayload<{ include: typeof shipmentListInclude }>;
type ShipmentForDetails = Prisma.ShipmentGetPayload<{ include: typeof shipmentDetailsInclude }>;

const money = (value: Prisma.Decimal) => value.toFixed(2);
const iso = (value: Date | null) => (value ? value.toISOString() : null);
const person = (value: ShipmentPerson | null): ShipmentPerson | null =>
  value ? { id: value.id, fullName: value.fullName, phone: value.phone } : null;

export function toShipmentListItem(shipment: ShipmentForList): ShipmentListItem {
  return {
    id: shipment.id,
    trackingNumber: shipment.trackingNumber,
    status: shipment.status,
    recipientName: shipment.recipientName,
    recipientPhone: shipment.recipientPhone,
    governorate: shipment.governorate as Governorate,
    city: shipment.city,
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
    createdAt: shipment.createdAt.toISOString(),
    updatedAt: shipment.updatedAt.toISOString(),
  };
}

export function toShipmentDetails(shipment: ShipmentForDetails): ShipmentDetails {
  const cod = shipment.codCollections[0];
  return {
    ...toShipmentListItem(shipment),
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
