import { describe, expect, it } from 'vitest';
import {
  exchangeImpersonationSchema,
  IMPERSONATION_ROUTE_POLICY,
  IMPERSONATION_TARGET_ROLES,
  IMPERSONATION_TRANSITION_POLICY,
  impersonationRouteBlock,
  impersonationRoutePolicy,
  impersonationTransitionCapability,
  impersonationTransitionPolicy,
  startImpersonationSchema,
  type ImpersonationRoutePolicy,
  type ImpersonationTransitionPolicy,
} from './impersonation.js';
import { SHIPMENT_STATUSES, SHIPMENT_TRANSITIONS } from './shipments.js';
import { toFieldErrors } from './validation.js';

const routes = IMPERSONATION_ROUTE_POLICY as Record<string, ImpersonationRoutePolicy>;
const transitions = IMPERSONATION_TRANSITION_POLICY as Record<
  string,
  ImpersonationTransitionPolicy
>;

/** Every (role, transition) a MERCHANT or DRIVER may perform today. */
function targetTransitions(): string[] {
  return SHIPMENT_TRANSITIONS.flatMap((rule) =>
    IMPERSONATION_TARGET_ROLES.filter((role) => rule.actors.includes(role)).map(
      (role) => `${role}:${rule.from}->${rule.to}`,
    ),
  );
}

describe('impersonation transition policy', () => {
  it('classifies exactly the transitions a merchant or driver can perform', () => {
    expect(Object.keys(transitions).sort()).toEqual(targetTransitions().sort());
  });

  it('forbids every transition that posts to the ledger or attests cash custody', () => {
    expect(transitions['DRIVER:OUT_FOR_DELIVERY->DELIVERED']?.access).toBe('FORBIDDEN');
    expect(transitions['DRIVER:RETURN_IN_TRANSIT->RETURNED']?.access).toBe('FORBIDDEN');
    // No permitted transition may reach a status whose service hook posts (DELIVERED, RETURNED).
    for (const [key, policy] of Object.entries(transitions)) {
      const to = key.split('->')[1];
      if (to === 'DELIVERED' || to === 'RETURNED') expect(policy.access, key).toBe('FORBIDDEN');
    }
  });

  it('requires a reason for every permitted driver transition (R3)', () => {
    for (const [key, policy] of Object.entries(transitions)) {
      if (policy.access === 'SAFEGUARDED') expect(policy.requiresReason, key).toBe(true);
    }
  });

  it('requires a confirmation for exactly the transitions with a later charge (R2, ADR §10)', () => {
    const charges = Object.fromEntries(
      Object.entries(transitions)
        .filter(([, policy]) => policy.access === 'SAFEGUARDED')
        .map(([key, policy]) => [key, [...policy.consequences]]),
    );
    expect(charges).toEqual({
      'MERCHANT:CREATED->CANCELLED': [],
      'MERCHANT:DELIVERY_FAILED->RETURN_REQUESTED': ['RETURN_FEE', 'RETURN_DELIVERY_CHARGE'],
      'DRIVER:ASSIGNED->PICKED_UP': [],
      'DRIVER:PICKED_UP->OUT_FOR_DELIVERY': [],
      'DRIVER:DELIVERY_FAILED->OUT_FOR_DELIVERY': [],
      'DRIVER:OUT_FOR_DELIVERY->DELIVERY_FAILED': ['RETURN_DELIVERY_CHARGE'],
      'DRIVER:RETURN_APPROVED->RETURN_IN_TRANSIT': ['RETURN_FEE', 'RETURN_DELIVERY_CHARGE'],
      'DRIVER:RETURN_IN_TRANSIT->RETURNED_TO_HUB': ['RETURN_FEE', 'RETURN_DELIVERY_CHARGE'],
    });
  });

  it('fails closed for staff-only and unknown transitions', () => {
    for (const role of IMPERSONATION_TARGET_ROLES) {
      for (const from of SHIPMENT_STATUSES) {
        for (const to of SHIPMENT_STATUSES) {
          const policy = impersonationTransitionPolicy(role, from, to);
          if (!transitions[`${role}:${from}->${to}`]) expect(policy.access).toBe('FORBIDDEN');
        }
      }
    }
    expect(impersonationTransitionPolicy('MERCHANT', 'RETURN_REQUESTED', 'RETURNED').access).toBe(
      'FORBIDDEN',
    );
  });
});

