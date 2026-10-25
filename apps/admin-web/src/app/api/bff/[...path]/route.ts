import { NextResponse } from 'next/server';
import { apiFetch, getSessionToken } from '@/lib/api-server';
import { isSameOriginRequest } from '@/lib/same-origin';

/**
 * API paths the browser may reach through the proxy. Session creation (login/register)
 * is deliberately excluded so the session token is never returned to browser JavaScript.
 */
const ALLOWED_PREFIXES = [
  'v1/auth/me',
  'v1/auth/forgot-password',
  'v1/auth/reset-password',
  'v1/auth/verify-email',
  'v1/auth/resend-verification',
  'v1/me/',
  'v1/admin/',
];

function isAllowedPath(path: string[]): boolean {
  if (path.some((segment) => segment === '..' || segment === '.' || segment === '')) return false;
  const joined = path.join('/');
  return ALLOWED_PREFIXES.some((prefix) =>
    prefix.endsWith('/') ? joined.startsWith(prefix) : joined === prefix,
  );
}

/**
 * Backend-for-frontend proxy: forwards `/api/bff/v1/...` to the API, attaching the
 * session token from the httpOnly cookie. The API performs all authorization.
 */
async function proxy(request: Request, context: RouteContext<'/api/bff/[...path]'>) {
  if (request.method !== 'GET' && !isSameOriginRequest(request)) {
    return NextResponse.json(
      { statusCode: 403, code: 'CSRF_ORIGIN_REJECTED', message: 'Cross-site request rejected' },
      { status: 403 },
    );
  }
  const { path } = await context.params;
  if (!isAllowedPath(path)) {
    return NextResponse.json(
      { statusCode: 404, code: 'NOT_FOUND', message: 'Not found' },
      { status: 404 },
    );
  }

  const search = new URL(request.url).search;
  const body = request.method === 'GET' ? undefined : await request.text();
  const upstream = await apiFetch(`/${path.map(encodeURIComponent).join('/')}${search}`, {
    method: request.method,
    token: await getSessionToken(),
    body: body || undefined,
  });

  return new NextResponse(upstream.status === 204 ? null : await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
