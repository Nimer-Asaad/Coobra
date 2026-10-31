import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IMPERSONATION_COOKIE_NAME,
  IMPERSONATION_HEADER,
  IMPERSONATION_SECURE_COOKIE_NAME,
  impersonationRoutePolicy,
  SESSION_COOKIE_NAME,
  type UserRole,
} from '@coobra/shared';
import { Errors } from '../common/app-exception.js';
import { ALLOW_UNVERIFIED_EMAIL_KEY, IS_PUBLIC_KEY, ROLES_KEY } from '../common/decorators.js';
import { readCookie, type AppRequest } from '../common/request.js';
import { selfActing } from '../common/acting-context.js';
import { appOriginFor } from '../impersonation/impersonation-records.js';
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
    if (request.headers[IMPERSONATION_HEADER] !== undefined) {
      await this.authenticateImpersonation(request);
      return this.authorize(request, targets);
    }
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

    // An ordinary session: the person acts as themselves.
    request.auth = { ...auth, transport: credential.transport, acting: selfActing(auth.user) };
    return this.authorize(request, targets);
  }

  /** Email verification and @Roles, for ordinary and impersonated requests alike. */
  private authorize(
    request: AppRequest,
    targets: Parameters<Reflector['getAllAndOverride']>[1],
  ): boolean {
    const auth = request.auth!;

    const allowUnverified = this.reflector.getAllAndOverride<boolean>(
      ALLOW_UNVERIFIED_EMAIL_KEY,
      targets,
    );
    if (!allowUnverified && !auth.user.emailVerifiedAt) throw Errors.emailNotVerified();

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, targets);
    if (roles && !roles.includes(auth.user.role)) throw Errors.forbidden();

    return true;
  }

  /**
   * An impersonated request (ADR 0003 §8): only with the impersonation header, only from the
   * exact origin of the target's app (for every method), only with the separate impersonation
   * cookie and never a bearer token, and only to a route classified ALLOWED. Deny by default:
   * SAFEGUARDED writes stay forbidden until Phase 4C.4, and staff routes are forbidden.
   */
  private async authenticateImpersonation(request: AppRequest): Promise<void> {
    // ADR 0003 R4: refused outright when the deployment does not qualify (fail closed).
    if (!this.config.impersonation.enabled) throw Errors.unauthenticated();
    if (request.headers[IMPERSONATION_HEADER] !== '1' || request.headers.authorization) {
      throw Errors.unauthenticated();
    }
    const name = this.config.session.cookieSecure
      ? IMPERSONATION_SECURE_COOKIE_NAME
      : IMPERSONATION_COOKIE_NAME;
    const token = readCookie(request, name);
    if (!token) throw Errors.unauthenticated();
    const auth = await this.sessions.authenticateImpersonation(token);
    if (!auth) throw Errors.unauthenticated();
    const expectedOrigin = appOriginFor(
      this.config,
      auth.impersonation.clientApp as 'MERCHANT_APP' | 'DRIVER_APP',
    );
    if (request.headers.origin !== expectedOrigin) throw Errors.csrfOriginRejected();

    const { impersonation, user, session } = auth;
    request.auth = {
      user,
      session,
      transport: 'cookie',
      acting: {
        actor: { id: impersonation.actorUserId, role: 'SUPER_ADMIN' },
        principal: { id: user.id, role: user.role },
        impersonation: {
          id: impersonation.id,
          actorSessionId: impersonation.actorSessionId,
          expiresAt: impersonation.expiresAt,
        },
      },
    };

    const route = (request as { route?: { path?: string } }).route?.path;
    const policy = impersonationRoutePolicy(`${request.method} ${route ?? ''}`);
    // SAFEGUARDED writes pass only when impersonated writes are enabled (Phase 4C.4); the
    // service then applies the per-transition policy, reason and confirmation.
    const permitted =
      policy.access === 'ALLOWED' ||
      (policy.access === 'SAFEGUARDED' && this.config.impersonationWrites.enabled);
    if (!permitted) throw Errors.impersonationForbiddenAction();
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
