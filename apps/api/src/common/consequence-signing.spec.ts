import { randomBytes } from 'node:crypto';
import { consequenceSigningKeys, loadConfig } from '../config/env.js';
import { canonicalJson, ConsequenceSigner } from './consequence-signing.js';

const secret = () => randomBytes(32).toString('base64url');
const base = {
  DATABASE_URL: 'postgresql://unused',
  ADMIN_WEB_URL: 'http://localhost:3000',
  MERCHANT_APP_URL: 'http://localhost:8082',
  DRIVER_APP_URL: 'http://localhost:8081',
  MAIL_FROM: 'test@example.com',
};

describe('impersonated writes configuration', () => {
  it('is off by default in every environment, even with keys', () => {
    for (const NODE_ENV of ['development', 'test', 'production'] as const) {
      const config = loadConfig({
        ...base,
        NODE_ENV,
        COOKIE_SECURE: 'true',
        CONSEQUENCE_SIGNING_KEYS: `k1:${secret()}`,
        CONSEQUENCE_SIGNING_ACTIVE_KEY: 'k1',
      });
      expect(config.impersonationWrites.enabled).toBe(false);
      expect(config.impersonationWrites.signing).toBeNull();
    }
  });

  it('turns on only when enabled with a valid key ring (and fails closed otherwise)', () => {
    const enabled = loadConfig({
      ...base,
      IMPERSONATION_WRITES_ENABLED: 'true',
      CONSEQUENCE_SIGNING_KEYS: `k1:${secret()}`,
      CONSEQUENCE_SIGNING_ACTIVE_KEY: 'k1',
    });
    expect(enabled.impersonationWrites.enabled).toBe(true);
    const missing = loadConfig({ ...base, IMPERSONATION_WRITES_ENABLED: 'true' });
    expect(missing.impersonationWrites.enabled).toBe(false);
    expect(missing.impersonationWrites.problems.join('; ')).toMatch(/CONSEQUENCE_SIGNING_KEYS/);
  });

  it('rejects short, malformed, duplicated and missing active keys without echoing them', () => {
    const short = randomBytes(16).toString('base64url');
    const cases: [string | undefined, string | undefined, RegExp][] = [
      [`k1:${short}`, 'k1', /shorter than 32 bytes/],
      ['k1', 'k1', /not <kid>:<base64url secret>/],
      [`k1:${secret()},k1:${secret()}`, 'k1', /repeats key id k1/],
      [`k1:${secret()}`, 'k2', /ACTIVE_KEY is not one of the keys/],
      [`k1:${secret()}`, undefined, /ACTIVE_KEY is not set/],
    ];
    for (const [raw, active, problem] of cases) {
      const result = consequenceSigningKeys(raw, active);
      expect(result.signing).toBeNull();
      expect(result.problems.join('; ')).toMatch(problem);
      if (raw) expect(result.problems.join('; ')).not.toContain(raw.split(':')[1] ?? '\0');
    }
  });
});

describe('ConsequenceSigner', () => {
  const k1 = Buffer.from(secret(), 'base64url');
  const k2 = Buffer.from(secret(), 'base64url');
  const now = new Date('2026-10-30T10:00:00Z');
  const later = new Date('2026-10-30T10:05:00Z');
  const data = { action: 'TRANSITION:A->B', binding: { version: 3 }, lines: [] };

  it('signs canonical data that verifies until it expires', () => {
    const signer = new ConsequenceSigner({ activeKid: 'k1', keys: new Map([['k1', k1]]) });
    const token = signer.sign(data, later);
    expect(token.startsWith('v1.k1.')).toBe(true);
    expect(canonicalJson(signer.verify(token, now)!.data)).toBe(canonicalJson(data));
    expect(signer.verify(token, later)).toBeNull();
  });

  it('refuses a tampered, foreign or unknown-key token', () => {
    const signer = new ConsequenceSigner({ activeKid: 'k1', keys: new Map([['k1', k1]]) });
    const token = signer.sign(data, later);
    const [v, kid, payload, mac] = token.split('.') as [string, string, string, string];
    const forged = Buffer.from(
      JSON.stringify({
        data: { ...data, binding: { version: 4 } },
        expiresAt: later.toISOString(),
      }),
    ).toString('base64url');
    expect(signer.verify(`${v}.${kid}.${forged}.${mac}`, now)).toBeNull();
    expect(signer.verify(`${v}.${kid}.${payload}.${mac.slice(0, -2)}AA`, now)).toBeNull();
    expect(signer.verify(`${v}.k9.${payload}.${mac}`, now)).toBeNull();
    const other = new ConsequenceSigner({ activeKid: 'k2', keys: new Map([['k2', k2]]) });
    expect(other.verify(token, now)).toBeNull();
    expect(signer.verify('not-a-token', now)).toBeNull();
  });

  it('keeps verifying tokens of a retired key during rotation', () => {
    const before = new ConsequenceSigner({ activeKid: 'k1', keys: new Map([['k1', k1]]) });
    const token = before.sign(data, later);
    const rotated = new ConsequenceSigner({
      activeKid: 'k2',
      keys: new Map([
        ['k1', k1],
        ['k2', k2],
      ]),
    });
    expect(rotated.verify(token, now)).not.toBeNull();
    expect(rotated.sign(data, later).startsWith('v1.k2.')).toBe(true);
  });

  it('produces the same bytes for the same data whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
  });
});
