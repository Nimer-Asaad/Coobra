import { z } from 'zod';
import { reasonTextSchema } from './pricing.js';
import { PASSWORD_MAX_LENGTH } from './validation.js';
import type { ShipmentStatus } from './shipments.js';

/*
 * Phase 4C SUPER_ADMIN impersonation contracts (ADR 0003).
 *
 * Phase 4C.1 defines the contracts and the classification of every API route; nothing here
 * starts an impersonation. The API enforces the classification from Phase 4C.3: during an
 * impersonation a route that is not listed is denied, and a test fails the build when a route
 * exists without a classification (or a classification names a route that does not exist).
 */

/** Only these accounts can be impersonated, each in its own app. */
export const IMPERSONATION_TARGET_ROLES = ['MERCHANT', 'DRIVER'] as const;
export type ImpersonationTargetRole = (typeof IMPERSONATION_TARGET_ROLES)[number];

export const IMPERSONATION_MAX_DURATION_MINUTES = 30;
/** A password re-entry allows one impersonation start within this window. */
export const IMPERSONATION_STEP_UP_WINDOW_MINUTES = 5;
export const IMPERSONATION_EXCHANGE_CODE_TTL_SECONDS = 60;

/** Sent by the app tab on every request while it is impersonating (forces a CORS preflight). */
export const IMPERSONATION_HEADER = 'x-coobra-impersonation';
/** httpOnly cookie on the API host, separate from the normal `coobra_session` cookie. */
export const IMPERSONATION_COOKIE_NAME = 'coobra_imp_session';
/** Used instead when cookies are `Secure` (HTTPS): host-only, `Path=/`, no `Domain`. */
export const IMPERSONATION_SECURE_COOKIE_NAME = '__Host-coobra_imp_session';

/** `postMessage` types of the hand-off between the admin console and the app tab. */
export const IMPERSONATION_MESSAGE_READY = 'coobra:impersonation:ready';
export const IMPERSONATION_MESSAGE_CODE = 'coobra:impersonation:code';

export const IMPERSONATION_END_REASONS = [
  'MANUAL',
  'EXPIRED',
  'ACTOR_LOGOUT',
  'ACTOR_SESSION_ENDED',
  'ACTOR_REVOKED',
  'TARGET_REVOKED',
] as const;
export type ImpersonationEndReason = (typeof IMPERSONATION_END_REASONS)[number];

// ---------------------------------------------------------------------------------------------
// Route classification
// ---------------------------------------------------------------------------------------------

/**
 * - PUBLIC: no session; the impersonation cookie is ignored.
 * - ALLOWED: permitted (reads, or no financial effect).
 * - SAFEGUARDED: permitted with ADR 0003 §10 controls (reason, confirmation, both identities).
 * - FORBIDDEN: `403 IMPERSONATION_FORBIDDEN_ACTION`.
 */
export const IMPERSONATION_ACCESS = ['PUBLIC', 'ALLOWED', 'SAFEGUARDED', 'FORBIDDEN'] as const;
export type ImpersonationAccess = (typeof IMPERSONATION_ACCESS)[number];

/** Why a route has its classification (ADR 0003 decisions and sections). */
export const IMPERSONATION_BASES = [
  'PUBLIC_ROUTE',
  'READ_ONLY',
  'ENDS_IMPERSONATION',
  'OPERATIONAL',
  'PER_TRANSITION',
  'STAFF_ONLY',
  'CREDENTIALS',
  'TARGET_SETTINGS',
  'PRICING_CONFIGURATION',
  'FINANCIAL_CONSENT',
  'CASH_CUSTODY',
  'LEDGER_POSTING',
] as const;
export type ImpersonationBasis = (typeof IMPERSONATION_BASES)[number];

export interface ImpersonationRoutePolicy {
  access: ImpersonationAccess;
  basis: ImpersonationBasis;
  /** For forbidden actions with an audited admin route that support uses instead. */
  adminAlternative?: string;
}

/** `METHOD /path`, exactly as the API registers it (global prefix included). */
export type RouteKey = `${'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} /${string}`;

