import { loadConfig } from './env.js';

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
      }),
    ).not.toThrow();
  });
});
