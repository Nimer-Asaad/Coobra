import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import type { ShipmentHistoryEntry, ShipmentListItem, ShipmentStatus } from '@coobra/shared';
import { translateValidation } from '@coobra/i18n';
import { AppText } from '../ui/text';
import { colors, radius, spacing } from '../ui/theme';
import { useDirection } from '../ui/use-direction';
import { formatDateTime, formatMoney, zoneText } from './format';

const STATUS_COLORS: Record<ShipmentStatus, { background: string; text: string }> = {
  CREATED: { background: '#f1f5f9', text: '#1e293b' },
  ASSIGNED: { background: '#e0f2fe', text: '#0c4a6e' },
  PICKED_UP: { background: '#e0e7ff', text: '#312e81' },
  OUT_FOR_DELIVERY: { background: '#fef3c7', text: '#78350f' },
  DELIVERED: { background: '#d1fae5', text: '#064e3b' },
  DELIVERY_FAILED: { background: '#fee2e2', text: '#7f1d1d' },
  RETURN_REQUESTED: { background: '#ffedd5', text: '#7c2d12' },
  RETURNED: { background: '#e4e4e7', text: '#27272a' },
  CANCELLED: { background: '#f4f4f5', text: '#71717a' },
};

export function StatusBadge({ status }: { status: ShipmentStatus }) {
  const { t } = useTranslation();
  const color = STATUS_COLORS[status];
  return (
    <View style={[styles.badge, { backgroundColor: color.background }]}>
      <AppText style={[styles.badgeText, { color: color.text }]}>
        {t(`shipmentStatus.${status}`)}
      </AppText>
    </View>
  );
}

/** Horizontal row. The root view's layout direction already starts rows on the right in RTL. */
export function Row({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function ShipmentCard({
  shipment,
  onPress,
}: {
  shipment: ShipmentListItem;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const { language } = useDirection();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      testID={`shipment-${shipment.trackingNumber}`}
    >
      <Row>
        <AppText style={styles.tracking}>{shipment.trackingNumber}</AppText>
        <StatusBadge status={shipment.status} />
      </Row>
      <AppText variant="subtitle">{shipment.recipientName}</AppText>
      <AppText variant="muted">
        {zoneText(shipment.destination, language) ?? t(`governorates.${shipment.governorate}`)}
        {shipment.destination ? '' : ` — ${shipment.city}`}
      </AppText>
      <Row>
        <AppText variant="muted">{formatDateTime(shipment.createdAt, language)}</AppText>
        <AppText style={styles.amount}>{formatMoney(shipment.codAmount, language)}</AppText>
      </Row>
    </Pressable>
  );
}

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      {title ? <AppText variant="subtitle">{title}</AppText> : null}
      {children}
    </View>
  );
}

export function InfoRow({ label, value, ltr }: { label: string; value: ReactNode; ltr?: boolean }) {
  return (
    <View style={styles.info}>
      <AppText variant="muted">{label}</AppText>
      {typeof value === 'string' || typeof value === 'number' ? (
        <AppText style={ltr ? styles.ltr : undefined}>{value}</AppText>
      ) : (
        value
      )}
    </View>
  );
}

export function Timeline({ history }: { history: ShipmentHistoryEntry[] }) {
  const { t } = useTranslation();
  const { language } = useDirection();
  return (
    <View style={styles.timeline}>
      {[...history].reverse().map((entry) => (
        <View key={entry.id} style={styles.timelineEntry}>
          <Row style={styles.timelineHeader}>
            <StatusBadge status={entry.toStatus} />
            <AppText variant="muted">{formatDateTime(entry.createdAt, language)}</AppText>
          </Row>
          {entry.driver ? (
            <AppText variant="muted">
              {t('shipments.details.assignedTo', { name: entry.driver.fullName })}
            </AppText>
          ) : null}
          {entry.actor ? (
            <AppText variant="muted">
              {t('shipments.details.by', { name: entry.actor.fullName })} (
              {t(`roles.${entry.actor.role}`)})
            </AppText>
          ) : null}
          {entry.note ? <AppText style={styles.note}>{entry.note}</AppText> : null}
        </View>
      ))}
    </View>
  );
}

