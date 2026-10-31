import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from './content-security-policy';

const directives = (policy: string) =>
  Object.fromEntries(
    policy.split('; ').map((part) => {
      const [name, ...values] = part.split(' ');
      return [name, values.join(' ')];
    }),
  );

describe('contentSecurityPolicy', () => {
  it('allows only nonce-carrying scripts and same-origin connections in production', () => {
    const csp = directives(contentSecurityPolicy('abc123', false));
    expect(csp['script-src']).toBe("'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp['connect-src']).toBe("'self'");
    expect(csp['frame-ancestors']).toBe("'none'");
    expect(csp['object-src']).toBe("'none'");
    expect(csp['form-action']).toBe("'self'");
    expect('upgrade-insecure-requests' in csp).toBe(true);
    expect(JSON.stringify(csp)).not.toMatch(/unsafe-eval|\*/);
  });

  it('adds only what development needs', () => {
    const csp = directives(contentSecurityPolicy('abc123', true));
    expect(csp['script-src']).toBe("'self' 'nonce-abc123' 'strict-dynamic' 'unsafe-eval'");
    expect(csp['connect-src']).toBe("'self' ws: wss:");
    expect('upgrade-insecure-requests' in csp).toBe(false);
  });
});
