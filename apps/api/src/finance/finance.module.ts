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
import {
  AdminSettlementsController,
  DriverSettlementsController,
} from './settlements.controller.js';
import { SettlementsService } from './settlements.service.js';

@Module({
  controllers: [
    AdminFinanceController,
    MerchantFinanceController,
    DriverFinanceController,
    AdminSettlementsController,
    DriverSettlementsController,
  ],
  providers: [
    LedgerService,
    IdempotencyService,
    ApprovalService,
    CodService,
    AdjustmentsService,
    SettlementsService,
  ],
  exports: [LedgerService, IdempotencyService, ApprovalService, CodService],
})
export class FinanceModule {}
