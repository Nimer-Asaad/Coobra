import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Prisma, type Shipment } from '@coobra/database';
import {
  CONSEQUENCE_CONFIRMATION_TTL_SECONDS,
  type ConsequenceLine,
  type ConsequencePreview,
  type ShipmentStatus,
} from '@coobra/shared';
import type { ActingContext } from '../common/acting-context.js';
import { AppException } from '../common/app-exception.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { ConsequenceSigner, canonicalJson, type Canonical } from '../common/consequence-signing.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { ReturnsService, returnDeliveryCharge } from '../finance/returns.service.js';
import type { PriceResult } from '../pricing/pricing.service.js';

type Tx = Prisma.TransactionClient;

/** What a confirmation covers: the action, the exact state it was computed from, the charges. */
export interface Consequence {
  action: string;
  binding: Canonical;
  lines: ConsequenceLine[];
}

const confirmationRequired = () =>
  new AppException(
    HttpStatus.BAD_REQUEST,
    'CONSEQUENCE_CONFIRMATION_REQUIRED',
    'Review and confirm the charges first (confirmationToken)',
  );
const confirmationChanged = () =>
  new AppException(
    HttpStatus.CONFLICT,
    'CONSEQUENCE_CHANGED',
    'The charges changed since they were confirmed; review them again',
  );
const writesDisabled = () =>
  new AppException(
    HttpStatus.FORBIDDEN,
    'IMPERSONATION_FORBIDDEN_ACTION',
    'Changes are not enabled while acting as another account',
  );

const money = (value: Prisma.Decimal | null | undefined) => (value ? value.toFixed(2) : null);

/**
 * R2 (ADR 0003 §10.3): the charges an impersonated action can lead to later, signed for the
 * confirmation dialog and verified inside the write transaction by recomputing them from the
 * locked state. The same functions compute the preview and the check, from the same rules that
 * charge the merchant later (PricingService, ReturnsService), so they cannot drift apart.
 */
