import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy } from '@/lib/content-security-policy';

/**
 * A per-request CSP nonce. Next.js reads the policy from the request headers and adds the nonce
 * to its own scripts; every page is rendered per request (the root layout reads the language
 * cookie), so each response gets a fresh nonce.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const policy = contentSecurityPolicy(nonce, process.env.NODE_ENV === 'development');
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the BFF (JSON), static files or prefetches.
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
