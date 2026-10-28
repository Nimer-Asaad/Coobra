import { readFileSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

/**
 * Browser smoke tests for the critical journeys, against the full local stack and the
 * disposable coobra_e2e database (recreated by prepare-db.mjs before every run). Each role
 * signs in from its own isolated browser context. The default dev ports are used, so stop the
 * dev servers first; the servers here are always started fresh against coobra_e2e.
 */
const { databaseUrl } = JSON.parse(
  readFileSync(new URL('./.auth/accounts.json', import.meta.url), 'utf8'),
) as { databaseUrl: string };

const ci = { ...process.env, CI: '1' } as Record<string, string>;

export default defineConfig({
  testDir: './tests',
  // The journeys share one database and run in order.
  workers: 1,
  fullyParallel: false,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    {
      command: 'pnpm --filter @coobra/api build && pnpm --filter @coobra/api start',
      cwd: '../..',
      url: 'http://localhost:4000/v1/auth/me',
      env: { ...ci, DATABASE_URL: databaseUrl },
      reuseExistingServer: false,
      timeout: 240_000,
    },
    {
      command: 'pnpm --filter @coobra/admin-web dev',
      cwd: '../..',
      url: 'http://localhost:3000/login',
      env: ci,
      reuseExistingServer: false,
      timeout: 240_000,
    },
    {
      command: 'pnpm --filter @coobra/merchant-app web',
      cwd: '../..',
      url: 'http://localhost:8082',
      env: ci,
      reuseExistingServer: false,
      timeout: 240_000,
    },
    {
      command: 'pnpm --filter @coobra/driver-app web',
      cwd: '../..',
      url: 'http://localhost:8081',
      env: ci,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
