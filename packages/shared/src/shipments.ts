import { z } from 'zod';
import type { UserRole } from './roles.js';

/*
 * Shipment contracts shared by the API and every client: statuses, the lifecycle
 * transition table, input normalisation (phones, money, Arabic-Indic digits) and schemas.
 */

export const SHIPMENT_STATUSES = [
  'CREATED',
  'ASSIGNED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'DELIVERY_FAILED',
  'RETURN_REQUESTED',
  'RETURNED',
  'CANCELLED',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** Final states: no further changes except through a future, explicitly authorised workflow. */
export const TERMINAL_SHIPMENT_STATUSES = [
  'DELIVERED',
  'RETURNED',
  'CANCELLED',
] as const satisfies readonly ShipmentStatus[];

export function isTerminalShipmentStatus(status: ShipmentStatus): boolean {
  return (TERMINAL_SHIPMENT_STATUSES as readonly ShipmentStatus[]).includes(status);
}

/** Statuses a driver is still working on (shown in the driver's active list). */
export const DRIVER_ACTIVE_STATUSES = [
  'ASSIGNED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'DELIVERY_FAILED',
] as const satisfies readonly ShipmentStatus[];

export const CURRENCIES = ['ILS'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Palestinian governorates (West Bank and Gaza) plus deliveries inside the 1948 areas. */
export const GOVERNORATES = [
  'JERUSALEM',
  'RAMALLAH_ALBIREH',
  'NABLUS',
  'HEBRON',
  'BETHLEHEM',
  'JENIN',
  'TULKARM',
  'QALQILYA',
  'SALFIT',
  'JERICHO',
  'TUBAS',
  'NORTH_GAZA',
  'GAZA',
  'DEIR_AL_BALAH',
  'KHAN_YUNIS',
  'RAFAH',
  'INSIDE_48',
] as const;
export type Governorate = (typeof GOVERNORATES)[number];

/** Roles that may create and operate shipments from the admin console. */
export const SHIPMENT_MANAGER_ROLES = [
  'SUPER_ADMIN',
  'OPERATIONS',
] as const satisfies readonly UserRole[];

/** Staff roles with read-only shipment visibility. */
export const SHIPMENT_VIEWER_ROLES = [
  'SUPER_ADMIN',
  'OPERATIONS',
  'OWNER_VIEWER',
  'ACCOUNTANT',
] as const satisfies readonly UserRole[];

export function canManageShipments(role: UserRole): boolean {
  return (SHIPMENT_MANAGER_ROLES as readonly UserRole[]).includes(role);
}

/** Who may perform a transition. Drivers may only act on shipments assigned to them. */
export type ShipmentActor = 'MERCHANT' | 'DRIVER' | 'STAFF';

export interface ShipmentTransitionRule {
  from: ShipmentStatus;
  to: ShipmentStatus;
  actors: readonly ShipmentActor[];
  /** A reason/note is mandatory (failed deliveries, returns, cancellations). */
  requiresReason?: boolean;
  /** Requires the cash-on-delivery confirmation payload. */
  requiresCodConfirmation?: boolean;
}

/**
 * The shipment lifecycle. Assignment (CREATED/DELIVERY_FAILED -> ASSIGNED and reassignment)
 * goes through the dedicated assign operation, which also sets the driver.
 */
export const SHIPMENT_TRANSITIONS: readonly ShipmentTransitionRule[] = [
  { from: 'ASSIGNED', to: 'PICKED_UP', actors: ['DRIVER'] },
  { from: 'PICKED_UP', to: 'OUT_FOR_DELIVERY', actors: ['DRIVER'] },
  {
    from: 'OUT_FOR_DELIVERY',
    to: 'DELIVERED',
    actors: ['DRIVER'],
    requiresCodConfirmation: true,
  },
  { from: 'OUT_FOR_DELIVERY', to: 'DELIVERY_FAILED', actors: ['DRIVER'], requiresReason: true },
  // Re-attempt by the same driver (e.g. the recipient answered later the same day).
  { from: 'DELIVERY_FAILED', to: 'OUT_FOR_DELIVERY', actors: ['DRIVER'] },
  {
    from: 'DELIVERY_FAILED',
    to: 'RETURN_REQUESTED',
    actors: ['MERCHANT', 'STAFF'],
    requiresReason: true,
  },
  { from: 'PICKED_UP', to: 'RETURN_REQUESTED', actors: ['STAFF'], requiresReason: true },
  { from: 'RETURN_REQUESTED', to: 'RETURNED', actors: ['STAFF'] },
  { from: 'CREATED', to: 'CANCELLED', actors: ['MERCHANT', 'STAFF'], requiresReason: true },
  { from: 'ASSIGNED', to: 'CANCELLED', actors: ['STAFF'], requiresReason: true },
];

/** Statuses from which staff may (re)assign a driver. */
export const ASSIGNABLE_STATUSES = [
  'CREATED',
  'ASSIGNED',
  'DELIVERY_FAILED',
] as const satisfies readonly ShipmentStatus[];

export function findShipmentTransition(
  from: ShipmentStatus,
  to: ShipmentStatus,
): ShipmentTransitionRule | undefined {
  return SHIPMENT_TRANSITIONS.find((rule) => rule.from === from && rule.to === to);
}

/** Transitions the given actor may perform from a status (used to render action buttons). */
export function availableShipmentTransitions(
  from: ShipmentStatus,
  actor: ShipmentActor,
): ShipmentTransitionRule[] {
  return SHIPMENT_TRANSITIONS.filter((rule) => rule.from === from && rule.actors.includes(actor));
}

export function shipmentActorForRole(role: UserRole): ShipmentActor | null {
  if (role === 'MERCHANT') return 'MERCHANT';
  if (role === 'DRIVER') return 'DRIVER';
  return canManageShipments(role) ? 'STAFF' : null;
}

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

/** Converts Arabic-Indic (٠-٩) and Persian (۰-۹) digits to ASCII digits. */
export function toAsciiDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    const base =
      code >= EXTENDED_ARABIC_INDIC_ZERO ? EXTENDED_ARABIC_INDIC_ZERO : ARABIC_INDIC_ZERO;
    return String(code - base);
  });
}

