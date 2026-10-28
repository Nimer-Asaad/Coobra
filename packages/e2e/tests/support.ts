import { readFileSync } from 'node:fs';
import {
  expect,
  request as playwrightRequest,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { createPrismaClient } from '@coobra/database';

export const URLS = {
  api: 'http://localhost:4000',
  admin: 'http://localhost:3000',
  merchant: 'http://localhost:8082',
  driver: 'http://localhost:8081',
};

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

/** A fresh, isolated browser context per role (separate cookies and storage). */
export async function signInAdmin(browser: Browser, name: AccountName): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${URLS.admin}/login`);
  await chooseEnglishOnFirstVisit(page, page.locator('input[name="email"]'));
  await page.locator('input[name="email"]').fill(accounts[name].email);
  await page.locator('input[name="password"]').fill(accounts[name].password);
  await page.locator('input[name="password"]').press('Enter');
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
  await page.getByRole('button', { name: 'Sign in' }).click();
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
  if (login.status() === 429) {
    const wait = Number(login.headers()['retry-after'] ?? 60);
    await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
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
