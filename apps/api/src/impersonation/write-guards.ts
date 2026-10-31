import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '@coobra/database';
import type { ActingContext } from '../common/acting-context.js';
import { AppException, Errors } from '../common/app-exception.js';

/*
 * Guards that run inside a write's own transaction (ADR 0003 §10, Phase 4C.4). They are plain
 * functions taking the caller's transaction, so every service can use them without new module
 * dependencies.
 *
 * Lock order, everywhere: users (by id) -> impersonation -> shipment -> return record. Start and
 * deactivation take users then the impersonation; ending updates the impersonation only; staff
 * decisions lock the shipment and then read involvement without locks. No transaction takes
 * these in the opposite order, so they cannot deadlock.
 */

type Tx = Prisma.TransactionClient;

export const conflictOfInterest = () =>
  new AppException(
    HttpStatus.FORBIDDEN,
    'IMPERSONATION_CONFLICT',
    'You acted on this while impersonating the account; another staff member must decide',
  );

/**
 * Re-validates an impersonated write inside its transaction, after taking the locks: the actor
 * and the target (FOR SHARE, so a deactivation waits or has already ended the impersonation),
 * then the impersonation (FOR SHARE, so an end or the sweeper waits until this write commits).
 * State is read after the locks are granted, with the clock at that moment, so an end or an
 * expiry that happened while the write was waiting is seen. Nothing commits on a revoked or
 * expired impersonation.
 */
export async function assertImpersonationActiveIn(
  tx: Tx,
  acting: ActingContext,
  now: () => Date,
): Promise<void> {
  const impersonation = acting.impersonation;
  if (!impersonation) return;
  const ids = [acting.actor.id, acting.principal.id].sort();
  // Locks first (ids only), in the fixed order; then read the locked rows through Prisma, which
  // maps timestamp(3) columns as UTC (a raw read could be parsed in the server's time zone).
  await tx.$queryRaw`SELECT id FROM users WHERE id IN (${ids[0]}::uuid, ${ids[1]}::uuid) ORDER BY id FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM impersonation_sessions WHERE id = ${impersonation.id}::uuid FOR SHARE`;
  const row = await tx.impersonationSession.findUnique({
    where: { id: impersonation.id },
    include: {
      actor: { select: { role: true, status: true } },
      target: { select: { role: true, status: true } },
      actorSession: true,
    },
  });
  const at = now().getTime();
  const valid =
    row !== null &&
    row.endedAt === null &&
    row.expiresAt.getTime() > at &&
    row.actorUserId === acting.actor.id &&
    row.targetUserId === acting.principal.id &&
    row.actor.status === 'ACTIVE' &&
    row.actor.role === 'SUPER_ADMIN' &&
    row.target.status === 'ACTIVE' &&
    row.target.role === row.targetRole &&
    row.actorSession.revokedAt === null &&
    row.actorSession.expiresAt.getTime() > at &&
    row.actorSession.clientApp === 'ADMIN_WEB' &&
    row.actorSession.impersonationId === null;
  if (!valid) throw Errors.unauthenticated();
}

/**
 * R1 (ADR 0003 §10.2): a person who acted on a shipment while impersonating may never take a
 * staff decision on it, also after the impersonation ended. Reads durable, trigger-protected
 * records only.
 */
export async function shipmentInvolvement(
  tx: Tx,
  shipmentId: string,
  actorId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ involved: number }[]>`
    SELECT 1 AS involved FROM shipments s
      JOIN impersonation_sessions i ON i.id = s.created_impersonation_id
      WHERE s.id = ${shipmentId}::uuid AND i.actor_user_id = ${actorId}::uuid
    UNION ALL
    SELECT 1 FROM shipment_status_history h
      WHERE h.shipment_id = ${shipmentId}::uuid AND h.impersonation_id IS NOT NULL
        AND h.actor_user_id = ${actorId}::uuid
    UNION ALL
    SELECT 1 FROM return_records r
      WHERE r.shipment_id = ${shipmentId}::uuid AND r.requested_impersonation_id IS NOT NULL
        AND r.requested_by_id = ${actorId}::uuid
    UNION ALL
    SELECT 1 FROM audit_logs a
      WHERE a.impersonation_id IS NOT NULL AND a.actor_user_id = ${actorId}::uuid
        AND a.metadata @> jsonb_build_object('shipmentId', ${shipmentId}::text)
    LIMIT 1`;
  return rows.length > 0;
}

export async function assertNoImpersonationConflict(
  tx: Tx,
  shipmentId: string,
  actorId: string,
): Promise<void> {
  if (await shipmentInvolvement(tx, shipmentId, actorId)) throw conflictOfInterest();
}

