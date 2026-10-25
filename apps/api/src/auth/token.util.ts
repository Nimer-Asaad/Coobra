import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random token, URL-safe. Sent to the client exactly once and never stored. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are high-entropy, so a fast SHA-256 digest is sufficient for storage lookups. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
