import { loadConfig, startupDiagnostics } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  ADMIN_WEB_URL: 'http://localhost:3000',
  MERCHANT_APP_URL: 'http://localhost:8082',
  DRIVER_APP_URL: 'http://localhost:8081',
  MAIL_FROM: 'COOBRA <no-reply@example.com>',
  CORS_ORIGINS: 'http://localhost:3000, http://localhost:8081',
};

describe('loadConfig', () => {
  it('parses a development configuration', () => {
    const config = loadConfig(base);
    expect(config.corsOrigins).toEqual(['http://localhost:3000', 'http://localhost:8081']);
    expect(config.session.adminTtlMs).toBe(12 * 60 * 60 * 1000);
    expect(config.rateLimitEnabled).toBe(true);
  });

  it('lists every missing variable', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*ADMIN_WEB_URL/);
  });

  it('refuses insecure cookies and console mail in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', MAIL_TRANSPORT: 'log' })).toThrow(
      /COOKIE_SECURE[\s\S]*MAIL_TRANSPORT/,
    );
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        MAIL_TRANSPORT: 'smtp',
        TRUST_PROXY: '1',
      }),
    ).not.toThrow();
  });

  it('requires an explicit proxy count and rate limiting in production', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      MAIL_TRANSPORT: 'smtp',
    };
    // Never guessed: missing is refused, while an explicit 0 (no proxy) is accepted.
    expect(() => loadConfig(production)).toThrow(/TRUST_PROXY: must be set in production/);
    expect(loadConfig({ ...production, TRUST_PROXY: '0' }).trustProxy).toBe(0);
    expect(() =>
      loadConfig({ ...production, TRUST_PROXY: '2', RATE_LIMIT_ENABLED: 'false' }),
    ).toThrow(/RATE_LIMIT_ENABLED: must be true in production/);
    // Development keeps working without them.
    expect(loadConfig(base).trustProxy).toBe(0);
    expect(loadConfig({ ...base, RATE_LIMIT_ENABLED: 'false' }).rateLimitEnabled).toBe(false);
  });
});

describe('startupDiagnostics', () => {
  it('summarises the security switches and says why impersonation is off', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      MAIL_TRANSPORT: 'smtp',
      TRUST_PROXY: '1',
      IMPERSONATION_WRITES_ENABLED: 'true',
      CONSEQUENCE_SIGNING_KEYS: 'k1:' + 'a'.repeat(43),
      CONSEQUENCE_SIGNING_ACTIVE_KEY: 'k1',
    });
    const lines = startupDiagnostics(config);
    expect(lines[0]).toEqual({
      level: 'log',
      message:
        'Security: rate limiting on, trusted proxies 1, impersonation off, impersonated writes off',
    });
    expect(lines.slice(1).map((line) => line.level)).toEqual(['error', 'error']);
    expect(lines[1]!.message).toMatch(/^Impersonation is disabled: .*IMPERSONATION_SITE/);
    expect(lines[2]!.message).toMatch(/^Impersonated writes were requested but are disabled/);
    // Setting names only, never key material.
    expect(JSON.stringify(lines)).not.toContain('a'.repeat(43));
  });

  it('stays quiet about writes that were never requested', () => {
    const lines = startupDiagnostics(loadConfig(base));
    expect(lines).toEqual([
      {
        level: 'log',
        message:
          'Security: rate limiting on, trusted proxies 0, impersonation on, impersonated writes off',
      },
    ]);
  });
});
