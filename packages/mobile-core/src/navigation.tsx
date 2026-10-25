import { Redirect, Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useMobileConfig } from './config';
import { VerifyPendingScreen } from './screens/verify-pending-screen';
import { useLanguageStore } from './state/language-store';
import { useSessionStore } from './state/session-store';

/** `/` — sends the user to the right place: language choice, sign-in, or home. */
export function EntryRedirect() {
  const language = useLanguageStore((state) => state.language);
  const signedIn = useSessionStore((state) => state.status === 'signedIn');
  if (!language) return <Redirect href="/language" />;
  return <Redirect href={signedIn ? '/home' : '/login'} />;
}

/** Layout for sign-in/registration screens: language first, and no access once signed in. */
export function AuthGroupLayout() {
  const language = useLanguageStore((state) => state.language);
  const signedIn = useSessionStore((state) => state.status === 'signedIn');
  if (!language) return <Redirect href="/language" />;
  if (signedIn) return <Redirect href="/home" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}

/** Layout for protected screens: requires a session and a verified email. */
export function ProtectedGroupLayout() {
  const { t } = useTranslation();
  const { clientApp } = useMobileConfig();
  const language = useLanguageStore((state) => state.language);
  const status = useSessionStore((state) => state.status);
  const emailVerified = useSessionStore((state) => state.user?.emailVerified ?? false);

  if (!language) return <Redirect href="/language" />;
  if (status !== 'signedIn') return <Redirect href="/login" />;
  if (!emailVerified) return <VerifyPendingScreen />;
  return (
    <Stack screenOptions={{ headerTitleAlign: 'center' }}>
      <Stack.Screen name="home" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ title: t('nav.settings') }} />
      <Stack.Screen
        name="shipments/index"
        options={{
          title: clientApp === 'MERCHANT_APP' ? t('shipments.myShipments') : t('shipments.title'),
        }}
      />
      {clientApp === 'MERCHANT_APP' ? (
        <Stack.Screen name="shipments/new" options={{ title: t('shipments.newShipment') }} />
      ) : null}
      <Stack.Screen
        name="shipments/[id]"
        options={{ title: t('shipments.fields.trackingNumber') }}
      />
    </Stack>
  );
}