const publicRoute: ImpersonationRoutePolicy = { access: 'PUBLIC', basis: 'PUBLIC_ROUTE' };
const read: ImpersonationRoutePolicy = { access: 'ALLOWED', basis: 'READ_ONLY' };
const staffOnly: ImpersonationRoutePolicy = { access: 'FORBIDDEN', basis: 'STAFF_ONLY' };
const forbidden = (
  basis: ImpersonationBasis,
  adminAlternative?: RouteKey,
): ImpersonationRoutePolicy => ({
  access: 'FORBIDDEN',
  basis,
  ...(adminAlternative ? { adminAlternative } : {}),
});

/**
 * Every API route, classified for requests made during an impersonation (ADR 0003 §4). The
 * target is always a MERCHANT or DRIVER, so staff routes are also refused by their roles; the
 * explicit FORBIDDEN entry is a second, independent barrier.
 */
export const IMPERSONATION_ROUTE_POLICY = {
  // --- Health -------------------------------------------------------------------------------
  'GET /health': publicRoute,
  'GET /health/ready': publicRoute,

  // --- Authentication and the signed-in user --------------------------------------------------
  'POST /v1/auth/register': publicRoute,
  'POST /v1/auth/login': publicRoute,
  'POST /v1/auth/forgot-password': publicRoute,
  'POST /v1/auth/reset-password': publicRoute,
  'POST /v1/auth/verify-email': publicRoute,
  'GET /v1/auth/me': read,
  /** Ends the impersonation only; the target's own sessions are never touched. */
  'POST /v1/auth/logout': { access: 'ALLOWED', basis: 'ENDS_IMPERSONATION' },
  'POST /v1/auth/resend-verification': forbidden('CREDENTIALS'),
  /** D13: the app changes the language locally only. */
  'PATCH /v1/me/preferences': forbidden('TARGET_SETTINGS'),
  'GET /v1/zones': read,

  // --- Impersonation lifecycle (Phase 4C.3) -----------------------------------------------
  /** The opened app tab redeems its single-use code (code + verifier, exact app origin). */
  'POST /v1/auth/impersonation/exchange': publicRoute,
  /** The banner's End button. */
  'POST /v1/impersonation/end': { access: 'ALLOWED', basis: 'ENDS_IMPERSONATION' },
  /** Step-up and the admin console's controls are SUPER_ADMIN routes: never during impersonation. */
  'POST /v1/auth/reauthenticate': staffOnly,
  'POST /v1/admin/impersonations': staffOnly,
  'GET /v1/admin/impersonations': staffOnly,
  'GET /v1/admin/impersonations/:id': staffOnly,
  'POST /v1/admin/impersonations/:id/end': staffOnly,

  // --- Merchant app -----------------------------------------------------------------------------
  'GET /v1/merchant/shipments': read,
  'GET /v1/merchant/shipments/:id': read,
  /** C1: delivery fee, return terms and COD amount are confirmed (R2). */
  'POST /v1/merchant/shipments': { access: 'SAFEGUARDED', basis: 'OPERATIONAL' },
  /** Classified per transition by IMPERSONATION_TRANSITION_POLICY. */
  'POST /v1/merchant/shipments/:id/transitions': {
    access: 'SAFEGUARDED',
    basis: 'PER_TRANSITION',
  },
  /**
   * Persists a single-use, short-lived quote that only this merchant's own shipment creation can
   * use. It posts nothing; the quote records the real actor and the impersonation.
   */
  'POST /v1/merchant/pricing/quote': { access: 'SAFEGUARDED', basis: 'OPERATIONAL' },
  'GET /v1/merchant/pickup-zone': read,
  'PUT /v1/merchant/pickup-zone': forbidden(
    'PRICING_CONFIGURATION',
    'PUT /v1/admin/merchants/:id/pickup-zone',
  ),
  'DELETE /v1/merchant/pickup-zone/request': forbidden(
    'PRICING_CONFIGURATION',
    'PUT /v1/admin/merchants/:id/pickup-zone',
  ),
  'GET /v1/merchant/finance': read,
  'GET /v1/merchant/finance/shortfalls': read,
  'POST /v1/merchant/finance/payouts': forbidden('FINANCIAL_CONSENT'),
  'POST /v1/merchant/finance/payouts/:id/cancel': forbidden(
    'FINANCIAL_CONSENT',
    'POST /v1/admin/finance/payouts/:id/cancel',
  ),
  'POST /v1/merchant/finance/shortfalls/:id/accept': forbidden('FINANCIAL_CONSENT'),
  'POST /v1/merchant/finance/shortfalls/:id/decline': forbidden('FINANCIAL_CONSENT'),

  // --- Driver app -------------------------------------------------------------------------------
  'GET /v1/driver/shipments': read,
  'GET /v1/driver/shipments/:id': read,
  /** Classified per transition by IMPERSONATION_TRANSITION_POLICY. */
  'POST /v1/driver/shipments/:id/transitions': {
    access: 'SAFEGUARDED',
    basis: 'PER_TRANSITION',
  },
  'POST /v1/driver/shipments/:id/collections': forbidden('CASH_CUSTODY'),
  'GET /v1/driver/finance': read,
  'POST /v1/driver/finance/settlements': forbidden(
    'CASH_CUSTODY',
    'POST /v1/admin/finance/settlements',
  ),

  // --- Staff only: users and audit ----------------------------------------------------------
  'GET /v1/admin/users': staffOnly,
  'POST /v1/admin/users': staffOnly,
  'GET /v1/admin/users/:id': staffOnly,
  'PATCH /v1/admin/users/:id': staffOnly,
  'POST /v1/admin/users/:id/deactivate': staffOnly,
  'POST /v1/admin/users/:id/reactivate': staffOnly,
  'POST /v1/admin/users/:id/role': staffOnly,
  'GET /v1/admin/audit-logs': staffOnly,
  'GET /v1/admin/audit-logs/:id': staffOnly,

  // --- Staff only: finance ------------------------------------------------------------------
  'GET /v1/admin/finance/settings': staffOnly,
  'PUT /v1/admin/finance/settings/approval-threshold': staffOnly,
  'GET /v1/admin/finance/shortfalls': staffOnly,
  'POST /v1/admin/finance/shortfalls/:id/propose': staffOnly,
  'POST /v1/admin/finance/shortfalls/:id/approve': staffOnly,
  'POST /v1/admin/finance/shortfalls/:id/reject': staffOnly,
  'GET /v1/admin/finance/fee-corrections': staffOnly,
  'POST /v1/admin/finance/shipments/:id/fee-correction': staffOnly,
  'POST /v1/admin/finance/fee-corrections/:id/approve': staffOnly,
  'POST /v1/admin/finance/fee-corrections/:id/reject': staffOnly,
  'GET /v1/admin/finance/adjustments': staffOnly,
  'POST /v1/admin/finance/adjustments': staffOnly,
  'POST /v1/admin/finance/adjustments/:id/approve': staffOnly,
  'POST /v1/admin/finance/adjustments/:id/reject': staffOnly,
  'GET /v1/admin/finance/merchants': staffOnly,
  'GET /v1/admin/finance/payouts': staffOnly,
  'POST /v1/admin/finance/payouts': staffOnly,
  'POST /v1/admin/finance/payouts/:id/approve': staffOnly,
  'POST /v1/admin/finance/payouts/:id/pay': staffOnly,
  'POST /v1/admin/finance/payouts/:id/cancel': staffOnly,
  'POST /v1/admin/finance/merchant-payments': staffOnly,
  'POST /v1/admin/finance/treasury-transfers': staffOnly,
  'GET /v1/admin/finance/overview': staffOnly,
  'GET /v1/admin/finance/journal': staffOnly,
  'GET /v1/admin/finance/reports/:name': staffOnly,
  'GET /v1/admin/finance/drivers': staffOnly,
  'GET /v1/admin/finance/settlements': staffOnly,
  'POST /v1/admin/finance/settlements': staffOnly,
  'POST /v1/admin/finance/settlements/:id/confirm': staffOnly,
  'POST /v1/admin/finance/settlements/:id/reject': staffOnly,
  'GET /v1/admin/finance/driver-shortages': staffOnly,
  'POST /v1/admin/finance/driver-shortages': staffOnly,
  'POST /v1/admin/finance/driver-shortages/:id/approve': staffOnly,
  'POST /v1/admin/finance/driver-shortages/:id/reject': staffOnly,
  'POST /v1/admin/finance/driver-repayments': staffOnly,
  'GET /v1/admin/returns': staffOnly,
  'POST /v1/admin/returns/:shipmentId/fee': staffOnly,
  'POST /v1/admin/returns/:shipmentId/waive': staffOnly,

  // --- Staff only: zones and pricing --------------------------------------------------------
  'GET /v1/admin/zone-kinds': staffOnly,
  'POST /v1/admin/zone-kinds': staffOnly,
  'PATCH /v1/admin/zone-kinds/:id': staffOnly,
  'GET /v1/admin/zones': staffOnly,
  'POST /v1/admin/zones': staffOnly,
  'PATCH /v1/admin/zones/:id': staffOnly,
  'GET /v1/admin/pricing-rules': staffOnly,
  'POST /v1/admin/pricing-rules': staffOnly,
  'POST /v1/admin/pricing-rules/:id/revise': staffOnly,
  'POST /v1/admin/pricing-rules/:id/deactivate': staffOnly,
  'POST /v1/admin/pricing/quote': staffOnly,
  'PUT /v1/admin/merchants/:id/pickup-zone': staffOnly,
  'GET /v1/admin/pickup-zone-requests': staffOnly,
  'POST /v1/admin/pickup-zone-requests/:id/approve': staffOnly,
  'POST /v1/admin/pickup-zone-requests/:id/reject': staffOnly,
  'POST /v1/admin/shipments/:id/fee-override': staffOnly,

  // --- Staff only: shipments ----------------------------------------------------------------
  'GET /v1/admin/shipments': staffOnly,
  'GET /v1/admin/shipments/summary': staffOnly,
  'GET /v1/admin/shipments/:id': staffOnly,
  'POST /v1/admin/shipments': staffOnly,
  'POST /v1/admin/shipments/:id/assign': staffOnly,
  'POST /v1/admin/shipments/:id/return/approve': staffOnly,
  'POST /v1/admin/shipments/:id/transitions': staffOnly,
  'GET /v1/admin/merchants': staffOnly,
  'GET /v1/admin/drivers': staffOnly,
} as const satisfies Record<RouteKey, ImpersonationRoutePolicy>;

