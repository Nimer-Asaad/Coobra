import { Global, Module } from '@nestjs/common';
import { AuditLogController } from './audit-log.controller.js';
import { AuditLogService } from './audit-log.service.js';
import { AuditService } from './audit.service.js';

@Global()
@Module({
  controllers: [AuditLogController],
  providers: [AuditService, AuditLogService],
  exports: [AuditService],
})
export class AuditModule {}
