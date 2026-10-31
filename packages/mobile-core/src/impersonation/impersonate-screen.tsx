import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator } from 'react-native';
import type { ImpersonationInfo } from '@coobra/shared';
import { useApi } from '../api-context';
import { useMobileConfig } from '../config';
import { restoreSession } from '../root';
import { AppButton } from '../ui/button';
import { Banner } from '../ui/banner';
import { Screen } from '../ui/screen';
import { AppText } from '../ui/text';
import { colors } from '../ui/theme';
import { runTabHandoff, TabHandoffError, type TabHandoffFailure } from './handoff';
import { useImpersonationStore } from './store';

/**
 * `/impersonate`, opened by the admin console. Receives the single-use code by postMessage,
 * redeems it, and continues as the account in this tab only. Any failure leaves the tab without
 * a session and tells the admin to start again (the console ends the unused impersonation).
 */
export function ImpersonateScreen() {
  const { t } = useTranslation();
  const api = useApi();
  const { adminUrl, clientApp } = useMobileConfig();
  const [failure, setFailure] = useState<TabHandoffFailure | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (useImpersonationStore.getState().mode === 'active') {
      router.replace('/home');
      return;
    }
    const opener = typeof window !== 'undefined' ? window.opener : null;
    runTabHandoff({
      opener,
      adminOrigin: adminUrl,
      exchange: (code, codeVerifier) =>
        api.request<ImpersonationInfo>('/v1/auth/impersonation/exchange', {
          method: 'POST',
          body: { code, codeVerifier },
          impersonation: true,
        }),
    })
      .then(async (info) => {
        // From now on this tab trusts no other window.
        window.opener = null;
        useImpersonationStore.getState().activate(info);
        await restoreSession(api, clientApp);
        router.replace('/home');
      })
      .catch((error: unknown) => {
        if (typeof window !== 'undefined') window.opener = null;
        setFailure(error instanceof TabHandoffError ? error.reason : 'failed');
      });
  }, [adminUrl, api, clientApp]);

  return (
    <Screen centered>
      {failure ? (
        <>
          <Banner message={t(`impersonation.handoff.${failure}`)} />
          <AppButton
            variant="outline"
            title={t('impersonation.ended.close')}
            onPress={() => window.close()}
          />
        </>
      ) : (
        <>
          <ActivityIndicator color={colors.primary} size="large" />
          <AppText role="status" style={{ textAlign: 'center' }}>
            {t('impersonation.handoff.connecting')}
          </AppText>
        </>
      )}
    </Screen>
  );
}
