import { Module } from '@nestjs/common';
import { AdjustmentsService } from './adjustments.service.js';
import { ApprovalService } from './approval.service.js';
import { CodService } from './cod.service.js';
import {
  AdminFinanceController,
  DriverFinanceController,
  MerchantFinanceController,
} from './finance.controller.js';
import { IdempotencyService } from './idempotency.service.js';
import { LedgerService } from './ledger.service.js';

@Module({
  controllers: [AdminFinanceController, MerchantFinanceController, DriverFinanceController],
  providers: [LedgerService, IdempotencyService, ApprovalService, CodService, AdjustmentsService],
  exports: [LedgerService, IdempotencyService, ApprovalService, CodService],
})
export class FinanceModule {}
