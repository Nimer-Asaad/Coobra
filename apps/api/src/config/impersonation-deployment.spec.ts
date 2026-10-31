import { impersonationDeployment, loadConfig } from './env.js';

/** ADR 0003 R4: production impersonation fails closed unless the deployment qualifies. */
const production = {
  NODE_ENV: 'production',
  COOKIE_SECURE: true,
  IMPERSONATION_SITE: 'coobra.ps',
  API_PUBLIC_URL: 'https://api.coobra.ps',
  ADMIN_WEB_URL: 'https://admin.coobra.ps',
  MERCHANT_APP_URL: 'https://merchant.coobra.ps',
  DRIVER_APP_URL: 'https://driver.coobra.ps',
};

describe('impersonation deployment check (R4)', () => {
  it('leaves local development and tests on http://localhost untouched', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(
        impersonationDeployment({
          NODE_ENV,
          COOKIE_SECURE: false,
          ADMIN_WEB_URL: 'http://localhost:3000',
          MERCHANT_APP_URL: 'http://localhost:8082',
          DRIVER_APP_URL: 'http://localhost:8081',
        }),
      ).toEqual({ enabled: true, problems: [] });
    }
  });

  it('enables a production deployment on HTTPS hosts of the approved site', () => {
    expect(impersonationDeployment(production)).toEqual({ enabled: true, problems: [] });
    expect(
      impersonationDeployment({ ...production, API_PUBLIC_URL: 'https://coobra.ps' }).enabled,
    ).toBe(true);
  });

  it('fails closed in production for every unqualified setting', () => {
    const cases: [Partial<typeof production>, RegExp][] = [
      [{ COOKIE_SECURE: false }, /COOKIE_SECURE/],
      [{ IMPERSONATION_SITE: undefined }, /IMPERSONATION_SITE is not set/],
      [{ IMPERSONATION_SITE: 'localhost' }, /IMPERSONATION_SITE must be a domain/],
      [{ IMPERSONATION_SITE: '10.0.0.1' }, /IMPERSONATION_SITE must be a domain/],
      [{ API_PUBLIC_URL: undefined }, /API_PUBLIC_URL is not set/],
      [{ MERCHANT_APP_URL: 'http://merchant.coobra.ps' }, /MERCHANT_APP_URL must use https/],
      [{ DRIVER_APP_URL: 'https://driver.other-site.com' }, /DRIVER_APP_URL must be on coobra.ps/],
      // A look-alike suffix is another site.
      [{ ADMIN_WEB_URL: 'https://admin.evilcoobra.ps' }, /ADMIN_WEB_URL must be on coobra.ps/],
      [{ API_PUBLIC_URL: 'https://localhost' }, /API_PUBLIC_URL must use a domain name/],
      [{ API_PUBLIC_URL: 'https://192.168.1.10' }, /API_PUBLIC_URL must use a domain name/],
    ];
    for (const [change, problem] of cases) {
      const result = impersonationDeployment({ ...production, ...change });
      expect(result.enabled, String(problem)).toBe(false);
      expect(result.problems.join('; ')).toMatch(problem);
    }
  });

  it('is part of the loaded configuration', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://unused',
      ADMIN_WEB_URL: 'http://localhost:3000',
      MERCHANT_APP_URL: 'http://localhost:8082',
      DRIVER_APP_URL: 'http://localhost:8081',
      MAIL_FROM: 'test@example.com',
    });
    expect(config.impersonation).toEqual({ enabled: true, problems: [] });
  });
});