describe('impersonation route policy', () => {
  it('fails closed for a route that is not classified', () => {
    expect(impersonationRoutePolicy('POST /v1/admin/something-new').access).toBe('FORBIDDEN');
    expect(impersonationRoutePolicy('GET /v1/merchant/finance').access).toBe('ALLOWED');
  });

  it('never permits a staff route', () => {
    for (const [route, policy] of Object.entries(routes)) {
      if (route.includes(' /v1/admin/')) expect(policy.access, route).toBe('FORBIDDEN');
    }
  });

  it('permits writes only as SAFEGUARDED, apart from logout and End (which end the impersonation)', () => {
    // Both only end the impersonation.
    const readOnlyWrites = ['POST /v1/auth/logout', 'POST /v1/impersonation/end'];
    for (const [route, policy] of Object.entries(routes)) {
      const write = !route.startsWith('GET ');
      if (write && policy.access === 'ALLOWED') expect(readOnlyWrites, route).toContain(route);
    }
  });

  it('never classifies a non-GET route as READ_ONLY (a POST that persists is a write)', () => {
    const readOnlyNonGet = Object.entries(routes)
      .filter(([route, policy]) => !route.startsWith('GET ') && policy.basis === 'READ_ONLY')
      .map(([route]) => route);
    expect(readOnlyNonGet).toEqual([]);
  });

  it('forbids every financial-consent, cash and credential route', () => {
    for (const route of [
      'POST /v1/merchant/finance/payouts',
      'POST /v1/merchant/finance/payouts/:id/cancel',
      'POST /v1/merchant/finance/shortfalls/:id/accept',
      'POST /v1/merchant/finance/shortfalls/:id/decline',
      'POST /v1/driver/shipments/:id/collections',
      'POST /v1/driver/finance/settlements',
      'PUT /v1/merchant/pickup-zone',
      'DELETE /v1/merchant/pickup-zone/request',
      'POST /v1/auth/resend-verification',
      'PATCH /v1/me/preferences',
    ]) {
      expect(routes[route]?.access, route).toBe('FORBIDDEN');
    }
  });

  it('points every admin alternative at a classified staff route', () => {
    for (const [route, policy] of Object.entries(routes)) {
      if (!policy.adminAlternative) continue;
      expect(policy.access, route).toBe('FORBIDDEN');
      expect(routes[policy.adminAlternative]?.basis, policy.adminAlternative).toBe('STAFF_ONLY');
    }
  });
});

describe('impersonation request schemas', () => {
  // 32 bytes of 0x07 (base64url) and its SHA-256 (base64url); 32 bytes of 0x09 as a code.
  const verifier = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
  const challenge = '3Ev4DHdHPRMPoN6GukAY_pi7IUAF5qWJHRK6kURvnoE';
  const code = 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk';

  it('accepts a start request with a reason and a verifier challenge', () => {
    const result = startImpersonationSchema.safeParse({
      targetUserId: '0190f2a4-6b8e-7c3d-9e1f-2a3b4c5d6e7f',
      reason: '  Merchant cannot create a shipment  ',
      ticketReference: '',
      codeChallenge: challenge,
    });
    expect(result.success).toBe(true);
    expect(result.data?.reason).toBe('Merchant cannot create a shipment');
    expect(result.data?.ticketReference).toBeUndefined();
  });

  it('rejects a start request without a usable reason or challenge', () => {
    const result = startImpersonationSchema.safeParse({
      targetUserId: 'not-a-uuid',
      reason: 'x',
      codeChallenge: 'short',
    });
    expect(result.success).toBe(false);
    expect(toFieldErrors(result.error!)).toEqual({
      targetUserId: 'validation.required',
      reason: 'validation.reason.required',
      codeChallenge: 'validation.token.invalid',
    });
  });

  it('accepts only base64url codes and verifiers', () => {
    expect(exchangeImpersonationSchema.safeParse({ code, codeVerifier: verifier }).success).toBe(
      true,
    );
    expect(
      exchangeImpersonationSchema.safeParse({ code: `${code}=`, codeVerifier: verifier }).success,
    ).toBe(false);
    expect(
      exchangeImpersonationSchema.safeParse({ code, codeVerifier: verifier.slice(0, 42) }).success,
    ).toBe(false);
  });
});

describe('what the impersonated app shows', () => {
  it('blocks forbidden routes by their basis and safeguarded ones only when writes are off', () => {
    expect(impersonationRouteBlock('GET /v1/merchant/finance', false)).toBeNull();
    expect(impersonationRouteBlock('POST /v1/merchant/finance/payouts', true)).toBe(
      'FINANCIAL_CONSENT',
    );
    expect(impersonationRouteBlock('POST /v1/driver/finance/settlements', true)).toBe(
      'CASH_CUSTODY',
    );
    expect(impersonationRouteBlock('POST /v1/merchant/shipments', true)).toBeNull();
    expect(impersonationRouteBlock('POST /v1/merchant/shipments', false)).toBe('VIEW_ONLY');
  });

  it('follows the transition table, failing closed for unlisted transitions', () => {
    expect(
      impersonationTransitionCapability('DRIVER', 'OUT_FOR_DELIVERY', 'DELIVERED', true),
    ).toEqual({
      block: 'LEDGER_POSTING',
      requiresReason: false,
      requiresConfirmation: false,
    });
    expect(
      impersonationTransitionCapability('DRIVER', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED', true),
    ).toEqual({ block: null, requiresReason: true, requiresConfirmation: true });
    expect(impersonationTransitionCapability('MERCHANT', 'CREATED', 'CANCELLED', false).block).toBe(
      'VIEW_ONLY',
    );
    expect(impersonationTransitionCapability('MERCHANT', 'CREATED', 'DELIVERED', true).block).toBe(
      'STAFF_ONLY',
    );
  });
});
