import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useMobileConfig } from '../config';
import { useChangeLanguage } from '../hooks';
import { useLanguageStore } from '../state/language-store';
import { AppButton } from '../ui/button';
import { AppText } from '../ui/text';
import { colors } from '../ui/theme';

/** Brand header with a one-tap language toggle (used on auth screens). */
export function AuthHeader() {
  const { t } = useTranslation();
  const { appNameKey } = useMobileConfig();
  const language = useLanguageStore((state) => state.language);
  const changeLanguage = useChangeLanguage();
  const target = language === 'ar' ? 'en' : 'ar';

  return (
    <View style={styles.row}>
      <View style={styles.brand}>
        <AppText variant="title" style={styles.logo}>
          {t('common.appName')}
        </AppText>
        <AppText variant="muted">{t(appNameKey)}</AppText>
      </View>
      <AppButton
        variant="link"
        title={target === 'ar' ? t('language.arabic') : t('language.english')}
        onPress={() => changeLanguage.mutate(target)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { flexShrink: 1 },
  logo: { color: colors.primary },
});
