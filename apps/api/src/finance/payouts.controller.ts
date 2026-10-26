import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  createPayoutSchema,
  FINANCE_ROLES,
  FINANCE_VIEW_ROLES,
  markPayoutPaidSchema,
  merchantPaymentSchema,
  payoutRequestSchema,
  rejectionSchema,
  treasuryTransferSchema,
  type CreatePayoutInput,
  type MarkPayoutPaidInput,
  type MerchantPaymentInput,
  type PayoutRequestInput,
  type RejectionInput,
  type TreasuryTransferInput,
} from '@coobra/shared';
import { Auth, Meta, Roles } from '../common/decorators.js';
import type { RequestAuth, RequestMeta } from '../common/request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { IdempotencyKey } from './idempotency.service.js';
import { PayoutsService } from './payouts.service.js';

const payoutQuery = z.object({
  status: z.enum(['PENDING_APPROVAL', 'APPROVED', 'PAID', 'CANCELLED']).optional(),
  merchantId: z.uuid().optional(),
});
const reason = new ZodValidationPipe(rejectionSchema);

/** Admin: merchant balances, payouts, merchant payments and treasury transfers. */
@Controller('admin/finance')
@Roles(...FINANCE_VIEW_ROLES)
export class AdminPayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get('merchants')
  merchants() {
    return this.payouts.merchantBalances();
  }

  @Get('payouts')
  list(@Query(new ZodValidationPipe(payoutQuery)) query: z.infer<typeof payoutQuery>) {
    return this.payouts.list(query);
  }

  @Roles(...FINANCE_ROLES)
  @Post('payouts')
  create(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(createPayoutSchema)) body: CreatePayoutInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.payouts.create(auth.user, body, key, meta);
  }

  @Roles(...FINANCE_ROLES)
  @HttpCode(200)
  @Post('payouts/:id/approve')
  approve(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.payouts.approve(auth.user, id, key, meta);
  }

  @Roles(...FINANCE_ROLES)
  @HttpCode(200)
  @Post('payouts/:id/pay')
  pay(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(markPayoutPaidSchema)) body: MarkPayoutPaidInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.payouts.markPaid(auth.user, id, body, key, meta);
  }

  @Roles(...FINANCE_ROLES)
  @HttpCode(200)
  @Post('payouts/:id/cancel')
  cancel(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(reason) body: RejectionInput,
    @Meta() meta: RequestMeta,
  ) {
    return this.payouts.cancel(auth.user, id, body.note, meta);
  }

  @Roles(...FINANCE_ROLES)
  @Post('merchant-payments')
  merchantPayment(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(merchantPaymentSchema)) body: MerchantPaymentInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.payouts.recordMerchantPayment(auth.user, body, key, meta);
  }

  @Roles(...FINANCE_ROLES)
  @Post('treasury-transfers')
  transfer(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(treasuryTransferSchema)) body: TreasuryTransferInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.payouts.transfer(auth.user, body, key, meta);
  }
}

/** Merchant app: own balance and payouts only. */
@Controller('merchant/finance')
@Roles('MERCHANT')
export class MerchantPayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get()
  summary(@Auth() auth: RequestAuth) {
    return this.payouts.summary(auth.user.id);
  }

  @Post('payouts')
  request(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(payoutRequestSchema)) body: PayoutRequestInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.payouts.request(auth.user, body, key, meta);
  }

  @HttpCode(200)
  @Post('payouts/:id/cancel')
  cancel(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(reason) body: RejectionInput,
    @Meta() meta: RequestMeta,
  ) {
    return this.payouts.cancel(auth.user, id, body.note, meta);
  }
}
