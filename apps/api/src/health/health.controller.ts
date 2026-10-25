import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { HealthResponse, ReadinessResponse } from '@coobra/shared';
import { Public } from '../common/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: the process is up. Does not touch the database. */
  @Get()
  live(): HealthResponse {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /** Readiness: the API can reach PostgreSQL. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessResponse> {
    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'up' };
    } catch {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'error', database: 'down' };
    }
  }
}
