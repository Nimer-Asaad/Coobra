import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CSV_REPORTS, FINANCE_VIEW_ROLES } from '@coobra/shared';
import { Errors } from '../common/app-exception.js';
import { Roles } from '../common/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ReportsService } from './reports.service.js';

const overviewQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
const journalQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Financial reports: overview with reconciliation, journal and CSV exports (read-only). */
@Controller('admin/finance')
@Roles(...FINANCE_VIEW_ROLES)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('overview')
  overview(@Query(new ZodValidationPipe(overviewQuery)) query: z.infer<typeof overviewQuery>) {
    return this.reports.overview(
      query.from ? new Date(query.from) : undefined,
      query.to ? new Date(query.to) : undefined,
    );
  }

  @Get('journal')
  journal(@Query(new ZodValidationPipe(journalQuery)) query: z.infer<typeof journalQuery>) {
    return this.reports.journal(query.page, query.pageSize);
  }

  @Get('reports/:name')
  async csv(@Param('name') name: string, @Res({ passthrough: true }) res: Response) {
    const report = name.replace(/\.csv$/, '');
    if (!(CSV_REPORTS as readonly string[]).includes(report)) throw Errors.notFound();
    const body = await this.reports.csvReport(report);
    if (body === null) throw Errors.notFound();
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="coobra-${report}.csv"`);
    return body;
  }
}
