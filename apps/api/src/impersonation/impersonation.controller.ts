import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  exchangeImpersonationSchema,
  IMPERSONATION_HEADER,
  listImpersonationsQuerySchema,
  reauthenticateSchema,
  startImpersonationSchema,
  type ExchangeImpersonationInput,
  type ImpersonationInfo,
  type ImpersonationStartResponse,
  type ListImpersonationsQuery,
  type ReauthenticateInput,
  type StartImpersonationInput,
} from '@coobra/shared';
import { Errors } from '../common/app-exception.js';
import { Auth, Meta, Public, Roles } from '../common/decorators.js';
import type { RequestAuth, RequestMeta } from '../common/request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { impersonationCookie } from './impersonation-records.js';
import { ImpersonationService } from './impersonation.service.js';

const MINUTE = 60_000;

/** Password step-up and the code exchange (ADR 0003 §8). */
@Controller('auth')
export class ImpersonationAuthController {
  constructor(
    private readonly impersonations: ImpersonationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Roles('SUPER_ADMIN')
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @Post('reauthenticate')
  @HttpCode(204)
  async reauthenticate(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(reauthenticateSchema)) body: ReauthenticateInput,
    @Req() request: Request,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.impersonations.reauthenticate(auth, body.password, request.headers.origin, meta);
  }

  /**
   * Public (the tab has no session yet) but bound to the exact app origin, the custom header
   * (which forces a CORS preflight) and a single-use code plus the verifier only the tab holds.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @Post('impersonation/exchange')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async exchange(
    @Body(new ZodValidationPipe(exchangeImpersonationSchema)) body: ExchangeImpersonationInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Meta() meta: RequestMeta,
  ): Promise<ImpersonationInfo> {
    if (request.headers[IMPERSONATION_HEADER] !== '1') throw Errors.csrfOriginRejected();
    const result = await this.impersonations.exchange(body, request.headers.origin, meta);
    const cookie = impersonationCookie(this.config);
    response.cookie(cookie.name, result.token, {
      ...cookie.options,
      expires: new Date(result.impersonation.expiresAt),
    });
    return result.impersonation;
  }
}

/** The admin console's controls (SUPER_ADMIN, ordinary admin session only). */
@Roles('SUPER_ADMIN')
@Controller('admin/impersonations')
export class AdminImpersonationController {
  constructor(private readonly impersonations: ImpersonationService) {}

  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @Post()
  @Header('Cache-Control', 'no-store')
  start(
    @Auth() auth: RequestAuth,
    @Body(new ZodValidationPipe(startImpersonationSchema)) body: StartImpersonationInput,
    @Req() request: Request,
    @Meta() meta: RequestMeta,
  ): Promise<ImpersonationStartResponse> {
    return this.impersonations.start(auth, body, request.headers.origin, meta);
  }

  @Get()
  list(
    @Query(new ZodValidationPipe(listImpersonationsQuerySchema)) query: ListImpersonationsQuery,
  ): Promise<ImpersonationInfo[]> {
    return this.impersonations.list(query.active);
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<ImpersonationInfo> {
    return this.impersonations.get(id);
  }

  @Post(':id/end')
  @HttpCode(200)
  end(
    @Auth() auth: RequestAuth,
    @Param('id') id: string,
    @Meta() meta: RequestMeta,
  ): Promise<ImpersonationInfo> {
    // Ending only removes access, so any SUPER_ADMIN may end any impersonation.
    return this.impersonations.end(id, auth.acting.actor.id, meta);
  }
}

/** The banner's End button, from inside the impersonation. */
@Controller('impersonation')
export class ImpersonationController {
  constructor(
    private readonly impersonations: ImpersonationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('end')
  @HttpCode(200)
  async end(
    @Auth() auth: RequestAuth,
    @Res({ passthrough: true }) response: Response,
    @Meta() meta: RequestMeta,
  ): Promise<ImpersonationInfo> {
    const impersonation = auth.acting.impersonation;
    if (!impersonation) throw Errors.forbidden();
    const info = await this.impersonations.end(impersonation.id, auth.acting.actor.id, meta);
    const cookie = impersonationCookie(this.config);
    response.clearCookie(cookie.name, cookie.options);
    return info;
  }
}
