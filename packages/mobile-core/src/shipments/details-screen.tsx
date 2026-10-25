import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';
import {
  availableShipmentTransitions,
  normalizeMoney,
  type ShipmentActor,
  type ShipmentDetails,
  type ShipmentTransitionRule,
} from '@coobra/shared';
import { ApiError } from '../api-client';
import { useMobileConfig } from '../config';
import { AppButton } from '../ui/button';
import { Banner } from '../ui/banner';
import { ErrorBanner } from '../ui/error-banner';
import { Screen } from '../ui/screen';
import { AppText } from '../ui/text';
import { TextField } from '../ui/text-field';
import { colors, radius, spacing } from '../ui/theme';
import { useDirection } from '../ui/use-direction';
import { useShipment, useShipmentTransition } from './api';
import { useFollowUpCollection } from './finance-api';
import { InfoRow, Row, Section, StatusBadge, Timeline } from './components';
import { formatDateTime, formatMoney, zoneText } from './format';

function openMaps(shipment: ShipmentDetails, governorateLabel: string) {
  const query = [shipment.addressLine, shipment.landmark, shipment.city, governorateLabel]
    .filter(Boolean)
    .join(', ');
  void Linking.openURL(
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
  );
}

export function ShipmentDetailsScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { clientApp } = useMobileConfig();
  const { language } = useDirection();
  const actor: ShipmentActor = clientApp === 'DRIVER_APP' ? 'DRIVER' : 'MERCHANT';
  const shipment = useShipment(id ?? '');
  const [message, setMessage] = useState<string | null>(null);

  if (shipment.isPending) {
    return <ActivityIndicator color={colors.primary} style={styles.loading} />;
  }
  if (shipment.isError) {
    return (
      <Screen>
        <ErrorBanner error={shipment.error} />
        <AppButton
          variant="outline"
          title={t('common.retry')}
          onPress={() => void shipment.refetch()}
        />
      </Screen>
    );
  }

  const s = shipment.data;
  const governorate = zoneText(s.destination, language) ?? t(`governorates.${s.governorate}`);
  const transitions = availableShipmentTransitions(s.status, actor);

  return (
    <Screen>
      <Stack.Screen options={{ title: s.trackingNumber }} />
      <Row>
        <AppText variant="title" style={styles.ltr}>
          {s.trackingNumber}
        </AppText>
        <StatusBadge status={s.status} />
      </Row>
      {message ? <Banner tone="success" message={message} /> : null}

      {actor === 'DRIVER' && transitions.length > 0 ? (
        <Section title={t('shipments.actions.title')}>
          {transitions.map((rule) => (
            <TransitionAction
              key={rule.to}
              shipment={s}
              rule={rule}
              onDone={() => setMessage(t('shipments.actions.updated'))}
            />
          ))}
        </Section>
      ) : null}

      <Section title={t('shipments.details.recipient')}>
        <InfoRow label={t('shipments.fields.recipientName')} value={s.recipientName} />
        <InfoRow label={t('shipments.fields.recipientPhone')} value={s.recipientPhone} ltr />
        {s.recipientPhoneAlt ? (
          <InfoRow
            label={t('shipments.fields.recipientPhoneAlt')}
            value={s.recipientPhoneAlt}
            ltr
          />
        ) : null}
        {actor === 'DRIVER' ? (
          <View style={styles.buttons}>
            <AppButton
              title={t('shipments.actions.call')}
              onPress={() => void Linking.openURL(`tel:${s.recipientPhone}`)}
              testID="shipment-call"
            />
            {s.recipientPhoneAlt ? (
              <AppButton
                variant="outline"
                title={t('shipments.actions.callAlt')}
                onPress={() => void Linking.openURL(`tel:${s.recipientPhoneAlt}`)}
              />
            ) : null}
          </View>
        ) : null}
      </Section>

      <Section title={t('shipments.details.address')}>
        <AppText>
          {governorate} — {s.city}
        </AppText>
        <AppText>{s.addressLine}</AppText>
        {s.landmark ? <AppText variant="muted">{s.landmark}</AppText> : null}
        {s.recipientNotes ? (
          <InfoRow label={t('shipments.details.recipientNotes')} value={s.recipientNotes} />
        ) : null}
        {s.merchantNotes ? (
          <InfoRow label={t('shipments.details.merchantNotes')} value={s.merchantNotes} />
        ) : null}
        {actor === 'DRIVER' ? (
          <AppButton
            variant="outline"
            title={t('shipments.actions.openMap')}
            onPress={() => openMaps(s, governorate)}
            testID="shipment-map"
          />
        ) : null}
      </Section>

      <Section title={t('shipments.details.payment')}>
        <InfoRow
          label={t('shipments.details.codAmount')}
          value={formatMoney(s.codAmount, language)}
        />
        <InfoRow
          label={t('shipments.details.deliveryFee')}
          value={
            s.deliveryFee
              ? formatMoney(s.deliveryFee, language)
              : t('shipments.fields.deliveryFeePending')
          }
        />
        {s.codInfo.status !== 'NOT_REQUIRED' ? (
          <InfoRow
            label={t('finance.cod.title')}
            value={`${t(`finance.cod.status.${s.codInfo.status}`)} · ${formatMoney(s.codInfo.collected, language)}`}
          />
        ) : null}
        {s.codInfo.status === 'PARTIAL' ? (
          <AppText style={styles.warning}>
            {t('finance.cod.remaining', { amount: formatMoney(s.codInfo.outstanding, language) })}
          </AppText>
        ) : null}
        {actor === 'DRIVER' && s.status === 'DELIVERED' && s.codInfo.status === 'PARTIAL' ? (
          <FollowUpCollection shipmentId={s.id} />
        ) : null}
        {s.cod ? (
          <InfoRow
            label={t('shipments.details.cod')}
            value={
              s.cod.collected
                ? t('shipments.details.codCollected', {
                    amount: formatMoney(s.cod.collectedAmount, language),
                    name: s.cod.driver?.fullName ?? '—',
                  })
                : t('shipments.details.codNotCollected')
            }
          />
        ) : null}
        {s.failureReason ? (
          <InfoRow label={t('shipments.fields.failureReason')} value={s.failureReason} />
        ) : null}
        {s.returnReason ? (
          <InfoRow label={t('shipments.fields.returnReason')} value={s.returnReason} />
        ) : null}
        {s.cancellationReason ? (
          <InfoRow label={t('shipments.fields.cancellationReason')} value={s.cancellationReason} />
        ) : null}
      </Section>

      <Section>
        {actor === 'DRIVER' ? (
          <>
            <InfoRow label={t('shipments.fields.merchant')} value={s.merchant.businessName} />
            {s.merchant.phone ? (
              <AppButton
                variant="outline"
                title={t('shipments.actions.callMerchant')}
                onPress={() => void Linking.openURL(`tel:${s.merchant.phone}`)}
              />
            ) : null}
          </>
        ) : (
          <InfoRow
            label={t('shipments.fields.driver')}
            value={s.driver?.fullName ?? t('shipments.fields.unassigned')}
          />
        )}
        <InfoRow
          label={t('shipments.fields.createdAt')}
          value={formatDateTime(s.createdAt, language)}
        />
        {s.deliveredAt ? (
          <InfoRow
            label={t('shipments.fields.deliveredAt')}
            value={formatDateTime(s.deliveredAt, language)}
          />
        ) : null}
        {s.createdBy && s.creatorRole !== 'MERCHANT' ? (
          <AppText variant="muted">
            {t('shipments.fields.onBehalf', {
              name: s.createdBy.fullName,
              role: t(`roles.${s.creatorRole}`),
            })}
          </AppText>
        ) : null}
      </Section>

      {actor === 'MERCHANT' && transitions.length > 0 ? (
        <Section title={t('shipments.actions.title')}>
          {transitions.map((rule) => (
            <TransitionAction
              key={rule.to}
              shipment={s}
              rule={rule}
              onDone={() => setMessage(t('shipments.actions.updated'))}
            />
          ))}
        </Section>
      ) : null}

      {s.returnInfo ? (
        <Section title={t('returns.info')}>
          {s.returnInfo.requestReason ? (
            <InfoRow label={t('returns.requestReason')} value={s.returnInfo.requestReason} />
          ) : null}
          <InfoRow
            label={t('returns.fee')}
            value={`${t(`returns.feeStatus.${s.returnInfo.feeStatus}`)}${
              s.returnInfo.feeAmount ? ` · ${formatMoney(s.returnInfo.feeAmount, language)}` : ''
            }`}
          />
          {s.returnInfo.returnDriver ? (
            <InfoRow label={t('returns.returnDriver')} value={s.returnInfo.returnDriver.fullName} />
          ) : null}
        </Section>
      ) : null}

      <Section title={t('shipments.details.timeline')}>
        <Timeline history={s.history} />
      </Section>
    </Screen>
  );
}

