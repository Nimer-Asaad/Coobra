import { useTranslation } from 'react-i18next';
import { AppButton } from '../ui/button';
import { Screen } from '../ui/screen';
import { AppText } from '../ui/text';
import { useImpersonationStore } from './store';

function closeTab() {
  // Allowed for a tab opened by the console; otherwise the button simply does nothing.
  if (typeof window !== 'undefined') window.close();
}

/**
 * What an impersonation tab shows once the impersonation is over, even after a reload. It never
 * falls back to a real session; signing in is a separate, explicit step.
 */
export function ImpersonationEndedScreen() {
  const { t } = useTranslation();
  const reason = useImpersonationStore((state) => state.endedReason);
  return (
    <Screen centered>
      <AppText variant="title" role="heading">
        {t('impersonation.ended.title')}
      </AppText>
      <AppText testID="impersonation-ended-reason">
        {t(`impersonation.ended.reasons.${reason ?? 'LOST'}`)}
      </AppText>
      <AppText variant="muted">{t('impersonation.ended.body')}</AppText>
      <AppButton title={t('impersonation.ended.close')} onPress={closeTab} />
      <AppButton
        variant="link"
        title={t('impersonation.ended.signIn')}
        onPress={() => {
          useImpersonationStore.getState().clear();
          if (typeof window !== 'undefined') window.location.assign('/login');
        }}
        testID="impersonation-ended-sign-in"
      />
    </Screen>
  );
}
