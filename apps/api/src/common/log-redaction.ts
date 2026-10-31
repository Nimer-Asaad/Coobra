/*
 * Secrets must never reach the logs (ADR 0003, Phase 4C.3 security gate). Raw passwords, codes,
 * verifiers, session tokens and cookies are never passed to the database or to a logger, but an
 * error can still carry sensitive material: a Prisma error message prints the arguments of the
 * failing query (password hashes, token and code hashes), and an HTTP error can echo headers.
 * Every error the API logs passes through `redactForLog` first.
 */

const REDACTED = '[redacted]';

const PATTERNS: [RegExp, string][] = [
  // Argon2 password hashes.
  [/\$argon2(?:id|i|d)\$[^\s"'`,}]+/g, REDACTED],
  // SHA-256 hex digests (session token, auth token and exchange code hashes).
  [/\b[0-9a-f]{64}\b/gi, REDACTED],
  // Authorization header values.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // Cookie headers and session/impersonation cookie values.
  [/\b(coobra_session|coobra_imp_session|__Host-coobra_imp_session)=[^;\s"']+/g, `$1=${REDACTED}`],
  [/(\bcookie["']?\s*[:=]\s*["']?)[^"'\n]+/gi, `$1${REDACTED}`],
  // Fields that hold secrets, in JSON or object-literal form.
  [
    /(["']?(?:password|passwordHash|token|tokenHash|code|codeHash|codeVerifier|verifier|confirmationToken)["']?\s*[:=]\s*)["'][^"']*["']/gi,
    `$1"${REDACTED}"`,
  ],
  // Long opaque base64url tokens (generated tokens and codes are 43 characters).
  [/\b[A-Za-z0-9_-]{40,}\b/g, REDACTED],
];

export function redactForLog(value: unknown): string {
  let text: string;
  if (value instanceof Error) text = value.stack ?? `${value.name}: ${value.message}`;
  else if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  return text;
}
