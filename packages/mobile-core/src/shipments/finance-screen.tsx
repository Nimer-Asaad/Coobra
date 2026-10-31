import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { PAYMENT_METHODS, type PaymentMethod } from '@coobra/shared';
import { ApiError } from '../api-client';
import { useMobileConfig } from '../config';
import { useImpersonationGuard } from '../impersonation/use-guard';
import { AppButton } from '../ui/button';
import { Banner } from '../ui/banner';
import { ErrorBanner } from '../ui/error-banner';
import { AppText } from '../ui/text';
import { TextField } from '../ui/text-field';
import { colors, spacing } from '../ui/theme';
import { useDirection } from '../ui/use-direction';
import { ChipBar, InfoRow, Row, Section } from './components';
import {
  useDriverFinance,
  useMerchantFinance,
  useMerchantShortfalls,
  useRequestPayout,
  useRespondShortfall,
  useSubmitSettlement,
  useWithdrawPayout,
} from './finance-api';
import { formatDateTime, formatMoney } from './format';

/** "My balance" (merchant) or "My cash" (driver): only the signed-in user's own money. */
export function FinanceScreen() {
  const { clientApp } = useMobileConfig();
  return clientApp === 'MERCHANT_APP' ? <MerchantFinance /> : <DriverFinance />;
}

function Container({
  refreshing,
  onRefresh,
  children,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  children: React.ReactNode;
}) {
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
      }
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

function fieldError(error: unknown, name: string) {
  return error instanceof ApiError ? error.body.fieldErrors?.[name] : undefined;
}

function MerchantFinance() {
  const { t } = useTranslation();
  const { language } = useDirection();
  const finance = useMerchantFinance();
  const shortfalls = useMerchantShortfalls();
  const request = useRequestPayout();
  const withdraw = useWithdrawPayout();
  const respond = useRespondShortfall();
  // Financial consent is the merchant's own decision (ADR 0003): never during an impersonation.
  const guard = useImpersonationGuard();
  const respondBlocked = guard.blockedReason('POST /v1/merchant/finance/shortfalls/:id/accept');
  const payoutBlocked = guard.blockedReason('POST /v1/merchant/finance/payouts');
  const withdrawBlocked = guard.blockedReason('POST /v1/merchant/finance/payouts/:id/cancel');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('BANK_TRANSFER');

  if (finance.isPending) return <ActivityIndicator color={colors.primary} style={styles.loading} />;
  if (finance.isError) return <ErrorBanner error={finance.error} />;
  const f = finance.data;
  const waiting = shortfalls.data?.filter((item) => item.status === 'AWAITING_MERCHANT') ?? [];

  return (
    <Container
      refreshing={finance.isRefetching}
      onRefresh={() => {
        void finance.refetch();
        void shortfalls.refetch();
      }}
    >
      <Section title={t('finance.merchantView.title')}>
        <InfoRow label={t('finance.available')} value={formatMoney(f.available, language)} />
        <AppText variant="muted">{t('finance.merchantView.availableHint')}</AppText>
        <InfoRow label={t('finance.balance')} value={formatMoney(f.balance, language)} />
        <AppText variant="muted">{t('finance.merchantView.balanceHint')}</AppText>
        <InfoRow label={t('finance.pendingCod')} value={formatMoney(f.pending, language)} />
        <AppText variant="muted">{t('finance.merchantView.pendingHint')}</AppText>
        {f.reserved !== '0.00' ? (
          <InfoRow label={t('finance.reserved')} value={formatMoney(f.reserved, language)} />
        ) : null}
      </Section>

      {waiting.length > 0 ? (
        <Section title={t('finance.merchantView.shortfallsTitle')}>
          {waiting.map((item) => (
            <View key={item.id} style={styles.item}>
              <AppText variant="subtitle">{item.shipment.trackingNumber}</AppText>
              <AppText>
                {t('finance.expected')} {formatMoney(item.expectedAmount, language)} ·{' '}
                {t('finance.collected')} {formatMoney(item.collectedAmount, language)}
              </AppText>
              <AppText>
                {t('finance.outstanding')}: {formatMoney(item.outstandingAmount, language)}
              </AppText>
              <AppText variant="muted">{item.proposalNote ?? item.reason}</AppText>
              <AppButton
                title={t('finance.merchantView.accept')}
                loading={respond.isPending}
                disabledReason={respondBlocked}
                onPress={() => respond.mutate({ id: item.id, accept: true })}
                testID={`shortfall-accept-${item.id}`}
              />
              <AppButton
                variant="outline"
                title={t('finance.merchantView.decline')}
                disabled={respond.isPending || Boolean(respondBlocked)}
                onPress={() => respond.mutate({ id: item.id, accept: false })}
              />
            </View>
          ))}
          <ErrorBanner error={respond.error} />
        </Section>
      ) : null}

      <Section title={t('finance.merchantView.requestPayout')}>
        {request.isSuccess ? (
          <Banner tone="success" message={t('finance.merchantView.requested')} />
        ) : null}
        <TextField
          label={t('finance.amount')}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          forceLtr
          error={fieldError(request.error, 'amount')}
          testID="payout-amount"
        />
        <AppText variant="label">{t('finance.method')}</AppText>
        <ChipBar
          options={PAYMENT_METHODS.map((value) => ({
            value,
            label: t(`finance.methods.${value}`),
          }))}
          value={method}
          onChange={setMethod}
        />
        {fieldError(request.error, 'amount') ? null : <ErrorBanner error={request.error} />}
        <AppButton
          title={t('finance.merchantView.requestPayout')}
          loading={request.isPending}
          disabled={!amount.trim()}
          disabledReason={payoutBlocked}
          onPress={() => request.mutate({ amount, method }, { onSuccess: () => setAmount('') })}
          testID="payout-submit"
        />
      </Section>

      <Section title={t('finance.payouts')}>
        {f.payouts.length === 0 ? <AppText variant="muted">{t('finance.empty')}</AppText> : null}
        {f.payouts.map((payout) => (
          <View key={payout.id} style={styles.item}>
            <Row>
              <AppText variant="subtitle">{formatMoney(payout.amount, language)}</AppText>
              <AppText variant="muted">{t(`finance.payoutStatus.${payout.status}`)}</AppText>
            </Row>
            <AppText variant="muted">
              {t(`finance.methods.${payout.method}`)} · {formatDateTime(payout.createdAt, language)}
              {payout.reference ? ` · ${payout.reference}` : ''}
            </AppText>
            {payout.status === 'PENDING_APPROVAL' && payout.requestedByMerchant ? (
              <AppButton
                variant="link"
                title={t('finance.merchantView.withdraw')}
                disabledReason={withdrawBlocked}
                onPress={() =>
                  withdraw.mutate(
                    { id: payout.id, note: 'Withdrawn by merchant' },
                    // The "payout requested" notice no longer describes the list.
                    { onSuccess: () => request.reset() },
                  )
                }
              />
            ) : null}
          </View>
        ))}
        <ErrorBanner error={withdraw.error} />
      </Section>
    </Container>
  );
}

