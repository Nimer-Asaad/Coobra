import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { translateValidation } from '@coobra/i18n';
import { AppText } from './text';
import { colors, radius, spacing } from './theme';
import { useDirection } from './use-direction';

interface TextFieldProps extends TextInputProps {
  label: string;
  /** i18n key of the validation error. */
  error?: string;
  hint?: string;
  /** Emails and phone numbers are always entered left-to-right. */
  forceLtr?: boolean;
}

export function TextField({ label, error, hint, forceLtr, style, ...inputProps }: TextFieldProps) {
  const { t } = useTranslation();
  const { textAlign } = useDirection();
  const message = translateValidation(t, error);
  return (
    <View style={styles.container}>
      <AppText variant="label">{label}</AppText>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        style={[
          styles.input,
          { textAlign: forceLtr ? 'left' : textAlign },
          message ? styles.inputError : null,
          style,
        ]}
        {...inputProps}
      />
      {message ? (
        <AppText variant="muted" style={styles.error}>
          {message}
        </AppText>
      ) : hint ? (
        <AppText variant="muted">{hint}</AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.card,
  },
  inputError: { borderColor: colors.danger },
  error: { color: colors.danger },
});
