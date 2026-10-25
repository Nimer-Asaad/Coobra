import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createI18n } from '@coobra/i18n';
import { directionOf, type MeResponse } from '@coobra/shared';
import { createApiClient, NetworkError, type ApiClient } from './api-client';
import { ApiContext } from './api-context';
import { MobileConfigContext, type MobileAppConfig } from './config';
import { useLanguageStore } from './state/language-store';
import { useSessionStore } from './state/session-store';
import { usesCookieSessions } from './storage';
import { AppButton } from './ui/button';
import { AppText } from './ui/text';
import { colors, spacing } from './ui/theme';

async function restoreSession(api: ApiClient): Promise<void> {
  const store = useSessionStore.getState();
  const token = await store.loadToken();
  if (!usesCookieSessions && !token) {
    store.setStatus('signedOut');
    return;
  }
  try {
    const { user } = await api.request<MeResponse>('/v1/auth/me');
    await store.signIn(user, token ?? undefined);
  } catch (error) {
    if (error instanceof NetworkError) store.setStatus('offline');
    else await store.signOut();
  }
}

/**
 * Root of both mobile apps: providers, language + session hydration, and the
 * layout direction (RTL for Arabic, LTR for English).
 */
export function CoobraRoot({ config, children }: { config: MobileAppConfig; children: ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } }),
  );
  const language = useLanguageStore((state) => state.language);
  const languageHydrated = useLanguageStore((state) => state.hydrated);
  const status = useSessionStore((state) => state.status);

  const api = useMemo(
    () =>
      createApiClient({
        apiUrl: config.apiUrl,
        getToken: () => useSessionStore.getState().token,
        onUnauthenticated: () => void useSessionStore.getState().signOut(),
      }),
    [config.apiUrl],
  );
  const [i18n] = useState(() => createI18n('en', [initReactI18next]));

  useEffect(() => {
    if (language && i18n.language !== language) void i18n.changeLanguage(language);
  }, [i18n, language]);

  const retry = useCallback(() => {
    useSessionStore.getState().setStatus('unknown');
    void restoreSession(api);
  }, [api]);

  useEffect(() => {
    void useLanguageStore.getState().hydrate();
    void restoreSession(api);
  }, [api]);

  const ready = languageHydrated && status !== 'unknown';

  return (
    <SafeAreaProvider>
      <MobileConfigContext.Provider value={config}>
        <ApiContext.Provider value={api}>
          <QueryClientProvider client={queryClient}>
            <I18nextProvider i18n={i18n}>
              <View style={[styles.root, { direction: directionOf(language ?? 'en') }]}>
                {!ready ? (
                  <View style={styles.center}>
                    <ActivityIndicator color={colors.primary} size="large" />
                  </View>
                ) : status === 'offline' ? (
                  <View style={[styles.center, styles.offline]}>
                    <AppText>{i18n.t('errors.NETWORK')}</AppText>
                    <AppButton title={i18n.t('common.retry')} onPress={retry} />
                  </View>
                ) : (
                  children
                )}
              </View>
            </I18nextProvider>
          </QueryClientProvider>
        </ApiContext.Provider>
      </MobileConfigContext.Provider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  offline: { gap: spacing.lg, padding: spacing.xl },
});
