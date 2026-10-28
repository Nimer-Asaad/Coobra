import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  CASH_COUNT_ROLES,
  confirmSettlementSchema,
  decisionSchema,
  driverRepaymentSchema,
  driverShortageSchema,
  FINANCE_ROLES,
  FINANCE_VIEW_ROLES,
  rejectionSchema,
  SETTLEMENT_RECORDER_ROLES,
  SETTLEMENT_VIEW_ROLES,
  staffSettlementSchema,
  submitSettlementSchema,
  type ConfirmSettlementInput,
  type DecisionInput,
  type DriverRepaymentInput,
  type DriverShortageInput,
  type RejectionInput,
  type StaffSettlementInput,
  type SubmitSettlementInput,
} from '@coobra/shared';
import { Auth, Meta, Roles } from '../common/decorators.js';
import type { RequestAuth, RequestMeta } from '../common/request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { IdempotencyKey } from './idempotency.service.js';
import { SettlementsService } from './settlements.service.js';

const settlementQuery = z.object({
  status: z.enum(['SUBMITTED', 'CONFIRMED', 'REJECTED']).optional(),
  driverId: z.uuid().optional(),
});

/**
 * Admin: driver cash balances, settlements, cash shortages and repayments. Operations register
 * cash hand-overs; only an accountant counts and decides them (see CASH_COUNT_ROLES).
 */
@Controller('admin/finance')
@Roles(...FINANCE_VIEW_ROLES)
export class AdminSettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Get('drivers')
  drivers() {
    return this.settlements.driverBalances();
  }

  @Roles(...SETTLEMENT_VIEW_ROLES)
  @Get('settlements')
  list(@Query(new ZodValidationPipe(settlementQuery)) query: z.infer<typeof settlementQuery>) {
    return this.settlements.listSettlements(query);
  }

  @Roles(...SETTLEMENT_RECORDER_ROLES)
  @Post('settlements')
  recordAtCounter(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(staffSettlementSchema)) body: StaffSettlementInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    const { driverId, ...input } = body;
    return this.settlements.submit(auth.user, driverId, input, key, meta);
  }

  @Roles(...CASH_COUNT_ROLES)
  @HttpCode(200)
  @Post('settlements/:id/confirm')
  confirm(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(confirmSettlementSchema)) body: ConfirmSettlementInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.settlements.confirm(auth.user, id, body, key, meta);
  }

  @Roles(...CASH_COUNT_ROLES)
  @HttpCode(200)
  @Post('settlements/:id/reject')
  reject(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectionSchema)) body: RejectionInput,
    @Meta() meta: RequestMeta,
  ) {
    return this.settlements.reject(auth.user, id, body.note, meta);
  }

  @Get('driver-shortages')
  shortages() {
    return this.settlements.listShortages();
  }

  @Roles(...CASH_COUNT_ROLES)
  @Post('driver-shortages')
  proposeShortage(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(driverShortageSchema)) body: DriverShortageInput,
    @Meta() meta: RequestMeta,
  ) {
    return this.settlements.proposeShortage(auth.user, body, meta);
  }

  @Roles(...FINANCE_ROLES)
  @HttpCode(200)
  @Post('driver-shortages/:id/approve')
  approveShortage(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decisionSchema)) body: DecisionInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.settlements.decideShortage(auth.user, id, true, body.note, key, meta);
  }

  @Roles(...FINANCE_ROLES)
  @HttpCode(200)
  @Post('driver-shortages/:id/reject')
  rejectShortage(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectionSchema)) body: RejectionInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.settlements.decideShortage(auth.user, id, false, body.note, key, meta);
  }

  @Roles(...CASH_COUNT_ROLES)
  @Post('driver-repayments')
  repayment(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(driverRepaymentSchema)) body: DriverRepaymentInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.settlements.recordRepayment(auth.user, body, key, meta);
  }
}

/** Driver app: own cash custody, uncleared collections and settlements. */
@Controller('driver/finance')
@Roles('DRIVER')
export class DriverSettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Get()
  summary(@Auth() auth: RequestAuth) {
    return this.settlements.driverSummary(auth.user.id);
  }

  @Post('settlements')
  submit(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(submitSettlementSchema)) body: SubmitSettlementInput,
    @IdempotencyKey() key: string,
    @Meta() meta: RequestMeta,
  ) {
    return this.settlements.submit(auth.user, auth.user.id, body, key, meta);
  }
}
