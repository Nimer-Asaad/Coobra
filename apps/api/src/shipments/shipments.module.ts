import { Module } from '@nestjs/common';
import {
  AdminShipmentsController,
  DriverShipmentsController,
  MerchantShipmentsController,
} from './shipments.controller.js';
import { ShipmentsService } from './shipments.service.js';

@Module({
  controllers: [AdminShipmentsController, MerchantShipmentsController, DriverShipmentsController],
  providers: [ShipmentsService],
})
export class ShipmentsModule {}
