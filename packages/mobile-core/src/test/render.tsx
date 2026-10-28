import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { createI18n } from '@coobra/i18n';
import type { Language } from '@coobra/shared';
import { MobileConfigContext, type MobileAppConfig } from '../config';
import { useLanguageStore } from '../state/language-store';

const merchantConfig: MobileAppConfig = {
  apiUrl: 'http://localhost:4000',
  clientApp: 'MERCHANT_APP',
  allowRegistration: true,
  appNameKey: 'apps.merchant',
};

/** Renders a shared component with real translations, React Query and the app config. */
export function renderMobile(
  ui: ReactElement,
  {
    language = 'en',
    config = merchantConfig,
  }: { language?: Language; config?: MobileAppConfig } = {},
) {
  useLanguageStore.setState({ language });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={createI18n(language, [initReactI18next])}>
        <MobileConfigContext.Provider value={config}>{ui}</MobileConfigContext.Provider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}