/**
 * Normalises a phone number typed by a person: Arabic digits, spaces, dashes, dots and
 * parentheses are accepted; a leading `00` becomes `+`.
 */
export function normalizePhone(value: string): string {
  const compact = toAsciiDigits(value).replace(/[\s\-().‎‏]/g, '');
  return compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
}

/**
 * Accepts local Palestinian/Israeli numbers (059…, 056…, 052…, 02…, 09… — 9 or 10 digits
 * starting with 0) and any international number in E.164 form (+970…, +972…, +962…).
 */
export function isValidPhone(normalized: string): boolean {
  return /^0\d{8,9}$/.test(normalized) || /^\+[1-9]\d{7,14}$/.test(normalized);
}

export const MAX_COD_AMOUNT = 100_000;
export const MAX_DELIVERY_FEE = 10_000;

/** Normalises a money amount to a plain decimal string with at most two fraction digits. */
export function normalizeMoney(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    value = String(value);
  }
  if (typeof value !== 'string') return null;
  const text = toAsciiDigits(value).trim().replace('٫', '.').replace(/,/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  return `${String(Number(whole))}.${fraction.padEnd(2, '0')}`;
}

function parseMoney(value: unknown, max: number, ctx: z.RefinementCtx): string {
  const amount = normalizeMoney(value);
  if (amount === null) {
    ctx.addIssue({
      code: 'custom',
      message:
        value === undefined || value === '' ? 'validation.required' : 'validation.money.invalid',
    });
    return z.NEVER;
  }
  if (Number(amount) > max) {
    ctx.addIssue({ code: 'custom', message: 'validation.money.tooLarge' });
    return z.NEVER;
  }
  return amount;
}

/** A required amount (string or number in, normalised decimal string out). */
function moneySchema(max: number) {
  return z.unknown().transform((value, ctx) => parseMoney(value, max, ctx));
}

/** An optional amount: blank values become undefined. */
function optionalMoneySchema(max: number) {
  return z
    .unknown()
    .transform((value, ctx) =>
      value === null || value === '' ? undefined : parseMoney(value, max, ctx),
    )
    .optional();
}

export const shipmentPhoneSchema = z
  .string({ error: 'validation.required' })
  .transform(normalizePhone)
  .pipe(
    z
      .string()
      .min(1, { error: 'validation.required' })
      .refine(isValidPhone, { error: 'validation.phone.invalid' }),
  );