export type ClassifiedRoute = keyof typeof IMPERSONATION_ROUTE_POLICY;

/** Fails closed: a route without a classification is forbidden during an impersonation. */
export function impersonationRoutePolicy(route: string): ImpersonationRoutePolicy {
  return (
    (IMPERSONATION_ROUTE_POLICY as Record<string, ImpersonationRoutePolicy>)[route] ?? {
      access: 'FORBIDDEN',
      basis: 'STAFF_ONLY',
    }
  );
}

// ---------------------------------------------------------------------------------------------
// Shipment transitions (one route, classified per transition)
// ---------------------------------------------------------------------------------------------

/** Financial consequences an action can lead to later (ADR 0003 §10). */
export const CONSEQUENCE_KINDS = [
  'DELIVERY_FEE',
  'COD_TO_COLLECT',
  'RETURN_FEE',
  'RETURN_DELIVERY_CHARGE',
] as const;
export type ConsequenceKind = (typeof CONSEQUENCE_KINDS)[number];

export interface ImpersonationTransitionPolicy {
  access: 'SAFEGUARDED' | 'FORBIDDEN';
  basis: ImpersonationBasis;
  /** R3: a reason is required for every impersonated driver transition (and where the rule already requires one). */
  requiresReason: boolean;
  /** R2: the consequences the server-generated confirmation must cover (empty = no confirmation). */
  consequences: readonly ConsequenceKind[];
}