/** One lifecycle action: tap to open, add the reason/COD confirmation when needed, confirm. */
function TransitionAction({
  shipment,
  rule,
  onDone,
}: {
  shipment: ShipmentDetails;
  rule: ShipmentTransitionRule;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const transition = useShipmentTransition(shipment.id);
  const destructive = ['CANCELLED', 'DELIVERY_FAILED', 'RETURN_REQUESTED'].includes(rule.to);
  const reasonError =
    transition.error instanceof ApiError ? transition.error.body.fieldErrors?.reason : undefined;

  const title = t(`shipments.actions.to.${rule.to}`);
  if (!open) {
    return (
      <AppButton
        variant={destructive ? 'outline' : 'primary'}
        title={title}
        onPress={() => setOpen(true)}
        testID={`action-${rule.to}`}
      />
    );
  }

  const finish = () => {
    setOpen(false);
    setReason('');
    onDone();
  };

  if (rule.requiresCodConfirmation) {
    return (
      <DeliverPanel
        shipment={shipment}
        loading={transition.isPending}
        error={transition.error}
        onCancel={() => setOpen(false)}
        onSubmit={(cod) => transition.mutate({ toStatus: rule.to, cod }, { onSuccess: finish })}
      />
    );
  }

  return (
    <View style={styles.panel}>
      <AppText variant="subtitle">{title}</AppText>
      {rule.requiresReason ? (
        <TextField
          label={t('shipments.actions.reason')}
          placeholder={t('shipments.actions.reasonPlaceholder')}
          value={reason}
          onChangeText={setReason}
          multiline
          error={reasonError}
          testID={`reason-${rule.to}`}
        />
      ) : null}
      {reasonError ? null : <ErrorBanner error={transition.error} />}
      <AppButton
        title={t('shipments.actions.confirm')}
        loading={transition.isPending}
        onPress={() =>
          transition.mutate(
            { toStatus: rule.to, reason: reason.trim() || undefined },
            { onSuccess: finish },
          )
        }
        testID={`confirm-${rule.to}`}
      />
      <AppButton variant="link" title={t('common.cancel')} onPress={() => setOpen(false)} />
    </View>
  );
}

/**
 * Delivery confirmation. Cash collection is never assumed: the driver answers explicitly,
 * types the amount, and confirms the hand-over. The API re-validates everything.
 */
function DeliverPanel({
  shipment,
  loading,
  error,
  onSubmit,
  onCancel,
}: {
  shipment: ShipmentDetails;
  loading: boolean;
  error: unknown;
  onSubmit: (cod: {
    collected: boolean;
    amount: string;
    confirmed: true;
    partialReason?: string;
  }) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { language } = useDirection();
  const hasCod = shipment.codAmount !== '0.00';
  const [collected, setCollected] = useState<boolean | null>(hasCod ? null : false);
  const [amount, setAmount] = useState('');
  const [partialReason, setPartialReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const expected = formatMoney(shipment.codAmount, language);
  // Exact comparison in cents (never floating point); the server re-validates everything.
  const typed = toCents(amount);
  const partial = typed !== null && typed > 0n && typed < (toCents(shipment.codAmount) ?? 0n);
  const ready =
    confirmed &&
    (hasCod
      ? collected === true &&
        typed !== null &&
        typed > 0n &&
        (!partial || partialReason.trim().length >= 3)
      : true);

  return (
    <View style={styles.panel}>
      <AppText variant="subtitle">{t('shipments.deliver.title')}</AppText>
      {hasCod ? (
        <>
          <AppText>{t('shipments.deliver.codQuestion', { amount: expected })}</AppText>
          <Row style={styles.choiceRow}>
            <Choice
              label={t('shipments.deliver.collectedYes')}
              selected={collected === true}
              onPress={() => setCollected(true)}
              testID="cod-yes"
            />
            <Choice
              label={t('shipments.deliver.collectedNo')}
              selected={collected === false}
              onPress={() => setCollected(false)}
              testID="cod-no"
            />
          </Row>
          {collected === true ? (
            <TextField
              label={t('shipments.deliver.amount')}
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              forceLtr
              testID="cod-amount"
            />
          ) : null}
          {collected === true && partial ? (
            <>
              <Banner message={t('finance.cod.partial')} />
              <TextField
                label={t('finance.cod.partialReason')}
                value={partialReason}
                onChangeText={setPartialReason}
                multiline
                testID="cod-partial-reason"
              />
            </>
          ) : null}
          {collected === false ? <Banner message={t('shipments.deliver.mustCollect')} /> : null}
        </>
      ) : (
        <AppText>{t('shipments.deliver.noCod')}</AppText>
      )}
      <Choice
        label={t('shipments.deliver.confirmCheck')}
        selected={confirmed}
        onPress={() => setConfirmed((value) => !value)}
        checkbox
        testID="deliver-confirm-check"
      />
      <ErrorBanner error={error} />
      <AppButton
        title={t('shipments.deliver.submit')}
        disabled={!ready}
        loading={loading}
        onPress={() =>
          onSubmit({
            collected: collected === true,
            amount: collected === true ? amount : '0',
            confirmed: true,
            ...(partial ? { partialReason: partialReason.trim() } : {}),
          })
        }
        testID="deliver-submit"
      />
      <AppButton variant="link" title={t('common.cancel')} onPress={onCancel} />
    </View>
  );
}

function Choice({
  label,
  selected,
  onPress,
  checkbox,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  checkbox?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole={checkbox ? 'checkbox' : 'radio'}
      accessibilityState={checkbox ? { checked: selected } : { selected }}
      onPress={onPress}
      style={[styles.choice, selected && styles.choiceSelected, checkbox && styles.checkbox]}
      testID={testID}
    >
      <View style={[styles.mark, selected && styles.markSelected]}>
        {selected ? <AppText style={styles.markText}>✓</AppText> : null}
      </View>
      <AppText style={styles.choiceLabel}>{label}</AppText>
    </Pressable>
  );
}

/** "12.50" → 1250n; null when not a valid amount. */
function toCents(value: string): bigint | null {
  const normalized = normalizeMoney(value);
  return normalized === null ? null : BigInt(normalized.replace('.', ''));
}

/** A later cash payment on a partially paid shipment. */
function FollowUpCollection({ shipmentId }: { shipmentId: string }) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('');
  const collect = useFollowUpCollection(shipmentId);
  return (
    <View style={styles.panel}>
      <TextField
        label={t('finance.cod.collect')}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        forceLtr
        testID="followup-amount"
      />
      <ErrorBanner error={collect.error} />
      <AppButton
        title={t('finance.confirm')}
        loading={collect.isPending}
        disabled={!amount.trim()}
        onPress={() => collect.mutate({ amount }, { onSuccess: () => setAmount('') })}
        testID="followup-submit"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: spacing.xxl },
  warning: { color: colors.danger, fontWeight: '600' },
  ltr: { writingDirection: 'ltr' },
  buttons: { gap: spacing.sm },
  panel: {
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  choiceRow: { justifyContent: 'flex-start' },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    minHeight: 48,
    flexGrow: 1,
  },
  checkbox: { flexGrow: 0 },
  choiceSelected: { borderColor: colors.primary, backgroundColor: colors.successBackground },
  mark: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  markSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  markText: { color: colors.primaryText, fontSize: 14, fontWeight: '700' },
  choiceLabel: { flexShrink: 1 },
});
