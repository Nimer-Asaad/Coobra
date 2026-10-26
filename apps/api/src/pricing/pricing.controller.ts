import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import {
  adminQuoteRequestSchema,
  createPricingRuleSchema,
  createZoneKindSchema,
  createZoneSchema,
  FEE_OVERRIDE_ROLES,
  feeOverrideSchema,
  pickupZoneDecisionSchema,
  pickupZoneSchema,
  PRICING_MANAGER_ROLES,
  quoteRequestSchema,
  revisePricingRuleSchema,
  SHIPMENT_MANAGER_ROLES,
  SHIPMENT_VIEWER_ROLES,
  updateZoneKindSchema,
  updateZoneSchema,
  ZONE_MANAGER_ROLES,
  type AdminQuoteRequestInput,
  type CreatePricingRuleInput,
  type CreateZoneInput,
  type CreateZoneKindInput,
  type FeeOverrideInput,
  type MerchantPickupZoneState,
  type PickupZoneDecisionInput,
  type PickupZoneInput,
  type PickupZoneRequestItem,
  type PricingQuote,
  type PricingRuleItem,
  type QuoteRequestInput,
  type RevisePricingRuleInput,
  type UpdateZoneInput,
  type UpdateZoneKindInput,
  type ZoneItem,
  type ZoneKindItem,
} from '@coobra/shared';
import { Auth, Meta, Roles } from '../common/decorators.js';
import type { RequestAuth, RequestMeta } from '../common/request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PickupZonesService } from './pickup-zones.service.js';
import { PricingService } from './pricing.service.js';
import { ZonesService } from './zones.service.js';

const MINUTE = 60_000;
const ruleListQuery = z.object({
  merchantId: z.uuid().optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
});

/** Active zones for every signed-in user (merchants and drivers pick destinations from them). */
@Controller('zones')
export class ZonesController {
  constructor(private readonly zones: ZonesService) {}

  @Get()
  list(): Promise<ZoneItem[]> {
    return this.zones.list({ includeInactive: false });
  }
}

/** Admin console: zones, pricing rules, quotes, pickup zones and fee overrides. */
@Controller('admin')
@Roles(...SHIPMENT_VIEWER_ROLES)
export class AdminPricingController {
  constructor(
    private readonly zones: ZonesService,
    private readonly pricing: PricingService,
    private readonly pickupZones: PickupZonesService,
  ) {}

  @Get('zone-kinds')
  kinds(): Promise<ZoneKindItem[]> {
    return this.zones.listKinds();
  }