type TransitionKey = `${ImpersonationTargetRole}:${ShipmentStatus}->${ShipmentStatus}`;

const returnCharges = ['RETURN_FEE', 'RETURN_DELIVERY_CHARGE'] as const;

/**
 * Every transition a MERCHANT or DRIVER may perform (SHIPMENT_TRANSITIONS), classified for an
 * impersonation. A test checks this table against SHIPMENT_TRANSITIONS in both directions.
 */
export const IMPERSONATION_TRANSITION_POLICY = {
  // C2: no fee is charged for a cancellation; the reason is already required by the rule.
  'MERCHANT:CREATED->CANCELLED': {
    access: 'SAFEGUARDED',
    basis: 'OPERATIONAL',
    requiresReason: true,
    consequences: [],
  },
  // C3: the return fee (posted automatically on RETURNED when set) and the delivery charge.
  'MERCHANT:DELIVERY_FAILED->RETURN_REQUESTED': {
    access: 'SAFEGUARDED',
    basis: 'OPERATIONAL',
    requiresReason: true,
    consequences: returnCharges,
  },
  // C5: no charge.
  'DRIVER:ASSIGNED->PICKED_UP': {
    access: 'SAFEGUARDED',
    basis: 'OPERATIONAL',
    requiresReason: true,
    consequences: [],
  },
  'DRIVER:PICKED_UP->OUT_FOR_DELIVERY': {
    access: 'SAFEGUARDED',
    basis: 'OPERATIONAL',
    requiresReason: true,
    consequences: [],
  },
  'DRIVER:DELIVERY_FAILED->OUT_FOR_DELIVERY': {
    access: 'SAFEGUARDED',
    basis: 'OPERATIONAL',
    requiresReason: true,
    consequences: [],
  },
  // C4: the first failed attempt makes the delivery charge payable on a later return.
  'DRIVER:OUT_FOR_DELIVERY->DELIVERY_FAILED': {
    access: 'SAFEGUARDED',
    basis: 'OPERATIONAL',
    requiresReason: true,
    consequences: ['RETURN_DELIVERY_CHARGE'],
  },
  // C6: moves the return towards RETURNED, where staff closing it posts the return charges.
  'DRIVER:RETURN_APPROVED->RETURN_IN_TRANSIT': {
    access: 'SAFEGUARDED',
    basis: 'OPERATIONAL',
    requiresReason: true,
    consequences: returnCharges,
  },
  'DRIVER:RETURN_IN_TRANSIT->RETURNED_TO_HUB': {
    access: 'SAFEGUARDED',
    basis: 'OPERATIONAL',
    requiresReason: true,
    consequences: returnCharges,
  },
  // Posts COD and the delivery fee, and attests that the driver holds the cash.
  'DRIVER:OUT_FOR_DELIVERY->DELIVERED': {
    access: 'FORBIDDEN',
    basis: 'LEDGER_POSTING',
    requiresReason: false,
    consequences: [],
  },
  // `ReturnsService.onReturned` can post the return fee.
  'DRIVER:RETURN_IN_TRANSIT->RETURNED': {
    access: 'FORBIDDEN',
    basis: 'LEDGER_POSTING',
    requiresReason: false,
    consequences: [],
  },
} as const satisfies Partial<Record<TransitionKey, ImpersonationTransitionPolicy>>;

