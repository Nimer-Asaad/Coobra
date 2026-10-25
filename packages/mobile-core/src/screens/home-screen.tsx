import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useMobileConfig } from '../config';
import { StyleSheet, View } from 'react-native';
import { useSessionStore } from '../state/session-store';
import { AppButton } from '../ui/button';
import { Screen } from '../ui/screen';
import { AppText } from '../ui/text';
import { colors, radius, spacing } from '../ui/theme';

export function HomeScreen() {
  const { t } = useTranslation();
  const { clientApp } = useMobileConfig();
  const user = useSessionStore((state) => state.user);
  if (!user) return null;

  return (
    <Screen>
      <AppText variant="title">{t('home.welcome', { name: user.fullName })}</AppText>
      <View style={styles.actions}>
        {clientApp === 'MERCHANT_APP' ? (
          <AppButton
            title={t('shipments.newShipment')}
            onPress={() => router.push('/shipments/new')}
            testID="home-new-shipment"
          />
        ) : null}
        <AppButton
          variant={clientApp === 'MERCHANT_APP' ? 'outline' : 'primary'}
          title={clientApp === 'MERCHANT_APP' ? t('shipments.myShipments') : t('shipments.title')}
          onPress={() => router.push('/shipments')}
          testID="home-shipments"
        />
        <AppButton
          variant="outline"
          title={clientApp === 'MERCHANT_APP' ? t('nav.myBalance') : t('nav.myCash')}
          onPress={() => router.push('/finance')}
          testID="home-finance"
        />
      </View>
      <View style={styles.card}>
        <AppText variant="muted">{t('home.roleLabel')}</AppText>
        <AppText variant="subtitle">{t(`roles.${user.role}`)}</AppText>
        {user.merchant ? (
          <>
            <AppText variant="muted">{t('home.businessLabel')}</AppText>
            <AppText variant="subtitle">{user.merchant.businessName}</AppText>
          </>
        ) : null}
      </View>
      <AppButton
        variant="outline"
        title={t('nav.settings')}
        onPress={() => router.push('/settings')}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.sm },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
});
