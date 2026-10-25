import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SESSION_COOKIE_NAME, type UserRole } from '@coobra/shared';
import { Errors } from '../common/app-exception.js';
import { ALLOW_UNVERIFIED_EMAIL_KEY, IS_PUBLIC_KEY, ROLES_KEY } from '../common/decorators.js';
import { readCookie, type AppRequest } from '../common/request.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { SessionService } from './session.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard: every route requires an active session unless marked @Public().
 * Then enforces email verification (unless @AllowUnverifiedEmail()) and @Roles().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<AppRequest>();
    const credential = this.extractCredential(request);
    if (!credential) throw Errors.unauthenticated();

    const auth = await this.sessions.authenticate(credential.token);
    if (!auth) throw Errors.unauthenticated();

    // Cookies are sent automatically by browsers, so state-changing cookie requests
    // must come from an allowed origin (CSRF protection on top of SameSite=Strict).
    if (credential.transport === 'cookie' && !SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      if (!origin || !this.config.corsOrigins.includes(origin)) throw Errors.csrfOriginRejected();
    }

    request.auth = { ...auth, transport: credential.transport };

    const allowUnverified = this.reflector.getAllAndOverride<boolean>(
      ALLOW_UNVERIFIED_EMAIL_KEY,
      targets,
    );
    if (!allowUnverified && !auth.user.emailVerifiedAt) throw Errors.emailNotVerified();

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, targets);
    if (roles && !roles.includes(auth.user.role)) throw Errors.forbidden();

    return true;
  }

  private extractCredential(
    request: AppRequest,
  ): { token: string; transport: 'bearer' | 'cookie' } | null {
    const header = request.headers.authorization;
    if (header) {
      const [scheme, token] = header.split(' ');
      return scheme?.toLowerCase() === 'bearer' && token ? { token, transport: 'bearer' } : null;
    }
    const cookie = readCookie(request, SESSION_COOKIE_NAME);
    return cookie ? { token: cookie, transport: 'cookie' } : null;
  }
}
