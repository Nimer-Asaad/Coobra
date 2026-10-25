'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { createI18n } from '@coobra/i18n';
import type { Language } from '@coobra/shared';

export function Providers({ language, children }: { language: Language; children: ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } }),
  );
  const i18n = useMemo(() => createI18n(language, [initReactI18next]), [language]);

  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </QueryClientProvider>
  );
}
