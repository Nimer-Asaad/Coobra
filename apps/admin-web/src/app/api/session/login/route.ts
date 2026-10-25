import { NextResponse } from 'next/server';
import { loginSchema, toFieldErrors, type LoginResponse } from '@coobra/shared';
import { apiFetch, readApiError } from '@/lib/api-server';
import { ADMIN_SESSION_COOKIE } from '@/lib/constants';
import { isSameOriginRequest } from '@/lib/same-origin';

/** Signs in through the API and stores the session token in an httpOnly cookie. */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { statusCode: 403, code: 'CSRF_ORIGIN_REJECTED', message: 'Cross-site request rejected' },
      { status: 403 },
    );
  }

  const raw: unknown = await request.json().catch(() => null);
  // The admin console can only open ADMIN_WEB sessions, whatever the client sends.
  const parsed = loginSchema.safeParse({ ...(raw as object), clientApp: 'ADMIN_WEB' });
  if (!parsed.success) {
    return NextResponse.json(
      {
        statusCode: 400,
        code: 'VALIDATION_FAILED',
        message: 'Validation failed',
        fieldErrors: toFieldErrors(parsed.error),
      },
      { status: 400 },
    );
  }

  const userAgent = request.headers.get('user-agent');
  const apiResponse = await apiFetch('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify(parsed.data),
    headers: userAgent ? { 'user-agent': userAgent } : undefined,
  });
  if (!apiResponse.ok) {
    return NextResponse.json(await readApiError(apiResponse), { status: apiResponse.status });
  }

  const { token, ...session } = (await apiResponse.json()) as LoginResponse;
  if (!token) {
    return NextResponse.json(
      { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Missing session token' },
      { status: 500 },
    );
  }
  const response = NextResponse.json(session);
  response.cookies.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    expires: new Date(session.session.expiresAt),
  });
  return response;
}