/** Ever impersonated this merchant (any impersonation, ended or not). */
async function impersonatedAccount(tx: Tx, actorId: string, accountId: string) {
  return (
    (await tx.impersonationSession.count({
      where: { actorUserId: actorId, targetUserId: accountId },
    })) > 0
  );
}

/** Whoever took a decision on a shipment that a linked adjustment may be correcting. */
async function shipmentDecisionMakers(tx: Tx, shipmentId: string): Promise<Set<string>> {
  const rows = await tx.$queryRaw<{ id: string | null }[]>`
    SELECT fee_set_by_id::text AS id FROM return_records WHERE shipment_id = ${shipmentId}::uuid
    UNION SELECT approved_by_id::text FROM return_records WHERE shipment_id = ${shipmentId}::uuid
    UNION SELECT actor_id::text FROM shipment_fee_overrides WHERE shipment_id = ${shipmentId}::uuid
    UNION SELECT approved_by_id::text FROM shipment_fee_overrides WHERE shipment_id = ${shipmentId}::uuid
    UNION SELECT proposed_by_id::text FROM cod_shortfalls WHERE shipment_id = ${shipmentId}::uuid
    UNION SELECT decided_by_id::text FROM cod_shortfalls WHERE shipment_id = ${shipmentId}::uuid
    UNION SELECT e.created_by_id::text FROM journal_entries e
      WHERE EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id AND l.shipment_id = ${shipmentId}::uuid)`;
  return new Set(rows.map((r) => r.id).filter((id): id is string => id !== null));
}

/** Whoever took a decision on the posting (and the business record behind it). */
async function postingDecisionMakers(tx: Tx, entryId: string): Promise<Set<string> | null> {
  const entry = await tx.journalEntry.findUnique({
    where: { id: entryId },
    select: { createdById: true, sourceType: true, sourceId: true },
  });
  if (!entry) return null;
  const people = new Set<string>();
  if (entry.createdById) people.add(entry.createdById);
  const source = entry.sourceId;
  const isUuid = /^[0-9a-f-]{36}$/i.test(source);
  if (isUuid) {
    const lookups: Record<string, () => Promise<(string | null)[]>> = {
      merchant_payout: async () => {
        const p = await tx.merchantPayout.findUnique({
          where: { id: source },
          select: { createdById: true, approvedById: true, paidById: true },
        });
        return p ? [p.createdById, p.approvedById, p.paidById] : [];
      },
      merchant_payment: async () => {
        const p = await tx.merchantPayment.findUnique({
          where: { id: source },
          select: { recordedById: true },
        });
        return p ? [p.recordedById] : [];
      },
      treasury_transfer: async () => {
        const p = await tx.treasuryTransfer.findUnique({
          where: { id: source },
          select: { recordedById: true },
        });
        return p ? [p.recordedById] : [];
      },
      financial_adjustment: async () => {
        const p = await tx.financialAdjustment.findUnique({
          where: { id: source },
          select: { requestedById: true, decidedById: true },
        });
        return p ? [p.requestedById, p.decidedById] : [];
      },
    };
    for (const id of (await lookups[entry.sourceType]?.()) ?? []) if (id) people.add(id);
  }
  return people;
}

/**
 * ADR 0003 §10.4: checked for approve and reject, inside the decision transaction, with the
 * real approver, after the existing maker-checker rules. Linked adjustments refuse an approver
 * involved in the source; UNLINKED or unresolvable provenance needs a fully independent reviewer
 * (one who never impersonated the merchant). There is no override.
 */
export async function assertIndependentAdjustmentReviewer(
  tx: Tx,
  adjustment: AdjustmentProvenance,
  approverId: string,
): Promise<void> {
  if (await adjustmentReviewerConflict(tx, adjustment, approverId)) throw conflictOfInterest();
}

export interface AdjustmentProvenance {
  merchantId: string;
  sourceType: string;
  sourceShipmentId: string | null;
  sourceJournalEntryId: string | null;
}

/** True when the reviewer is not independent (the rule above); reads only. */
export async function adjustmentReviewerConflict(
  tx: Tx,
  adjustment: AdjustmentProvenance,
  approverId: string,
): Promise<boolean> {
  let resolved = adjustment.sourceType !== 'UNLINKED';
  if (adjustment.sourceShipmentId) {
    if (await shipmentInvolvement(tx, adjustment.sourceShipmentId, approverId)) return true;
    const makers = await shipmentDecisionMakers(tx, adjustment.sourceShipmentId);
    if (makers.has(approverId)) return true;
  }
  if (adjustment.sourceJournalEntryId) {
    const makers = await postingDecisionMakers(tx, adjustment.sourceJournalEntryId);
    if (makers === null) resolved = false;
    else if (makers.has(approverId)) return true;
  }
  return !resolved && (await impersonatedAccount(tx, approverId, adjustment.merchantId));
}
