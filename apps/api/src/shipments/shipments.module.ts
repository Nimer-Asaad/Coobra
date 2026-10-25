import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module.js';
import {
  AdminShipmentsController,
  DriverShipmentsController,
  MerchantShipmentsController,
} from './shipments.controller.js';
import { ShipmentsService } from './shipments.service.js';

@Module({
  imports: [PricingModule],
  controllers: [AdminShipmentsController, MerchantShipmentsController, DriverShipmentsController],
  providers: [ShipmentsService],
})
export class ShipmentsModule {}
