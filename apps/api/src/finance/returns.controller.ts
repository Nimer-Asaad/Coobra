import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  FINANCE_ROLES,
  RETURN_FEE_STATUSES,
  setReturnFeeSchema,
  SHIPMENT_VIEWER_ROLES,
  waiveReturnFeeSchema,
  type SetReturnFeeInput,
  type WaiveReturnFeeInput,
} from '@coobra/shared';
import { Auth, Meta, Roles } from '../common/decorators.js';
import type { RequestAuth, RequestMeta } from '../common/request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ReturnsService } from './returns.service.js';

const returnsQuery = z.object({
  open: z.enum(['true', 'false']).optional(),
  feeStatus: z.enum(RETURN_FEE_STATUSES).optional(),
});

/** Returns overview for staff; return fees are decided by finance (set or waived with a reason). */
@Controller('admin/returns')
@Roles(...SHIPMENT_VIEWER_ROLES)
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(returnsQuery)) query: z.infer<typeof returnsQuery>) {
    return this.returns.list({ open: query.open === 'true', feeStatus: query.feeStatus });
  }

  @Roles(...FINANCE_ROLES)
  @HttpCode(200)
  @Post(':shipmentId/fee')
  setFee(
    @Auth() auth: RequestAuth,
    @Param('shipmentId') shipmentId: string,
    @Body(new ZodValidationPipe(setReturnFeeSchema)) body: SetReturnFeeInput,
    @Meta() meta: RequestMeta,
  ) {
    return this.returns.setFee(auth.user, shipmentId, body, meta);
  }

  @Roles(...FINANCE_ROLES)
  @HttpCode(200)
  @Post(':shipmentId/waive')
  waive(
    @Auth() auth: RequestAuth,
    @Param('shipmentId') shipmentId: string,
    @Body(new ZodValidationPipe(waiveReturnFeeSchema)) body: WaiveReturnFeeInput,
    @Meta() meta: RequestMeta,
  ) {
    return this.returns.waive(auth.user, shipmentId, body, meta);
  }
}
