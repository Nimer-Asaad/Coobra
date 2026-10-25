import { Module } from '@nestjs/common';
import {
  AdminPricingController,
  MerchantPricingController,
  ZonesController,
} from './pricing.controller.js';
import { PricingService } from './pricing.service.js';
import { ZonesService } from './zones.service.js';

@Module({
  controllers: [ZonesController, AdminPricingController, MerchantPricingController],
  providers: [ZonesService, PricingService],
  exports: [ZonesService, PricingService],
})
export class PricingModule {}
