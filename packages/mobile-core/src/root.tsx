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
import { ImpersonationBanner } from './impersonation/banner';
import { ImpersonationEndedScreen } from './impersonation/ended-screen';
import { isHandoffTab, useImpersonationStore } from './impersonation/store';
import { useLanguageStore } from './state/language-store';
import { useSessionStore } from './state/session-store';
import { usesCookieSessions } from './storage';
import { AppButton } from './ui/button';
import { AppText } from './ui/text';
import { colors, spacing } from './ui/theme';

/** The impersonated account's own session (only ever through the impersonation cookie). */
async function restoreImpersonation(
  api: ApiClient,
  clientApp: MobileAppConfig['clientApp'],
): Promise<void> {
  const store = useSessionStore.getState();
  const impersonation = useImpersonationStore.getState();
  try {
    const me = await api.request<MeResponse>('/v1/auth/me');
    if (!me.impersonation || me.impersonation.endedAt || me.session.clientApp !== clientApp) {
      impersonation.end(me.impersonation?.endedReason ?? 'LOST');
      store.setStatus('signedOut');
      return;
    }
    impersonation.update(me.impersonation);
    // The app's language stays local during an impersonation (preferences are not changed);
    // without a choice in this browser, the account's language is used for this tab only.
    if (!useLanguageStore.getState().language) {
      useLanguageStore.getState().setForThisTab(me.user.language);
    }
    await store.signIn(me.user);
  } catch (error) {
    if (error instanceof NetworkError) store.setStatus('offline');
    else {
      impersonation.end('LOST');
      store.setStatus('signedOut');
    }
  }
}

export async function restoreSession(
  api: ApiClient,
  clientApp: MobileAppConfig['clientApp'],
): Promise<void> {
  const store = useSessionStore.getState();
  const { mode } = useImpersonationStore.getState();
  // An ended impersonation tab, and the tab the console opened for a hand-off, never load the
  // browser's real session.
  if (mode === 'ended' || (mode === 'none' && isHandoffTab())) {
    store.setStatus('signedOut');
    return;
  }
  if (mode === 'active') {
    await restoreImpersonation(api, clientApp);
    return;
  }
  const token = await store.loadToken();
  if (!usesCookieSessions && !token) {
    store.setStatus('signedOut');
    return;
  }
  try {
    const { user, session } = await api.request<MeResponse>('/v1/auth/me');
    // On web every COOBRA app shares the API's cookie, so another app's session may be
    // present (e.g. a merchant signed in on the same browser). Never adopt it here.
    if (session.clientApp !== clientApp) {
      await store.signOut();
      return;
    }
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
  const impersonationMode = useImpersonationStore((state) => state.mode);

  const api = useMemo(
    () =>
      createApiClient({
        apiUrl: config.apiUrl,
        getToken: () => useSessionStore.getState().token,
        onUnauthenticated: () => void useSessionStore.getState().signOut(),
        isImpersonating: () => useImpersonationStore.getState().mode === 'active',
        onImpersonationLost: () => useImpersonationStore.getState().end('LOST'),
      }),
    [config.apiUrl],
  );
  const [i18n] = useState(() => createI18n('en', [initReactI18next]));

  useEffect(() => {
    if (language && i18n.language !== language) void i18n.changeLanguage(language);
  }, [i18n, language]);

  const retry = useCallback(() => {
    useSessionStore.getState().setStatus('unknown');
    void restoreSession(api, config.clientApp);
  }, [api, config.clientApp]);

  useEffect(() => {
    void useLanguageStore.getState().hydrate();
    void restoreSession(api, config.clientApp);
  }, [api, config.clientApp]);

  useEffect(() => {
    if (impersonationMode !== 'ended') return;
    // Nothing the impersonated account could see stays in memory.
    queryClient.clear();
    void useSessionStore.getState().signOut();
  }, [impersonationMode, queryClient]);

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
                ) : impersonationMode === 'ended' ? (
                  <ImpersonationEndedScreen />
                ) : impersonationMode === 'active' && status === 'signedIn' ? (
                  <View style={styles.root}>
                    <ImpersonationBanner />
                    <View style={styles.root}>{children}</View>
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
