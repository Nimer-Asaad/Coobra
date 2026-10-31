import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import {
  AdminImpersonationController,
  ImpersonationAuthController,
  ImpersonationController,
} from './impersonation.controller.js';
import { ImpersonationService } from './impersonation.service.js';
import { ImpersonationSweeper } from './impersonation-sweeper.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ImpersonationAuthController, AdminImpersonationController, ImpersonationController],
  providers: [ImpersonationService, ImpersonationSweeper],
  exports: [ImpersonationSweeper],
})
export class ImpersonationModule {}
