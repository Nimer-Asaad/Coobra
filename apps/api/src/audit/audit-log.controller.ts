import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  listAuditLogsQuerySchema,
  type AuditLogDetails,
  type AuditLogListItem,
  type ListAuditLogsQuery,
  type Paginated,
} from '@coobra/shared';
import { Auth, Roles } from '../common/decorators.js';
import type { RequestAuth } from '../common/request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AuditLogService } from './audit-log.service.js';

/** Read only: the audit log has no create, update or delete route. */
@Roles('SUPER_ADMIN')
@Controller('admin/audit-logs')
export class AuditLogController {
  constructor(private readonly auditLogs: AuditLogService) {}

  @Get()
  list(
    @Auth() auth: RequestAuth,
    @Query(new ZodValidationPipe(listAuditLogsQuerySchema)) query: ListAuditLogsQuery,
  ): Promise<Paginated<AuditLogListItem>> {
    return this.auditLogs.list(auth.user, query);
  }

  @Get(':id')
  details(@Auth() auth: RequestAuth, @Param('id') id: string): Promise<AuditLogDetails> {
    return this.auditLogs.details(auth.user, id);
  }
}
