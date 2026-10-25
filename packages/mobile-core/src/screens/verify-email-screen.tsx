import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useVerifyEmail } from '../hooks';
import { useSessionStore } from '../state/session-store';
import { AppButton } from '../ui/button';
import { Banner } from '../ui/banner';
import { ErrorBanner } from '../ui/error-banner';
import { Screen } from '../ui/screen';
import { AppText } from '../ui/text';

/** Opened from the verification email link. */
export function VerifyEmailScreen({ token }: { token: string | undefined }) {
  const { t } = useTranslation();
  const verify = useVerifyEmail();
  const signedIn = useSessionStore((state) => state.status === 'signedIn');
  const { mutate } = verify;
  const submitted = useRef(false);

  useEffect(() => {
    // Tokens are single-use; never submit twice.
    if (token && !submitted.current) {
      submitted.current = true;
      mutate(token);
    }
  }, [token, mutate]);

  return (
    <Screen centered>
      <AppText variant="title">{t('auth.verify.title')}</AppText>
      {!token ? (
        <Banner message={t('auth.verify.missingToken')} />
      ) : verify.isError ? (
        <ErrorBanner error={verify.error} />
      ) : verify.isSuccess ? (
        <Banner tone="success" message={t('auth.verify.success')} />
      ) : (
        <AppText variant="muted">{t('auth.verify.verifying')}</AppText>
      )}
      <AppButton
        variant="outline"
        title={signedIn ? t('common.continue') : t('auth.reset.goToLogin')}
        onPress={() => router.replace(signedIn ? '/home' : '/login')}
      />
    </Screen>
  );
}
