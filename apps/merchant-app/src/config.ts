import type { MobileAppConfig } from '@coobra/mobile-core';

const apiUrl = process.env.EXPO_PUBLIC_API_URL;
if (!apiUrl) {
  throw new Error('EXPO_PUBLIC_API_URL is not set. Copy .env.example to .env.');
}

/**
 * The admin console's exact origin: the only window that may hand this app an impersonation
 * (ADR 0003 §8.3). Local development defaults to the console's usual address.
 */
const adminWebUrl =
  process.env.EXPO_PUBLIC_ADMIN_WEB_URL ?? (__DEV__ ? 'http://localhost:3000' : undefined);

export const appConfig: MobileAppConfig = {
  apiUrl: apiUrl.replace(/\/+$/, ''),
  clientApp: 'MERCHANT_APP',
  allowRegistration: true,
  appNameKey: 'apps.merchant',
  adminUrl: adminWebUrl ? new URL(adminWebUrl).origin : undefined,
};
