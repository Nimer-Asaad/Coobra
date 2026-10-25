/**
 * CSRF defence for the BFF routes: state-changing requests must come from this site.
 * Browsers always send `Origin` on cross-origin and same-origin POST/PATCH/DELETE requests.
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
