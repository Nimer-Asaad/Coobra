import { NextResponse } from 'next/server';
import { apiFetch, getSessionToken } from '@/lib/api-server';
import { ADMIN_SESSION_COOKIE } from '@/lib/constants';
import { isSameOriginRequest } from '@/lib/same-origin';

/** Revokes the API session and clears the cookie. */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { statusCode: 403, code: 'CSRF_ORIGIN_REJECTED', message: 'Cross-site request rejected' },
      { status: 403 },
    );
  }
  const token = await getSessionToken();
  if (token) {
    await apiFetch('/v1/auth/logout', { method: 'POST', token }).catch(() => undefined);
  }
  const response = new NextResponse(null, { status: 204 });
  response.cookies.delete(ADMIN_SESSION_COOKIE);
  return response;
}
