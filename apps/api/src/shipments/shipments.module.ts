import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import {
  AdminShipmentsController,
  DriverShipmentsController,
  MerchantConsequencesController,
  MerchantShipmentsController,
} from './shipments.controller.js';
import { ConsequenceService } from './consequences.service.js';
import { ShipmentsService } from './shipments.service.js';

@Module({
  imports: [PricingModule, FinanceModule],
  controllers: [
    AdminShipmentsController,
    MerchantShipmentsController,
    MerchantConsequencesController,
    DriverShipmentsController,
  ],
  providers: [ShipmentsService, ConsequenceService],
})
export class ShipmentsModule {}