@Injectable()
export class ConsequenceService {
  private readonly signer: ConsequenceSigner | null;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly returns: ReturnsService,
  ) {
    this.signer = config.impersonationWrites.signing
      ? new ConsequenceSigner(config.impersonationWrites.signing)
      : null;
  }

  /** C1: creating a shipment fixes its pricing snapshot and COD amount. */
  forCreate(input: {
    merchantId: string;
    originZoneId: string;
    destinationZoneId: string;
    codAmount: string;
    quoteId: string | null;
    priced: PriceResult;
    currency: string;
  }): Consequence {
    const { priced } = input;
    const cod = new Prisma.Decimal(input.codAmount);
    const lines: ConsequenceLine[] = [
      line('DELIVERY_FEE', money(priced.fee), 'FIXED', 'ON_DELIVERY', input.currency),
    ];
    if (cod.greaterThan(0)) {
      lines.push(line('COD_TO_COLLECT', money(cod), 'FIXED', 'ON_DELIVERY', input.currency));
    }
    lines.push(
      priced.returnFee
        ? line(
            'RETURN_FEE',
            money(priced.returnFee),
            'FIXED',
            'ON_RETURN_COMPLETED',
            input.currency,
          )
        : line('RETURN_FEE', null, 'UNDECIDED', 'ON_RETURN_COMPLETED', input.currency),
    );
    if (priced.returnPolicy !== 'RETURN_ONLY') {
      // Only if a delivery fails and the shipment is returned: an estimate ("up to").
      const charge = returnDeliveryCharge(priced.returnPolicy, priced.attemptFee, priced.fee);
      lines.push(
        line(
          'RETURN_DELIVERY_CHARGE',
          money(charge),
          'ESTIMATED',
          'ON_RETURN_COMPLETED',
          input.currency,
        ),
      );
    }
    return {
      action: 'CREATE_SHIPMENT',
      binding: {
        merchantId: input.merchantId,
        originZoneId: input.originZoneId,
        destinationZoneId: input.destinationZoneId,
        codAmount: money(cod),
        quoteId: input.quoteId,
        ruleId: priced.rule.id,
        ruleVersion: priced.rule.version,
        fee: money(priced.fee),
        returnFee: money(priced.returnFee),
        returnPolicy: priced.returnPolicy,
        attemptFee: money(priced.attemptFee),
      },
      lines,
    };
  }

  /** C3, C4, C6: from the shipment, its pricing snapshot and its return record, as locked. */
  async forTransition(tx: Tx, shipment: Shipment, toStatus: ShipmentStatus): Promise<Consequence> {
    const pricing = await tx.shipmentPricing.findUnique({ where: { shipmentId: shipment.id } });
    const record = await tx.returnRecord.findUnique({ where: { shipmentId: shipment.id } });
    const failedAttempts = await tx.shipmentStatusHistory.count({
      where: { shipmentId: shipment.id, toStatus: 'DELIVERY_FAILED' },
    });
    const currency = shipment.currency;
    const lines: ConsequenceLine[] = [];
    const recordLines = () => {
      if (!record || record.feeStatus === 'WAIVED' || record.feeStatus === 'POSTED') return;
      lines.push(
        record.feeStatus === 'SET'
          ? line('RETURN_FEE', money(record.feeAmount), 'FIXED', 'ON_RETURN_COMPLETED', currency)
          : line('RETURN_FEE', null, 'UNDECIDED', 'ON_RETURN_COMPLETED', currency),
      );
      if (record.deliveryCharge.greaterThan(0)) {
        lines.push(
          line(
            'RETURN_DELIVERY_CHARGE',
            money(record.deliveryCharge),
            'FIXED',
            'ON_RETURN_COMPLETED',
            currency,
          ),
        );
      }
    };
    if (toStatus === 'RETURN_REQUESTED') {
      if (record) recordLines();
      else {
        // What ReturnsService.ensureRecord will store for this request.
        lines.push(
          pricing?.returnFee
            ? line('RETURN_FEE', money(pricing.returnFee), 'FIXED', 'ON_RETURN_COMPLETED', currency)
            : line('RETURN_FEE', null, 'UNDECIDED', 'ON_RETURN_COMPLETED', currency),
        );
        const charge = await this.returns.deliveryChargeFor(tx, shipment.id, pricing);
        if (charge.greaterThan(0)) {
          lines.push(
            line('RETURN_DELIVERY_CHARGE', money(charge), 'FIXED', 'ON_RETURN_COMPLETED', currency),
          );
        }
      }
    } else if (toStatus === 'DELIVERY_FAILED') {
      if (!record) {
        const charge = await this.returns.deliveryChargeFor(tx, shipment.id, pricing, {
          assumeFailedAttempt: true,
        });
        if (charge.greaterThan(0)) {
          // Fixed by the snapshot policy, charged only if the shipment is later returned.
          lines.push(
            line('RETURN_DELIVERY_CHARGE', money(charge), 'FIXED', 'ON_RETURN_COMPLETED', currency),
          );
        }
      }
    } else {
      recordLines();
    }
    return {
      action: `TRANSITION:${shipment.status}->${toStatus}`,
      binding: {
        shipmentId: shipment.id,
        version: shipment.version,
        status: shipment.status,
        toStatus,
        deliveryFee: money(shipment.deliveryFee),
        pricing: pricing
          ? {
              ruleId: pricing.ruleId,
              ruleVersion: pricing.ruleVersion,
              finalFee: money(pricing.finalFee),
              returnFee: money(pricing.returnFee),
              returnPolicy: pricing.returnPolicy,
              attemptFee: money(pricing.attemptFee),
            }
          : null,
        record: record
          ? {
              feeStatus: record.feeStatus,
              feeAmount: money(record.feeAmount),
              deliveryCharge: money(record.deliveryCharge),
            }
          : null,
        failedAttempts,
      },
      lines,
    };
  }

  private signed(acting: ActingContext, consequence: Consequence): Canonical {
    return {
      impersonationId: acting.impersonation!.id,
      actorId: acting.actor.id,
      principalId: acting.principal.id,
      action: consequence.action,
      binding: consequence.binding,
      lines: consequence.lines as unknown as Canonical,
    };
  }

  /** The confirmation dialog's data and its signed token (valid 5 minutes). */
  preview(acting: ActingContext, consequence: Consequence): ConsequencePreview {
    if (!this.signer || !acting.impersonation) throw writesDisabled();
    const expiresAt = new Date(
      this.clock.now().getTime() + CONSEQUENCE_CONFIRMATION_TTL_SECONDS * 1000,
    );
    return {
      lines: consequence.lines,
      confirmationToken: this.signer.sign(this.signed(acting, consequence), expiresAt),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Inside the write transaction, after the rows are locked: the token must be signed by a known
   * key, unexpired, and cover exactly the consequence recomputed now (same impersonation, actor,
   * account, action, state and charges).
   */
  verify(acting: ActingContext, token: string | undefined, consequence: Consequence): void {
    if (!this.signer) throw writesDisabled();
    if (!token) throw confirmationRequired();
    const verified = this.signer.verify(token, this.clock.now());
    if (!verified) throw confirmationChanged();
    if (canonicalJson(verified.data) !== canonicalJson(this.signed(acting, consequence))) {
      throw confirmationChanged();
    }
  }
}

function line(
  kind: ConsequenceLine['kind'],
  amount: string | null,
  certainty: ConsequenceLine['certainty'],
  trigger: ConsequenceLine['trigger'],
  currency: string,
): ConsequenceLine {
  return { kind, party: 'MERCHANT', amount, currency, certainty, trigger };
}
