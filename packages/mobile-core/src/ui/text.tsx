import { StyleSheet, Text, type TextProps } from 'react-native';
import { colors } from './theme';
import { useDirection } from './use-direction';

type Variant = 'title' | 'subtitle' | 'body' | 'muted' | 'label';

export function AppText({ variant = 'body', style, ...props }: TextProps & { variant?: Variant }) {
  const { textAlign, direction } = useDirection();
  return (
    <Text
      style={[styles.base, styles[variant], { textAlign, writingDirection: direction }, style]}
      {...props}
    />
  );
}

const styles = StyleSheet.create({
  base: { color: colors.text, fontSize: 16 },
  title: { fontSize: 24, fontWeight: '700' },
  subtitle: { fontSize: 18, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 22 },
  muted: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  label: { fontSize: 14, fontWeight: '600' },
});
