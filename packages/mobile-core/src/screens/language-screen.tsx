import { StyleSheet, View } from 'react-native';
import { SUPPORTED_LANGUAGES, type Language } from '@coobra/shared';
import { useChangeLanguage } from '../hooks';
import { AppButton } from '../ui/button';
import { Screen } from '../ui/screen';
import { AppText } from '../ui/text';
import { colors, spacing } from '../ui/theme';

const LABELS: Record<Language, string> = { ar: 'العربية', en: 'English' };

/** First launch: shown before any authentication screen. Text is intentionally bilingual. */
export function LanguageScreen({ onChosen }: { onChosen: () => void }) {
  const changeLanguage = useChangeLanguage();

  return (
    <Screen centered>
      <View style={styles.header}>
        <AppText variant="title" style={styles.center}>
          COOBRA
        </AppText>
        <AppText variant="subtitle" style={styles.center}>
          اختر لغتك
        </AppText>
        <AppText variant="subtitle" style={styles.center}>
          Choose your language
        </AppText>
      </View>
      {SUPPORTED_LANGUAGES.map((language) => (
        <AppButton
          key={language}
          variant="outline"
          title={LABELS[language]}
          disabled={changeLanguage.isPending}
          testID={`language-${language}`}
          onPress={() => changeLanguage.mutate(language, { onSuccess: onChosen })}
        />
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.sm, marginBottom: spacing.lg },
  center: { textAlign: 'center', color: colors.text },
});