  @Roles(...ZONE_MANAGER_ROLES)
  @Post('zone-kinds')
  createKind(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(createZoneKindSchema)) body: CreateZoneKindInput,
    @Meta() meta: RequestMeta,
  ): Promise<ZoneKindItem> {
    return this.zones.createKind(auth.user, body, meta);
  }

  @Roles(...ZONE_MANAGER_ROLES)
  @Patch('zone-kinds/:id')
  updateKind(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateZoneKindSchema)) body: UpdateZoneKindInput,
    @Meta() meta: RequestMeta,
  ): Promise<ZoneKindItem> {
    return this.zones.updateKind(auth.user, id, body, meta);
  }

  @Get('zones')
  allZones(): Promise<ZoneItem[]> {
    return this.zones.list({ includeInactive: true });
  }

  @Roles(...ZONE_MANAGER_ROLES)
  @Post('zones')
  createZone(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(createZoneSchema)) body: CreateZoneInput,
    @Meta() meta: RequestMeta,
  ): Promise<ZoneItem> {
    return this.zones.create(auth.user, body, meta);
  }

  @Roles(...ZONE_MANAGER_ROLES)
  @Patch('zones/:id')
  updateZone(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateZoneSchema)) body: UpdateZoneInput,
    @Meta() meta: RequestMeta,
  ): Promise<ZoneItem> {
    return this.zones.update(auth.user, id, body, meta);
  }

  @Get('pricing-rules')
  rules(
    @Query(new ZodValidationPipe(ruleListQuery)) query: z.infer<typeof ruleListQuery>,
  ): Promise<PricingRuleItem[]> {
    return this.pricing.listRules({
      merchantId: query.merchantId,
      includeInactive: query.includeInactive === 'true',
    });
  }

  @Roles(...PRICING_MANAGER_ROLES)
  @Post('pricing-rules')
  async createRule(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(createPricingRuleSchema)) body: CreatePricingRuleInput,
    @Meta() meta: RequestMeta,
  ): Promise<{ id: string }> {
    const rule = await this.pricing.createRule(auth.user, body, meta);
    return { id: rule.id };
  }

  @Roles(...PRICING_MANAGER_ROLES)
  @Post('pricing-rules/:id/revise')
  async reviseRule(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(revisePricingRuleSchema)) body: RevisePricingRuleInput,
    @Meta() meta: RequestMeta,
  ): Promise<{ id: string }> {
    const rule = await this.pricing.reviseRule(auth.user, id, body, meta);
    return { id: rule.id };
  }

  @Roles(...PRICING_MANAGER_ROLES)
  @HttpCode(204)
  @Post('pricing-rules/:id/deactivate')
  deactivateRule(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.pricing.deactivateRule(auth.user, id, meta);
  }

  @HttpCode(200)
  @Post('pricing/quote')
  quote(
    @Body(new ZodValidationPipe(adminQuoteRequestSchema)) body: AdminQuoteRequestInput,
  ): Promise<PricingQuote> {
    return this.pricing.preview(body);
  }

  @Roles(...SHIPMENT_MANAGER_ROLES)
  @HttpCode(204)
  @Put('merchants/:id/pickup-zone')
  setMerchantPickupZone(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(pickupZoneSchema)) body: PickupZoneInput,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    return this.pricing.setPickupZone(auth.user, id, body.zoneId, meta);
  }

  @Roles(...SHIPMENT_MANAGER_ROLES)
  @Get('pickup-zone-requests')
  pickupZoneRequests(): Promise<PickupZoneRequestItem[]> {
    return this.pickupZones.pending();
  }

  @Roles(...SHIPMENT_MANAGER_ROLES)
  @HttpCode(200)
  @Post('pickup-zone-requests/:id/approve')
  approvePickupZone(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(pickupZoneDecisionSchema)) body: PickupZoneDecisionInput,
    @Meta() meta: RequestMeta,
  ): Promise<PickupZoneRequestItem> {
    return this.pickupZones.decide(auth.user, id, true, body.note, meta);
  }

  @Roles(...SHIPMENT_MANAGER_ROLES)
  @HttpCode(200)
  @Post('pickup-zone-requests/:id/reject')
  rejectPickupZone(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(pickupZoneDecisionSchema)) body: PickupZoneDecisionInput,
    @Meta() meta: RequestMeta,
  ): Promise<PickupZoneRequestItem> {
    return this.pickupZones.decide(auth.user, id, false, body.note, meta);
  }

  @Roles(...FEE_OVERRIDE_ROLES)
  @HttpCode(204)
  @Post('shipments/:id/fee-override')
  async overrideFee(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(feeOverrideSchema)) body: FeeOverrideInput,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.pricing.overrideBeforeDelivery(auth.user, id, body, meta);
  }
}

/** Merchant app: quotes and requests to change the merchant's own pickup zone. */
@Controller('merchant')
@Roles('MERCHANT')
export class MerchantPricingController {
  constructor(
    private readonly pricing: PricingService,
    private readonly pickupZones: PickupZonesService,
  ) {}

  @Throttle({ default: { limit: 60, ttl: MINUTE } })
  @HttpCode(200)
  @Post('pricing/quote')
  quote(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(quoteRequestSchema)) body: QuoteRequestInput,
  ): Promise<PricingQuote> {
    return this.pricing.quoteForMerchant(auth.user, body);
  }

  @Get('pickup-zone')
  pickupZone(@Auth() auth: RequestAuth): Promise<MerchantPickupZoneState> {
    return this.pickupZones.stateFor(auth.user.id);
  }

  /** Requests a change; the approved zone keeps pricing shipments until staff approve. */
  @HttpCode(202)
  @Put('pickup-zone')
  requestPickupZone(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(pickupZoneSchema)) body: PickupZoneInput,
    @Meta() meta: RequestMeta,
  ): Promise<MerchantPickupZoneState> {
    return this.pickupZones.request(auth.user, body.zoneId, meta);
  }

  @HttpCode(200)
  @Delete('pickup-zone/request')
  withdrawPickupZone(
    @Auth() auth: RequestAuth,
    @Meta() meta: RequestMeta,
  ): Promise<MerchantPickupZoneState> {
    return this.pickupZones.withdraw(auth.user, meta);
  }
}