/** Horizontal, scrollable single-choice chips (e.g. status filter). */
export function ChipBar<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chips}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={[styles.chip, selected && styles.chipSelected]}
          >
            <AppText style={[styles.chipText, selected && styles.chipTextSelected]}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** A tap-to-open list of options; no native picker dependency, works the same on web. */
export function ChoiceField<T extends string>({
  label,
  placeholder,
  options,
  value,
  onChange,
  error,
  testID,
  searchPlaceholder,
}: {
  label: string;
  placeholder: string;
  options: { value: T; label: string }[];
  value: T | '';
  onChange: (value: T) => void;
  error?: string;
  testID?: string;
  /** Shows a filter box when the list is open (for long lists such as zones). */
  searchPlaceholder?: string;
}) {
  const { t } = useTranslation();
  const { textAlign } = useDirection();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const selected = options.find((option) => option.value === value);
  const needle = filter.trim().toLowerCase();
  const visible = (
    needle ? options.filter((option) => option.label.toLowerCase().includes(needle)) : options
  ).slice(0, 50);
  const message = translateValidation(t, error);
  return (
    <View style={styles.field}>
      <AppText variant="label">{label}</AppText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => setOpen((current) => !current)}
        style={[styles.select, message ? styles.selectError : null]}
        testID={testID}
      >
        <AppText style={selected ? undefined : styles.placeholder}>
          {selected?.label ?? placeholder}
        </AppText>
      </Pressable>
      {open ? (
        <View style={styles.options}>
          {searchPlaceholder ? (
            <TextInput
              value={filter}
              onChangeText={setFilter}
              placeholder={searchPlaceholder}
              placeholderTextColor={colors.muted}
              accessibilityLabel={searchPlaceholder}
              style={[styles.search, { textAlign }]}
              autoCorrect={false}
              testID={testID ? `${testID}-search` : undefined}
            />
          ) : null}
          {visible.map((option) => (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              onPress={() => {
                onChange(option.value);
                setOpen(false);
                setFilter('');
              }}
              style={({ pressed }) => [
                styles.option,
                option.value === value && styles.optionSelected,
                pressed && styles.pressed,
              ]}
            >
              <AppText>{option.label}</AppText>
            </Pressable>
          ))}
        </View>
      ) : null}
      {message ? (
        <AppText variant="muted" style={styles.error}>
          {message}
        </AppText>
      ) : null}
    </View>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <View style={styles.empty}>
      <AppText variant="muted" style={styles.center}>
        {message}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeText: { fontSize: 12, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  pressed: { opacity: 0.85 },
  tracking: { fontWeight: '700', fontVariant: ['tabular-nums'], writingDirection: 'ltr' },
  amount: { fontWeight: '700' },
  section: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  info: { gap: 2 },
  ltr: { writingDirection: 'ltr' },
  timeline: { gap: spacing.md },
  timelineEntry: {
    gap: spacing.xs,
    borderColor: colors.border,
    borderBottomWidth: 1,
    paddingBottom: spacing.md,
  },
  timelineHeader: { justifyContent: 'flex-start' },
  note: {
    backgroundColor: colors.background,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  chips: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.xs },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    minHeight: 36,
    justifyContent: 'center',
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 14 },
  chipTextSelected: { color: colors.primaryText, fontWeight: '600' },
  field: { gap: spacing.xs },
  select: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  selectError: { borderColor: colors.danger },
  placeholder: { color: colors.muted },
  options: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  option: { paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  search: {
    minHeight: 44,
    borderBottomWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    fontSize: 16,
    color: colors.text,
  },
  optionSelected: { backgroundColor: colors.successBackground },
  error: { color: colors.danger },
  empty: { paddingVertical: spacing.xxl, alignItems: 'center' },
  center: { textAlign: 'center' },
});
