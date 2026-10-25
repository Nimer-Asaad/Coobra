import { useTranslation } from 'react-i18next';
import { useLogout, useRefreshMe, useResendVerification } from '../hooks';
import { useSessionStore } from '../state/session-store';
import { AppButton } from '../ui/button';
import { Banner } from '../ui/banner';
import { ErrorBanner } from '../ui/error-banner';
import { Screen } from '../ui/screen';
import { AppText } from '../ui/text';

/** Signed in, but the email address is not verified yet. */
export function VerifyPendingScreen() {
  const { t } = useTranslation();
  const email = useSessionStore((state) => state.user?.email ?? '');
  const resend = useResendVerification();
  const refresh = useRefreshMe();
  const logout = useLogout();

  return (
    <Screen centered>
      <AppText variant="title">{t('auth.verify.pendingTitle')}</AppText>
      <AppText>{t('auth.verify.pendingDescription', { email })}</AppText>
      {resend.isSuccess ? <Banner tone="success" message={t('auth.verify.resent')} /> : null}
      <ErrorBanner error={resend.error ?? refresh.error} />
      <AppButton
        title={t('auth.verify.checkAgain')}
        onPress={() => refresh.mutate()}
        loading={refresh.isPending}
      />
      <AppButton
        variant="outline"
        title={t('auth.verify.resend')}
        onPress={() => resend.mutate()}
        loading={resend.isPending}
      />
      <AppButton variant="link" title={t('auth.logout')} onPress={() => logout.mutate()} />
    </Screen>
  );
}