const FORBIDDEN_TRANSITION: ImpersonationTransitionPolicy = {
  access: 'FORBIDDEN',
  basis: 'STAFF_ONLY',
  requiresReason: false,
  consequences: [],
};

/** Fails closed: a transition without a classification is forbidden during an impersonation. */
export function impersonationTransitionPolicy(
  role: ImpersonationTargetRole,
  from: ShipmentStatus,
  to: ShipmentStatus,
): ImpersonationTransitionPolicy {
  const key = `${role}:${from}->${to}`;
  return (
    (IMPERSONATION_TRANSITION_POLICY as Record<string, ImpersonationTransitionPolicy>)[key] ??
    FORBIDDEN_TRANSITION
  );
}

// ---------------------------------------------------------------------------------------------
// R2: server-generated confirmation of financial consequences
// ---------------------------------------------------------------------------------------------

/**
 * - FIXED: the amount on record now. No automatic recalculation changes it, but an authorised
 *   staff decision still can before it is posted (fee override or correction, return-fee change
 *   or waiver), which is audited. The confirmation guarantees the moment of the write, not that.
 * - ESTIMATED: depends on events that have not happened yet (shown as an estimate, never as final).
 * - UNDECIDED: finance decides the amount later; no amount is shown.
 */
export const CONSEQUENCE_CERTAINTIES = ['FIXED', 'ESTIMATED', 'UNDECIDED'] as const;
export type ConsequenceCertainty = (typeof CONSEQUENCE_CERTAINTIES)[number];

/** When the amount would be posted (never during the impersonation itself). */
export const CONSEQUENCE_TRIGGERS = ['ON_DELIVERY', 'ON_RETURN_COMPLETED'] as const;
export type ConsequenceTrigger = (typeof CONSEQUENCE_TRIGGERS)[number];

