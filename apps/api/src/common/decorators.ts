import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { UserRole } from '@coobra/shared';
import { Errors } from './app-exception.js';
import { requestMeta, type AppRequest, type RequestAuth } from './request.js';

export const IS_PUBLIC_KEY = 'coobra:isPublic';
export const ROLES_KEY = 'coobra:roles';
export const ALLOW_UNVERIFIED_EMAIL_KEY = 'coobra:allowUnverifiedEmail';

/** Route does not require a session. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Route requires one of the given roles. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** Route is available to signed-in users whose email is not verified yet. */
export const AllowUnverifiedEmail = () => SetMetadata(ALLOW_UNVERIFIED_EMAIL_KEY, true);

/** Injects the authenticated user/session. Only valid on non-public routes. */
export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestAuth => {
  const request = ctx.switchToHttp().getRequest<AppRequest>();
  if (!request.auth) throw Errors.unauthenticated();
  return request.auth;
});

/** Injects the real actor, the effective principal and the impersonation of the request. */
export const Acting = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<AppRequest>();
  if (!request.auth) throw Errors.unauthenticated();
  return request.auth.acting;
});

/** Injects the client IP address and user agent. */
export const Meta = createParamDecorator((_data: unknown, ctx: ExecutionContext) =>
  requestMeta(ctx.switchToHttp().getRequest<AppRequest>()),
);
