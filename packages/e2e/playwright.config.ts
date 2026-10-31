import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { E2E_PORTS, URLS } from './tests/urls';

/**
 * Browser smoke tests for the critical journeys, against the disposable coobra_e2e database
 * (recreated by prepare-db.mjs before every run). Each role signs in from its own isolated
 * browser context.
 *
 * The stack runs on its own ports (API 4100, admin 3100, merchant 8182, driver 8181 by default)
 * and its own build outputs, so it can run next to the normal dev servers without touching them:
 * the API is compiled to apps/api/.e2e-dist (not dist), the admin uses the .next-e2e build
 * folder, and the Expo apps are static web exports served from packages/e2e/.web.
 */
const { databaseUrl } = JSON.parse(
  readFileSync(new URL('./.auth/accounts.json', import.meta.url), 'utf8'),
) as { databaseUrl: string };
if (new URL(databaseUrl).pathname !== '/coobra_e2e') {
  throw new Error('The end-to-end stack only ever runs against coobra_e2e');
}

const webDir = (app: string) => fileURLToPath(new URL(`./.web/${app}`, import.meta.url));
const env = (extra: Record<string, string>) =>
  ({ ...process.env, CI: '1', ...extra }) as Record<string, string>;
const apiEnv = env({
  DATABASE_URL: databaseUrl,
  API_PORT: String(E2E_PORTS.api),
  NODE_ENV: 'development',
  CORS_ORIGINS: [URLS.admin, URLS.merchant, URLS.driver].join(','),
  ADMIN_WEB_URL: URLS.admin,
  MERCHANT_APP_URL: URLS.merchant,
  DRIVER_APP_URL: URLS.driver,
  COOKIE_SECURE: 'false',
  MAIL_TRANSPORT: 'log',
  // Everything the API needs is set here, so CI (which has no .env) runs the same stack.
  MAIL_FROM: 'COOBRA E2E <e2e@coobra.test>',
  // Impersonated writes are enabled only in this isolated stack (never in development): a
  // random signing key per run, held only by this process and the API it starts.
  IMPERSONATION_WRITES_ENABLED: 'true',
  CONSEQUENCE_SIGNING_KEYS: `e2e:${randomBytes(32).toString('base64url')}`,
  CONSEQUENCE_SIGNING_ACTIVE_KEY: 'e2e',
});
const expoApp = (app: 'merchant' | 'driver') => ({
  command:
    `pnpm --filter @coobra/${app}-app exec expo export --platform web --output-dir "${webDir(app)}"` +
    ` && node packages/e2e/serve-web.mjs "${webDir(app)}" ${E2E_PORTS[app]}`,
  cwd: '../..',
  url: URLS[app],
  env: env({ EXPO_PUBLIC_API_URL: URLS.api, EXPO_PUBLIC_ADMIN_WEB_URL: URLS.admin }),
  reuseExistingServer: false,
  timeout: 300_000,
});

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  // The journeys share one database and run in order.
  workers: 1,
  fullyParallel: false,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Optional: an installed browser (e.g. E2E_BROWSER_CHANNEL=chrome) instead of Playwright's own
    // download; it still starts with a fresh, temporary profile.
    ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}),
  },
  webServer: [
    {
      command:
        'pnpm --filter @coobra/api exec tsc -p tsconfig.build.json --outDir .e2e-dist' +
        ' && node apps/api/.e2e-dist/main.js',
      cwd: '../..',
      url: `${URLS.api}/v1/auth/me`,
      env: apiEnv,
      reuseExistingServer: false,
      timeout: 240_000,
    },
    {
      command: `pnpm --filter @coobra/admin-web exec next dev --port ${E2E_PORTS.admin}`,
      cwd: '../..',
      url: `${URLS.admin}/login`,
      env: env({
        API_URL: URLS.api,
        NEXT_DIST_DIR: '.next-e2e',
        MERCHANT_APP_URL: URLS.merchant,
        DRIVER_APP_URL: URLS.driver,
      }),
      reuseExistingServer: false,
      timeout: 240_000,
    },
    expoApp('merchant'),
    expoApp('driver'),
  ],
});
