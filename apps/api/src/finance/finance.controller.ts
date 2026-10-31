import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  adjustmentSchema,
  codCollectionSchema,
  decisionSchema,
  feeCorrectionSchema,
  FINANCE_ROLES,
  FINANCE_VIEW_ROLES,
  proposeShortfallSchema,
  rejectionSchema,
  SHORTFALL_PROPOSER_ROLES,
  SHORTFALL_STATUSES,
  updateFinanceSettingSchema,
  type AdjustmentInput,
  type CodCollectionInput,
  type DecisionInput,
  type FeeCorrectionInput,
  type ProposeShortfallInput,
  type RejectionInput,
  type UpdateFinanceSettingInput,
} from '@coobra/shared';
import { Auth, Meta, Roles } from '../common/decorators.js';
import type { RequestAuth, RequestMeta } from '../common/request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AdjustmentsService } from './adjustments.service.js';
import { ApprovalService } from './approval.service.js';
import { CodService } from './cod.service.js';
import { IdempotencyKey } from './idempotency.service.js';

const decision = new ZodValidationPipe(decisionSchema);
const rejection = new ZodValidationPipe(rejectionSchema);
const shortfallQuery = z.object({ status: z.enum(SHORTFALL_STATUSES).optional() });

/** Admin finance: settings, recipient shortfalls, fee corrections and adjustments. */
@Controller('admin/finance')
@Roles(...FINANCE_VIEW_ROLES)
export class AdminFinanceController {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly cod: CodService,
    private readonly adjustments: AdjustmentsService,
  ) {}

  @Get('settings')
  settings() {
    return this.approvals.settings();
  }

  @Roles('SUPER_ADMIN')
  @HttpCode(204)
  @Put('settings/approval-threshold')
  async updateThreshold(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(updateFinanceSettingSchema)) body: UpdateFinanceSettingInput,
    @Meta() meta: RequestMeta,
  ) {
    await this.approvals.updateThreshold(auth.user, body, meta);
  }

  @Roles(...SHORTFALL_PROPOSER_ROLES, 'OWNER_VIEWER')
  @Get('shortfalls')
  shortfalls(@Query(new ZodValidationPipe(shortfallQuery)) query: z.infer<typeof shortfallQuery>) {
    return this.cod.listShortfalls({ status: query.status });
  }

  @Roles(...SHORTFALL_PROPOSER_ROLES)
  @HttpCode(200)
  @Post('shortfalls/:id/propose')
  propose(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(proposeShortfallSchema)) body: ProposeShortfallInput,
    @Meta() meta: RequestMeta,
  ) {
    return this.cod.propose(auth.user, id, body, meta);
  }

  @Roles(...FINANCE_ROLES)
  @HttpCode(200)
  @Post('shortfalls/:id/approve')
  approveShortfall(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(decision) body: DecisionInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.cod.approve(auth.user, id, body.note, key, meta);
  }

  @Roles(...FINANCE_ROLES)
  @HttpCode(200)
  @Post('shortfalls/:id/reject')
  rejectShortfall(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(rejection) body: RejectionInput,
    @Meta() meta: RequestMeta,
  ) {
    return this.cod.reject(auth.user, id, body.note, meta);
  }

  @Get('fee-corrections')
  feeCorrections() {
    return this.adjustments.pendingFeeCorrections();
  }

  @Roles(...FINANCE_ROLES)
  @Post('shipments/:id/fee-correction')
  requestFeeCorrection(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(feeCorrectionSchema)) body: FeeCorrectionInput,
    @Meta() meta: RequestMeta,
  ) {
    return this.adjustments.requestFeeCorrection(auth.user, id, body, meta);
  }

  @Roles(...FINANCE_ROLES)
  @HttpCode(200)
  @Post('fee-corrections/:id/approve')
  approveFeeCorrection(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(decision) body: DecisionInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.adjustments.decideFeeCorrection(auth.user, id, true, body.note, key, meta);
  }

  @Roles(...FINANCE_ROLES)
  @HttpCode(200)
  @Post('fee-corrections/:id/reject')
  rejectFeeCorrection(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(rejection) body: RejectionInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.adjustments.decideFeeCorrection(auth.user, id, false, body.note, key, meta);
  }

  @Get('adjustments')
  listAdjustments(@Auth() auth: RequestAuth) {
    return this.adjustments.listAdjustments(auth.user);
  }

  @Roles(...FINANCE_ROLES)
  @Post('adjustments')
  requestAdjustment(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(adjustmentSchema)) body: AdjustmentInput,
    @Meta() meta: RequestMeta,
  ) {
    return this.adjustments.requestAdjustment(auth.user, body, meta);
  }

  @Roles(...FINANCE_ROLES)
  @HttpCode(200)
  @Post('adjustments/:id/approve')
  approveAdjustment(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(decision) body: DecisionInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.adjustments.decideAdjustment(auth.user, id, true, body.note, key, meta);
  }

  @Roles(...FINANCE_ROLES)
  @HttpCode(200)
  @Post('adjustments/:id/reject')
  rejectAdjustment(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(rejection) body: RejectionInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.adjustments.decideAdjustment(auth.user, id, false, body.note, key, meta);
  }
}

/** Merchant finance: only the merchant's own shortfall cases. */
@Controller('merchant/finance')
@Roles('MERCHANT')
export class MerchantFinanceController {
  constructor(private readonly cod: CodService) {}

  @Get('shortfalls')
  shortfalls(@Auth() auth: RequestAuth) {
    return this.cod.merchantShortfalls(auth.user);
  }

  @HttpCode(200)
  @Post('shortfalls/:id/accept')
  accept(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(decision) body: DecisionInput,
    @Meta() meta: RequestMeta,
  ) {
    return this.cod.merchantRespond(auth.user, id, true, body.note, meta);
  }

  @HttpCode(200)
  @Post('shortfalls/:id/decline')
  decline(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(decision) body: DecisionInput,
    @Meta() meta: RequestMeta,
  ) {
    return this.cod.merchantRespond(auth.user, id, false, body.note, meta);
  }
}

/** Driver finance: follow-up COD collections on their own shipments. */
@Controller('driver')
@Roles('DRIVER')
export class DriverFinanceController {
  constructor(private readonly cod: CodService) {}

  @HttpCode(200)
  @Post('shipments/:id/collections')
  collect(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(codCollectionSchema)) body: CodCollectionInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.cod.collect(auth.user, id, body, key, meta);
  }
}
