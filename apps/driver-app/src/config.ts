import type { MobileAppConfig } from '@coobra/mobile-core';

const apiUrl = process.env.EXPO_PUBLIC_API_URL;
if (!apiUrl) {
  throw new Error('EXPO_PUBLIC_API_URL is not set. Copy .env.example to .env.');
}

export const appConfig: MobileAppConfig = {
  apiUrl: apiUrl.replace(/\/+$/, ''),
  clientApp: 'DRIVER_APP',
  allowRegistration: false,
  appNameKey: 'apps.driver',
};
