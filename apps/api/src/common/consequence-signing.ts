import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * R2 confirmation tokens (ADR 0003 §10.3): `v1.<kid>.<payload>.<mac>`, where the payload is the
 * base64url of canonical JSON and the MAC is HMAC-SHA256 over `v1.<kid>.<payload>` with the key
 * named by `kid`. Several keys may verify (rotation); only the active one signs. Key material is
 * never logged, printed or returned.
 */

export type Canonical =
  | string
  | number
  | boolean
  | null
  | Canonical[]
  | { [key: string]: Canonical };

/** JSON with object keys sorted at every level, so equal data always gives equal bytes. */
export function canonicalJson(value: Canonical): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface SignedConsequence {
  /** What the confirmation covers; compared with the recomputed value at write time. */
  data: Canonical;
  /** ISO time after which the token is refused. */
  expiresAt: string;
}

export class ConsequenceSigner {
  constructor(private readonly ring: { activeKid: string; keys: Map<string, Buffer> }) {}

  private mac(kid: string, body: string): Buffer | null {
    const key = this.ring.keys.get(kid);
    return key ? createHmac('sha256', key).update(body).digest() : null;
  }

  sign(data: Canonical, expiresAt: Date): string {
    const kid = this.ring.activeKid;
    const payload = Buffer.from(
      canonicalJson({ data, expiresAt: expiresAt.toISOString() }),
    ).toString('base64url');
    const body = `v1.${kid}.${payload}`;
    return `${body}.${this.mac(kid, body)!.toString('base64url')}`;
  }

  /** The signed content, or null when the token is malformed, unsigned by a known key or expired. */
  verify(token: string, now: Date): SignedConsequence | null {
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const [version, kid, payload, mac] = parts as [string, string, string, string];
    const expected = this.mac(kid, `${version}.${kid}.${payload}`);
    if (!expected) return null;
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let parsed: SignedConsequence;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SignedConsequence;
    } catch {
      return null;
    }
    if (typeof parsed.expiresAt !== 'string' || Date.parse(parsed.expiresAt) <= now.getTime()) {
      return null;
    }
    return parsed;
  }
}
