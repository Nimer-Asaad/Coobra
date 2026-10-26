import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { SUPPORTED_LANGUAGES, zoneOptions } from '@coobra/shared';
import { useMobileConfig } from '../config';
import {
  usePickupZone,
  useRequestPickupZone,
  useWithdrawPickupZone,
  useZones,
} from '../shipments/api';
import { ChoiceField } from '../shipments/components';
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
  const { clientApp } = useMobileConfig();

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
      {clientApp === 'MERCHANT_APP' ? <PickupZoneSetting /> : null}
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

/**
 * The merchant's pickup area: delivery prices are calculated from the approved one. A change is
 * a request that COOBRA staff approve; until then the approved area keeps pricing shipments.
 */
function PickupZoneSetting() {
  const { t } = useTranslation();
  const language = useLanguageStore((state) => state.language) ?? 'en';
  const zones = useZones();
  const pickup = usePickupZone();
  const request = useRequestPickupZone();
  const withdraw = useWithdrawPickupZone();
  const options = zoneOptions(zones.data ?? [], language);
  const pathOf = (id: string | null | undefined) =>
    options.find((option) => option.id === id)?.path ?? t('pricing.pickupNone');
  const state = pickup.data;
  const rejected =
    state && !state.pending && state.lastDecision?.status === 'REJECTED'
      ? state.lastDecision
      : null;
  return (
    <View style={styles.section}>
      <AppText variant="subtitle">{t('pricing.pickupApproved')}</AppText>
      <AppText testID="settings-pickup-approved">{pathOf(state?.approvedZoneId)}</AppText>
      <AppText variant="muted">{t('pricing.pickupHint')}</AppText>
      {state?.pending ? (
        <>
          <Banner
            tone="info"
            message={t('pricing.pickupPending', { zone: pathOf(state.pending.requestedZoneId) })}
          />
          <AppButton
            variant="link"
            title={t('pricing.pickupWithdraw')}
            loading={withdraw.isPending}
            onPress={() => withdraw.mutate()}
          />
        </>
      ) : null}
      {rejected ? (
        <Banner
          message={`${t('pricing.pickupRejected', { zone: pathOf(rejected.requestedZoneId) })}${
            rejected.decisionNote ? ` ${rejected.decisionNote}` : ''
          }`}
        />
      ) : null}
      <ChoiceField
        label={t('pricing.pickupRequestChange')}
        placeholder={t('zones.choose')}
        searchPlaceholder={t('zones.search')}
        options={options
          .filter((option) => option.active)
          .map((option) => ({ value: option.id, label: option.path }))}
        value={state?.pending?.requestedZoneId ?? ''}
        onChange={(zoneId) => request.mutate(zoneId)}
        testID="settings-pickup-zone"
      />
      {request.isSuccess && state?.pending ? (
        <Banner tone="success" message={t('pricing.pickupRequested')} />
      ) : null}
      <ErrorBanner error={request.error ?? withdraw.error ?? pickup.error} />
    </View>
  );
}
