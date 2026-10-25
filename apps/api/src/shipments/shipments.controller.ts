import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  adminCreateShipmentSchema,
  assignDriverSchema,
  createShipmentSchema,
  listPeopleQuerySchema,
  listShipmentsQuerySchema,
  SHIPMENT_MANAGER_ROLES,
  SHIPMENT_VIEWER_ROLES,
  transitionShipmentSchema,
  type AdminCreateShipmentInput,
  type AssignDriverInput,
  type CreateShipmentInput,
  type DriverOption,
  type ListShipmentsQuery,
  type MerchantOption,
  type Paginated,
  type ShipmentDetails,
  type ShipmentListItem,
  type ShipmentSummary,
  type TransitionShipmentInput,
} from '@coobra/shared';
import { Auth, Meta, Roles } from '../common/decorators.js';
import type { RequestAuth, RequestMeta } from '../common/request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ShipmentsService } from './shipments.service.js';

const MINUTE = 60_000;
/** Creating shipments one after another is normal; this only stops runaway clients. */
const CREATE_LIMIT = { default: { limit: 60, ttl: MINUTE } };

const listQuery = new ZodValidationPipe(listShipmentsQuerySchema);
const transitionBody = new ZodValidationPipe(transitionShipmentSchema);

/** Admin console: all shipments. Viewers read; only SUPER_ADMIN and OPERATIONS write. */
@Controller('admin')
@Roles(...SHIPMENT_VIEWER_ROLES)
export class AdminShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Get('shipments')
  list(
    @Auth() auth: RequestAuth,
    @Query(listQuery) query: ListShipmentsQuery,
  ): Promise<Paginated<ShipmentListItem>> {
    return this.shipments.list(auth.user, query);
  }

  @Get('shipments/summary')
  summary(): Promise<ShipmentSummary> {
    return this.shipments.summary();
  }

  @Get('shipments/:id')
  get(@Auth() auth: RequestAuth, @Param('id') id: string): Promise<ShipmentDetails> {
    return this.shipments.get(auth.user, id);
  }

  @Roles(...SHIPMENT_MANAGER_ROLES)
  @Throttle(CREATE_LIMIT)
  @Post('shipments')
  create(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(adminCreateShipmentSchema)) body: AdminCreateShipmentInput,
    @Meta() meta: RequestMeta,
  ): Promise<ShipmentDetails> {
    return this.shipments.createForMerchantByStaff(auth.user, body, meta);
  }

  @Roles(...SHIPMENT_MANAGER_ROLES)
  @HttpCode(200)
  @Post('shipments/:id/assign')
  assign(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignDriverSchema)) body: AssignDriverInput,
    @Meta() meta: RequestMeta,
  ): Promise<ShipmentDetails> {
    return this.shipments.assign(auth.user, id, body.driverId, body.note, meta);
  }

  @Roles(...SHIPMENT_MANAGER_ROLES)
  @HttpCode(200)
  @Post('shipments/:id/transitions')
  transition(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(transitionBody) body: TransitionShipmentInput,
    @Meta() meta: RequestMeta,
  ): Promise<ShipmentDetails> {
    return this.shipments.transition(auth.user, id, body, meta);
  }

  @Get('merchants')
  merchants(
    @Query(new ZodValidationPipe(listPeopleQuerySchema)) query: { q?: string },
  ): Promise<MerchantOption[]> {
    return this.shipments.merchants(query.q);
  }

  @Get('drivers')
  drivers(
    @Query(new ZodValidationPipe(listPeopleQuerySchema)) query: { q?: string },
  ): Promise<DriverOption[]> {
    return this.shipments.drivers(query.q);
  }
}

/** Merchant app: only the signed-in merchant's own shipments. */
@Controller('merchant/shipments')
@Roles('MERCHANT')
export class MerchantShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Get()
  list(
    @Auth() auth: RequestAuth,
    @Query(listQuery) query: ListShipmentsQuery,
  ): Promise<Paginated<ShipmentListItem>> {
    return this.shipments.list(auth.user, query);
  }

  @Get(':id')
  get(@Auth() auth: RequestAuth, @Param('id') id: string): Promise<ShipmentDetails> {
    return this.shipments.get(auth.user, id);
  }

  @Throttle(CREATE_LIMIT)
  @Post()
  create(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(createShipmentSchema)) body: CreateShipmentInput,
    @Meta() meta: RequestMeta,
  ): Promise<ShipmentDetails> {
    return this.shipments.createForMerchant(auth.user, body, meta);
  }

  @HttpCode(200)
  @Post(':id/transitions')
  transition(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(transitionBody) body: TransitionShipmentInput,
    @Meta() meta: RequestMeta,
  ): Promise<ShipmentDetails> {
    return this.shipments.transition(auth.user, id, body, meta);
  }
}

/** Driver app: only shipments currently assigned to the signed-in driver. */
@Controller('driver/shipments')
@Roles('DRIVER')
export class DriverShipmentsController {
  constructor(private readonly shipments: ShipmentsService) {}

  @Get()
  list(
    @Auth() auth: RequestAuth,
    @Query(listQuery) query: ListShipmentsQuery,
  ): Promise<Paginated<ShipmentListItem>> {
    return this.shipments.list(auth.user, query);
  }

  @Get(':id')
  get(@Auth() auth: RequestAuth, @Param('id') id: string): Promise<ShipmentDetails> {
    return this.shipments.get(auth.user, id);
  }

  @HttpCode(200)
  @Post(':id/transitions')
  transition(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(transitionBody) body: TransitionShipmentInput,
    @Meta() meta: RequestMeta,
  ): Promise<ShipmentDetails> {
    return this.shipments.transition(auth.user, id, body, meta);
  }
}
