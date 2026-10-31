import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  AUTH_TRANSPORT_HEADER,
  forgotPasswordSchema,
  loginSchema,
  registerMerchantSchema,
  resetPasswordSchema,
  SESSION_COOKIE_NAME,
  verifyEmailSchema,
  type ForgotPasswordInput,
  type LoginInput,
  type LoginResponse,
  type MeResponse,
  type MessageResponse,
  type RegisterMerchantInput,
  type ResetPasswordInput,
  type VerifyEmailInput,
} from '@coobra/shared';
import { AllowUnverifiedEmail, Auth, Meta, Public } from '../common/decorators.js';
import type { RequestAuth, RequestMeta } from '../common/request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { CLOCK, type Clock } from '../common/clock.js';
import {
  endImpersonationIn,
  impersonationCookie,
  loadImpersonationInfo,
} from '../impersonation/impersonation-records.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toAuthUser } from '../users/user.mapper.js';
import { AuthService, type AuthResult } from './auth.service.js';

const MINUTE = 60_000;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: MINUTE } })
  @Post('register')
  async register(
    @Body(new ZodValidationPipe(registerMerchantSchema)) body: RegisterMerchantInput,
    @Meta() meta: RequestMeta,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    return this.respondWithSession(await this.auth.registerMerchant(body, meta), request, response);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Meta() meta: RequestMeta,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    return this.respondWithSession(await this.auth.login(body, meta), request, response);
  }

  @AllowUnverifiedEmail()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Auth() auth: RequestAuth,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const impersonation = auth.acting.impersonation;
    if (impersonation) {
      // Signing out of an impersonation ends it; the account's own sessions are untouched.
      await this.prisma.client.$transaction((tx) =>
        endImpersonationIn(tx, {
          impersonationId: impersonation.id,
          reason: 'MANUAL',
          now: this.clock.now(),
          endedById: auth.acting.actor.id,
          meta,
        }),
      );
      const cookie = impersonationCookie(this.config);
      response.clearCookie(cookie.name, cookie.options);
      return;
    }
    await this.auth.logout(auth.user.id, auth.session.id, meta);
    if (auth.transport === 'cookie')
      response.clearCookie(SESSION_COOKIE_NAME, this.cookieOptions());
  }

  @AllowUnverifiedEmail()
  @Get('me')
  async me(@Auth() auth: RequestAuth): Promise<MeResponse> {
    const impersonation = auth.acting.impersonation
      ? await loadImpersonationInfo(
          this.prisma.client,
          auth.acting.impersonation.id,
          this.clock.now(),
          this.config,
        )
      : null;
    return {
      ...(impersonation ? { impersonation } : {}),
      user: toAuthUser(auth.user),
      session: {
        id: auth.session.id,
        clientApp: auth.session.clientApp,
        expiresAt: auth.session.expiresAt.toISOString(),
      },
    };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: MINUTE } })
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(
    @Body(new ZodValidationPipe(forgotPasswordSchema)) body: ForgotPasswordInput,
    @Meta() meta: RequestMeta,
  ): Promise<MessageResponse> {
    await this.auth.requestPasswordReset(body, meta);
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordInput,
    @Meta() meta: RequestMeta,
  ): Promise<MessageResponse> {
    await this.auth.resetPassword(body, meta);
    return { ok: true };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailSchema)) body: VerifyEmailInput,
    @Meta() meta: RequestMeta,
  ): Promise<MessageResponse> {
    await this.auth.verifyEmail(body, meta);
    return { ok: true };
  }

  @AllowUnverifiedEmail()
  @Throttle({ default: { limit: 3, ttl: MINUTE } })
  @Post('resend-verification')
  @HttpCode(202)
  async resendVerification(@Auth() auth: RequestAuth): Promise<MessageResponse> {
    await this.auth.resendVerification(auth.user);
    return { ok: true };
  }

  /**
   * Browser clients send `x-auth-transport: cookie` to receive the session token as an
   * httpOnly cookie that JavaScript cannot read. Other clients receive it in the body.
   */
  private respondWithSession(
    result: AuthResult,
    request: Request,
    response: Response,
  ): LoginResponse {
    const body: LoginResponse = {
      user: toAuthUser(result.user),
      session: {
        id: result.session.id,
        clientApp: result.session.clientApp,
        expiresAt: result.session.expiresAt.toISOString(),
      },
    };
    if (request.headers[AUTH_TRANSPORT_HEADER] === 'cookie') {
      response.cookie(SESSION_COOKIE_NAME, result.token, {
        ...this.cookieOptions(),
        expires: result.session.expiresAt,
      });
      return body;
    }
    return { ...body, token: result.token };
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.session.cookieSecure,
      sameSite: 'strict' as const,
      path: '/',
    };
  }
}
