import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { SUPPORTED_LANGUAGES } from '@coobra/shared';
import { useChangeLanguage, useLogout } from '../hooks';
import { useLanguageStore } from '../state/language-store';
import { useSessionStore } from '../state/session-store';
import { AppButton } from '../ui/button';
import { Banner } from '../ui/banner';
import { ErrorBanner } from '../ui/error-banner';
import { Screen } from '../ui/screen';
import { AppText } from '../ui/text';
import { spacing } from '../ui/theme';

export function SettingsScreen() {
  const { t } = useTranslation();
  const { language, restartRequired } = useLanguageStore();
  const email = useSessionStore((state) => state.user?.email);
  const changeLanguage = useChangeLanguage();
  const logout = useLogout();

  return (
    <Screen>
      <AppText variant="title">{t('settings.title')}</AppText>
      <View style={styles.section}>
        <AppText variant="subtitle">{t('language.label')}</AppText>
        {SUPPORTED_LANGUAGES.map((option) => (
          <AppButton
            key={option}
            variant={option === language ? 'primary' : 'outline'}
            title={option === 'ar' ? t('language.arabic') : t('language.english')}
            disabled={changeLanguage.isPending}
            onPress={() => changeLanguage.mutate(option)}
          />
        ))}
        {restartRequired ? <Banner tone="info" message={t('language.restartNotice')} /> : null}
        <ErrorBanner error={changeLanguage.error} />
      </View>
      <View style={styles.section}>
        <AppText variant="subtitle">{t('settings.account')}</AppText>
        {email ? <AppText variant="muted">{email}</AppText> : null}
        <AppButton
          variant="outline"
          title={t('auth.logout')}
          onPress={() => logout.mutate()}
          loading={logout.isPending}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
});
