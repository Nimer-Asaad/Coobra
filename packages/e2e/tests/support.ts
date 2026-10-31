import { readFileSync } from 'node:fs';
import {
  expect,
  request as playwrightRequest,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { createPrismaClient } from '@coobra/database';
import { URLS } from './urls';

export { URLS };

type AccountName =
  | 'admin'
  | 'accountant'
  | 'accountant2'
  | 'ops'
  | 'viewer'
  | 'merchant'
  | 'driver';
interface Account {
  id: string;
  email: string;
  password: string;
}
const seed = JSON.parse(
  readFileSync(new URL('../.auth/accounts.json', import.meta.url), 'utf8'),
) as {
  databaseUrl: string;
  zones: { ramallah: string };
  accounts: Record<AccountName, Account>;
};
export const accounts = seed.accounts;
export const zones = seed.zones;

/** Direct access to coobra_e2e, only to verify journal entries and balances. */
export const db = createPrismaClient({ connectionString: seed.databaseUrl });

/** Signed balance of a ledger account in its normal direction ("0.00" when unused). */
export async function balance(code: string): Promise<string> {
  const account = await db.financialAccount.findUnique({ where: { code } });
  if (!account) return '0.00';
  const lines = await db.journalLine.findMany({ where: { accountId: account.id } });
  const debitNormal = account.type === 'ASSET' || account.type === 'EXPENSE';
  let cents = 0n;
  for (const line of lines) {
    const amount = BigInt(line.amount.toFixed(2).replace('.', ''));
    cents += (line.side === 'DEBIT') === debitNormal ? amount : -amount;
  }
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

export async function expectBalancedLedger() {
  const lines = await db.journalLine.findMany();
  const sum = (side: 'DEBIT' | 'CREDIT') =>
    lines
      .filter((line) => line.side === side)
      .reduce((total, line) => total + BigInt(line.amount.toFixed(2).replace('.', '')), 0n);
  expect(sum('DEBIT')).toBe(sum('CREDIT'));
}

/** A new browser context has no language yet: both web apps ask for one first. */
async function chooseEnglishOnFirstVisit(page: Page, ready: Locator) {
  const english = page.getByRole('button', { name: 'English', exact: true });
  await expect(english.or(ready).first()).toBeVisible();
  if (await english.isVisible()) await english.click();
  await expect(ready).toBeVisible();
}

/** Sign-ins are rate limited (10 a minute per client) and a full run signs in more often. */
const RATE_LIMIT_WAIT_MS = 61_000;
/** Never wait longer than this for a Retry-After, whatever the server says. */
const RATE_LIMIT_MAX_WAIT_MS = 65_000;

/**
 * Submits the admin login form on the current page and returns the HTTP status of the sign-in.
 * Only a 429 is waited out and retried, once; any other status is returned as it is, so an
 * unexpected failure (wrong password, disabled account, server error) is never masked.
 */
export async function submitAdminLogin(page: Page, name: AccountName): Promise<number> {
  const submit = async () => {
    await page.locator('input[name="email"]').fill(accounts[name].email);
    await page.locator('input[name="password"]').fill(accounts[name].password);
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith('/api/session/login') && res.request().method() === 'POST',
      ),
      page.locator('input[name="password"]').press('Enter'),
    ]);
    return response.status();
  };
  const status = await submit();
  if (status !== 429) return status;
  await page.waitForTimeout(RATE_LIMIT_WAIT_MS);
  return submit();
}

/** A fresh, isolated browser context per role (separate cookies and storage). */
export async function signInAdmin(browser: Browser, name: AccountName): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${URLS.admin}/login`);
  await chooseEnglishOnFirstVisit(page, page.locator('input[name="email"]'));
  expect(await submitAdminLogin(page, name), `sign-in of ${name}`).toBe(200);
  await page.waitForURL(/\/dashboard/);
  return page;
}

export async function signInMobile(
  browser: Browser,
  app: 'merchant' | 'driver',
  name: AccountName,
): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${URLS[app]}/login`);
  const email = page.getByLabel('Email', { exact: true });
  await chooseEnglishOnFirstVisit(page, email);
  await email.fill(accounts[name].email);
  await page.getByLabel('Password', { exact: true }).fill(accounts[name].password);
  // Same rule as the admin sign-in: only a 429 is waited out and retried, once.
  const submit = async () => {
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().endsWith('/v1/auth/login') && res.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ]);
    return response.status();
  };
  let status = await submit();
  if (status === 429) {
    await page.waitForTimeout(RATE_LIMIT_WAIT_MS);
    status = await submit();
  }
  expect(status, `sign-in of ${name}`).toBe(200);
  await page.waitForURL(/\/home/);
  return page;
}

/** API calls for set-up steps that are not the journey under test. */
export async function apiAs(
  name: AccountName,
  clientApp: 'ADMIN_WEB' | 'MERCHANT_APP' | 'DRIVER_APP',
) {
  const anonymous = await playwrightRequest.newContext({ baseURL: URLS.api });
  const data = { email: accounts[name].email, password: accounts[name].password, clientApp };
  let login = await anonymous.post('/v1/auth/login', { data });
  // Logins are rate limited per client (10 a minute); the whole run signs in more often.
  // Only a 429 is retried, once, after at most RATE_LIMIT_MAX_WAIT_MS.
  if (login.status() === 429) {
    const wait = (Number(login.headers()['retry-after']) || 60) * 1000 + 1000;
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, RATE_LIMIT_MAX_WAIT_MS)));
    login = await anonymous.post('/v1/auth/login', { data });
  }
  expect(login.status(), await login.text()).toBe(200);
  const { token } = (await login.json()) as { token: string };
  await anonymous.dispose();
  return playwrightRequest.newContext({
    baseURL: URLS.api,
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
}