function DriverFinance() {
  const { t } = useTranslation();
  const { language } = useDirection();
  const finance = useDriverFinance();
  const submit = useSubmitSettlement();
  // Cash custody stays with the driver's own session (ADR 0003): never during an impersonation.
  const settlementBlocked = useImpersonationGuard().blockedReason(
    'POST /v1/driver/finance/settlements',
  );
  const [amount, setAmount] = useState('');

  if (finance.isPending) return <ActivityIndicator color={colors.primary} style={styles.loading} />;
  if (finance.isError) return <ErrorBanner error={finance.error} />;
  const f = finance.data;

  return (
    <Container refreshing={finance.isRefetching} onRefresh={() => void finance.refetch()}>
      <Section title={t('finance.driverView.title')}>
        <AppText variant="title" testID="driver-custody">
          {formatMoney(f.custody, language)}
        </AppText>
        <AppText variant="muted">{t('finance.driverView.custodyHint')}</AppText>
        {f.receivable !== '0.00' ? (
          <Banner
            message={t('finance.driverView.owes', { amount: formatMoney(f.receivable, language) })}
          />
        ) : null}
      </Section>

      <Section title={t('finance.driverView.handOver')}>
        {f.pendingSettlement ? (
          <Banner
            tone="info"
            message={t('finance.driverView.pending', {
              amount: formatMoney(f.pendingSettlement.declaredAmount, language),
            })}
          />
        ) : (
          <>
            <AppText variant="muted">{t('finance.driverView.handOverHint')}</AppText>
            <TextField
              label={t('finance.amount')}
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              forceLtr
              placeholder={f.custody}
              error={fieldError(submit.error, 'declaredAmount')}
              testID="settlement-amount"
            />
            {fieldError(submit.error, 'declaredAmount') ? null : (
              <ErrorBanner error={submit.error} />
            )}
            <AppButton
              title={t('finance.driverView.handOver')}
              loading={submit.isPending}
              disabled={!amount.trim()}
              disabledReason={settlementBlocked}
              onPress={() =>
                submit.mutate({ declaredAmount: amount }, { onSuccess: () => setAmount('') })
              }
              testID="settlement-submit"
            />
          </>
        )}
        {submit.isSuccess ? (
          <Banner tone="success" message={t('finance.driverView.submitted')} />
        ) : null}
      </Section>

      <Section title={t('finance.driverView.uncleared')}>
        {f.uncleared.length === 0 ? <AppText variant="muted">{t('finance.empty')}</AppText> : null}
        {f.uncleared.map((item) => (
          <Row key={item.collectionId}>
            <AppText style={styles.tracking}>{item.shipment.trackingNumber}</AppText>
            <AppText>{formatMoney(item.uncleared, language)}</AppText>
          </Row>
        ))}
      </Section>

      <Section title={t('finance.driverView.history')}>
        {f.settlements.length === 0 ? (
          <AppText variant="muted">{t('finance.empty')}</AppText>
        ) : null}
        {f.settlements.map((settlement) => (
          <View key={settlement.id} style={styles.item}>
            <Row>
              <AppText variant="subtitle">
                {formatMoney(settlement.countedAmount ?? settlement.declaredAmount, language)}
              </AppText>
              <AppText variant="muted">
                {t(`finance.settlementStatus.${settlement.status}`)}
              </AppText>
            </Row>
            <AppText variant="muted">
              {formatDateTime(settlement.createdAt, language)}
              {settlement.decisionNote ? ` · ${settlement.decisionNote}` : ''}
            </AppText>
          </View>
        ))}
      </Section>
    </Container>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  loading: { marginTop: spacing.xxl },
  item: {
    gap: spacing.xs,
    borderBottomWidth: 1,
    borderColor: colors.border,
    paddingBottom: spacing.md,
  },
  tracking: { fontWeight: '700', writingDirection: 'ltr' },
});
