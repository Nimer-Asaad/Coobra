/**
 * The admin console's Content Security Policy (a fresh nonce per request, set in proxy.ts).
 *
 * - Scripts: only Next.js's own, carrying the nonce ('strict-dynamic' lets them load their
 *   chunks); no inline or third-party script runs. Development adds 'unsafe-eval' (React's
 *   debugging needs it; production does not).
 * - Network: the browser only talks to this origin (the BFF); the API is called server-side.
 * - Styles: same-origin stylesheets and inline styles ('unsafe-inline': React style attributes
 *   cannot carry a nonce; styles cannot run code).
 * - No framing, no plugins, forms only to this origin.
 * The impersonation hand-off is unaffected: window.open and postMessage are not governed by CSP,
 * and the console never needs to connect to the merchant or driver app.
 */
export function contentSecurityPolicy(nonce: string, development: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    // Development: the hot-reload websocket.
    `connect-src 'self'${development ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // HTTPS only in production (development and the isolated E2E stack use plain HTTP).
    ...(development ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}
