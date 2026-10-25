import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import {
  AdminShipmentsController,
  DriverShipmentsController,
  MerchantShipmentsController,
} from './shipments.controller.js';
import { ShipmentsService } from './shipments.service.js';

@Module({
  imports: [PricingModule, FinanceModule],
  controllers: [AdminShipmentsController, MerchantShipmentsController, DriverShipmentsController],
  providers: [ShipmentsService],
})
export class ShipmentsModule {}
