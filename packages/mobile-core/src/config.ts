import { createContext, useContext } from 'react';
import type { ClientApp } from '@coobra/shared';

export interface MobileAppConfig {
  /** Base URL of the COOBRA API, e.g. http://192.168.1.10:4000 */
  apiUrl: string;
  clientApp: Extract<ClientApp, 'DRIVER_APP' | 'MERCHANT_APP'>;
  /** Only the merchant app offers public self-registration. */
  allowRegistration: boolean;
  /** i18n key of the app title, e.g. `apps.driver`. */
  appNameKey: string;
}

export const MobileConfigContext = createContext<MobileAppConfig | null>(null);

export function useMobileConfig(): MobileAppConfig {
  const config = useContext(MobileConfigContext);
  if (!config) throw new Error('useMobileConfig must be used inside <CoobraRoot>');
  return config;
}
