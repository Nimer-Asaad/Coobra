import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ErrorCode } from '@coobra/shared';
import { AppException } from '../common/app-exception.js';
import { ALLOW_UNVERIFIED_EMAIL_KEY, IS_PUBLIC_KEY, ROLES_KEY } from '../common/decorators.js';
import { loadConfig } from '../config/env.js';
import { AuthGuard } from './auth.guard.js';
import type { SessionService } from './session.service.js';

const config = loadConfig({
  DATABASE_URL: 'postgresql://unused',
  ADMIN_WEB_URL: 'http://localhost:3000',
  MERCHANT_APP_URL: 'http://localhost:8082',
  DRIVER_APP_URL: 'http://localhost:8081',
  MAIL_FROM: 'test@example.com',
  CORS_ORIGINS: 'http://localhost:3000',
});

function setup(options: {
  metadata?: Record<string, unknown>;
  headers?: Record<string, string>;
  method?: string;
  user?: { role: string; emailVerifiedAt: Date | null } | null;
}) {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockImplementation(
    (key: unknown) => options.metadata?.[key as string],
  );
  const authenticate = vi.fn().mockResolvedValue(
    options.user === null
      ? null
      : {
          session: { id: 's1' },
          user: options.user ?? { role: 'MERCHANT', emailVerifiedAt: new Date() },
        },
  );
  const guard = new AuthGuard(reflector, { authenticate } as unknown as SessionService, config);
  const request = { method: options.method ?? 'GET', headers: options.headers ?? {} } as Record<
    string,
    unknown
  >;
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { guard, context, request, authenticate };
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof AppException && error.code === code,
  );
}

describe('AuthGuard', () => {
  it('lets public routes through without touching the database', async () => {
    const { guard, context, authenticate } = setup({ metadata: { [IS_PUBLIC_KEY]: true } });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('rejects requests without credentials', async () => {
    await expectCode(setup({}).guard.canActivate(setup({}).context), 'UNAUTHENTICATED');
  });

  it('rejects unknown or expired sessions', async () => {
    const { guard, context } = setup({ headers: { authorization: 'Bearer abc' }, user: null });
    await expectCode(guard.canActivate(context), 'UNAUTHENTICATED');
  });

  it('attaches the session for a valid bearer token', async () => {
    const { guard, context, request } = setup({ headers: { authorization: 'Bearer abc' } });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.auth).toMatchObject({ transport: 'bearer' });
  });

  it('blocks unverified emails unless the route allows it', async () => {
    const user = { role: 'MERCHANT', emailVerifiedAt: null };
    const headers = { authorization: 'Bearer abc' };
    const blocked = setup({ headers, user });
    await expectCode(blocked.guard.canActivate(blocked.context), 'AUTH_EMAIL_NOT_VERIFIED');
    const allowed = setup({ headers, user, metadata: { [ALLOW_UNVERIFIED_EMAIL_KEY]: true } });
    await expect(allowed.guard.canActivate(allowed.context)).resolves.toBe(true);
  });

  it('enforces roles', async () => {
    const { guard, context } = setup({
      headers: { authorization: 'Bearer abc' },
      metadata: { [ROLES_KEY]: ['SUPER_ADMIN'] },
    });
    await expectCode(guard.canActivate(context), 'FORBIDDEN');
  });

  it('requires an allowed Origin for state-changing cookie requests', async () => {
    const cookie = { cookie: 'coobra_session=abc' };
    const noOrigin = setup({ method: 'POST', headers: cookie });
    await expectCode(noOrigin.guard.canActivate(noOrigin.context), 'CSRF_ORIGIN_REJECTED');
    const evil = setup({ method: 'POST', headers: { ...cookie, origin: 'https://evil.example' } });
    await expectCode(evil.guard.canActivate(evil.context), 'CSRF_ORIGIN_REJECTED');
    const ok = setup({ method: 'POST', headers: { ...cookie, origin: 'http://localhost:3000' } });
    await expect(ok.guard.canActivate(ok.context)).resolves.toBe(true);
    const read = setup({ method: 'GET', headers: cookie });
    await expect(read.guard.canActivate(read.context)).resolves.toBe(true);
  });
});