export interface ConsequenceLine {
  kind: ConsequenceKind;
  /** Who would be charged or credited. */
  party: 'MERCHANT';
  /** Decimal string; null when UNDECIDED. */
  amount: string | null;
  currency: string;
  certainty: ConsequenceCertainty;
  trigger: ConsequenceTrigger;
}

/**
 * What the confirmation dialog shows. `confirmationToken` is signed by the API (HMAC) over the
 * impersonation, the actor, the action, the shipment and its version, the pricing snapshot and
 * policy, these lines and `expiresAt`. A write with a token that no longer matches the
 * recomputed preview is rejected with 409 CONSEQUENCE_CHANGED.
 */
export interface ConsequencePreview {
  lines: ConsequenceLine[];
  confirmationToken: string;
  expiresAt: string;
}

export const CONSEQUENCE_CONFIRMATION_TTL_SECONDS = 300;

export const consequenceConfirmationSchema = z.object({
  confirmationToken: z
    .string({ error: 'validation.required' })
    .min(16, { error: 'validation.token.invalid' })
    .max(4096, { error: 'validation.token.invalid' }),
});
export type ConsequenceConfirmation = z.infer<typeof consequenceConfirmationSchema>;

// ---------------------------------------------------------------------------------------------
// Request and response contracts (used from Phase 4C.3)
// ---------------------------------------------------------------------------------------------

/** base64url SHA-256 (43 characters). */
const codeChallengeSchema = z
  .string({ error: 'validation.token.invalid' })
  .regex(/^[A-Za-z0-9_-]{43}$/, { error: 'validation.token.invalid' });

export const reauthenticateSchema = z.object({
  // The same limits as signing in.
  password: z
    .string({ error: 'validation.required' })
    .min(1, { error: 'validation.required' })
    .max(PASSWORD_MAX_LENGTH, { error: 'validation.password.tooLong' }),
});
export type ReauthenticateInput = z.infer<typeof reauthenticateSchema>;

export const startImpersonationSchema = z.object({
  targetUserId: z.uuid({ error: 'validation.required' }),
  reason: reasonTextSchema,
  ticketReference: z
    .string({ error: 'validation.text.tooLong' })
    .trim()
    .max(100, { error: 'validation.text.tooLong' })
    .optional()
    .transform((value) => (value ? value : undefined)),
  codeChallenge: codeChallengeSchema,
});
export type StartImpersonationInput = z.infer<typeof startImpersonationSchema>;

export const exchangeImpersonationSchema = z.object({
  /** 32 random bytes, base64url. */
  code: z
    .string({ error: 'validation.token.invalid' })
    .regex(/^[A-Za-z0-9_-]{43}$/, { error: 'validation.token.invalid' }),
  /** The verifier whose SHA-256 is the start's `codeChallenge` (43–128 characters). */
  codeVerifier: z
    .string({ error: 'validation.token.invalid' })
    .regex(/^[A-Za-z0-9_-]{43,128}$/, { error: 'validation.token.invalid' }),
});
export type ExchangeImpersonationInput = z.infer<typeof exchangeImpersonationSchema>;

export interface ImpersonationPerson {
  id: string;
  fullName: string;
}

/** What `GET /v1/auth/me` adds during an impersonation, and what the admin console lists. */
export interface ImpersonationInfo {
  id: string;
  actor: ImpersonationPerson;
  target: ImpersonationPerson & { role: ImpersonationTargetRole };
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedReason: ImpersonationEndReason | null;
  /** Server clock, so the countdown does not depend on the client's clock. */
  serverNow: string;
}

/** `POST /v1/admin/impersonations`: the code goes to the opened tab by postMessage only. */
export interface ImpersonationStartResponse {
  impersonation: ImpersonationInfo;
  /** Single-use, valid 60 seconds; bound to the tab's verifier. Never put it in a URL. */
  code: string;
  /** The origin the code may be redeemed from (the target's app). */
  appOrigin: string;
}

export const listImpersonationsQuerySchema = z.object({
  active: z
    .enum(['true', 'false'], { error: 'validation.required' })
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});
export type ListImpersonationsQuery = z.infer<typeof listImpersonationsQuerySchema>;