function text(max: number) {
  return z
    .string({ error: 'validation.required' })
    .trim()
    .min(1, { error: 'validation.required' })
    .max(max, { error: 'validation.text.tooLong' });
}

/** Optional free text: blank strings become undefined. */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, { error: 'validation.text.tooLong' })
    .optional()
    .transform((value) => (value ? value : undefined));
}

const optionalPhone = z
  .string()
  .optional()
  .transform((value) => (value?.trim() ? value : undefined))
  .pipe(shipmentPhoneSchema.optional());

export const reasonSchema = z
  .string({ error: 'validation.reason.required' })
  .trim()
  .min(3, { error: 'validation.reason.required' })
  .max(500, { error: 'validation.text.tooLong' });

/** Fields a merchant fills in. Merchants never set the delivery fee or the owner. */
export const createShipmentSchema = z.object({
  recipientName: z
    .string({ error: 'validation.required' })
    .trim()
    .min(2, { error: 'validation.name.tooShort' })
    .max(120, { error: 'validation.name.tooLong' }),
  recipientPhone: shipmentPhoneSchema,
  recipientPhoneAlt: optionalPhone,
  governorate: z.enum(GOVERNORATES, { error: 'validation.governorate.invalid' }),
  city: text(80),
  addressLine: text(300),
  landmark: optionalText(200),
  recipientNotes: optionalText(500),
  merchantNotes: optionalText(500),
  codAmount: moneySchema(MAX_COD_AMOUNT),
});
export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;

/** Staff create shipments on behalf of an existing merchant and may set the delivery fee. */
export const adminCreateShipmentSchema = createShipmentSchema.extend({
  merchantId: z.uuid({ error: 'validation.merchant.required' }),
  deliveryFee: optionalMoneySchema(MAX_DELIVERY_FEE),
});
export type AdminCreateShipmentInput = z.infer<typeof adminCreateShipmentSchema>;

export const assignDriverSchema = z.object({
  driverId: z.uuid({ error: 'validation.driver.required' }),
  note: optionalText(500),
});
export type AssignDriverInput = z.infer<typeof assignDriverSchema>;

/**
 * Cash-on-delivery confirmation, required to mark a shipment delivered. Nothing is assumed:
 * the driver states explicitly whether cash was collected and how much.
 */
export const codConfirmationSchema = z.object({
  collected: z.boolean({ error: 'validation.cod.confirmRequired' }),
  amount: moneySchema(MAX_COD_AMOUNT),
  confirmed: z.literal(true, { error: 'validation.cod.confirmRequired' }),
});
export type CodConfirmationInput = z.infer<typeof codConfirmationSchema>;

export const transitionShipmentSchema = z.object({
  toStatus: z.enum(SHIPMENT_STATUSES, { error: 'validation.status.invalid' }),
  reason: optionalText(500),
  cod: codConfirmationSchema.optional(),
});
export type TransitionShipmentInput = z.infer<typeof transitionShipmentSchema>;
/** What a client sends (optional fields may be omitted). */
export type TransitionShipmentRequest = z.input<typeof transitionShipmentSchema>;

export const SHIPMENT_PAGE_SIZE_MAX = 100;

const optionalQueryString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

/** Query string for shipment lists (all values arrive as strings). */
export const listShipmentsQuerySchema = z.object({
  q: optionalQueryString.pipe(z.string().max(100).optional()),
  status: z.enum(SHIPMENT_STATUSES, { error: 'validation.status.invalid' }).optional(),
  merchantId: z.uuid().optional(),
  driverId: z.uuid().optional(),
  governorate: z.enum(GOVERNORATES, { error: 'validation.governorate.invalid' }).optional(),
  createdFrom: z.iso.datetime({ offset: true }).optional(),
  createdTo: z.iso.datetime({ offset: true }).optional(),
  /** Driver lists: work in progress or finished history. */
  scope: z.enum(['active', 'history']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(SHIPMENT_PAGE_SIZE_MAX).default(20),
});
export type ListShipmentsQuery = z.infer<typeof listShipmentsQuerySchema>;

export const listPeopleQuerySchema = z.object({
  q: optionalQueryString.pipe(z.string().max(100).optional()),
});
