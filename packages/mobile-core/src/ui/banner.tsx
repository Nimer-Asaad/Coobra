import { StyleSheet, View } from 'react-native';
import { AppText } from './text';
import { colors, radius, spacing } from './theme';

export function Banner({
  message,
  tone = 'error',
}: {
  message: string;
  tone?: 'error' | 'success' | 'info';
}) {
  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.base,
        tone === 'error' ? styles.error : tone === 'success' ? styles.success : styles.info,
      ]}
    >
      <AppText
        style={{
          color:
            tone === 'error' ? colors.danger : tone === 'success' ? colors.success : colors.text,
        }}
      >
        {message}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.md, padding: spacing.md, borderWidth: 1 },
  error: { backgroundColor: colors.dangerBackground, borderColor: '#fecaca' },
  success: { backgroundColor: colors.successBackground, borderColor: '#a7f3d0' },
  info: { backgroundColor: colors.card, borderColor: colors.border },
});
