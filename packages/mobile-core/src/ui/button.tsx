import { useId } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { AppText } from './text';
import { colors, radius, spacing } from './theme';

interface AppButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'outline' | 'link';
  loading?: boolean;
  disabled?: boolean;
  /** Disables the button and says why, next to it (also read by screen readers). */
  disabledReason?: string;
  testID?: string;
}

export function AppButton({
  title,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  disabledReason,
  testID,
}: AppButtonProps) {
  const reasonId = useId();
  const inactive = disabled || loading || Boolean(disabledReason);
  const button = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      // aria-* (not accessibilityState) so busy/disabled also reach the web build.
      aria-disabled={Boolean(inactive)}
      aria-busy={Boolean(loading)}
      aria-describedby={disabledReason ? reasonId : undefined}
      onPress={onPress}
      disabled={inactive}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        pressed && !inactive && styles.pressed,
        inactive && styles.disabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.primaryText : colors.primary} />
      ) : (
        <Text
          style={[styles.text, variant === 'primary' ? styles.primaryText : styles.secondaryText]}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
  if (!disabledReason) return button;
  return (
    <View style={styles.group}>
      {button}
      <AppText variant="muted" nativeID={reasonId} testID={testID ? `${testID}-reason` : undefined}>
        {disabledReason}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  primary: { backgroundColor: colors.primary },
  outline: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  link: { minHeight: 40 },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.5 },
  text: { fontSize: 16, fontWeight: '600' },
  primaryText: { color: colors.primaryText },
  secondaryText: { color: colors.primary },
  group: { gap: spacing.xs },
});
