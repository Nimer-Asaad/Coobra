import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { loginSchema } from '@coobra/shared';
import { useMobileConfig } from '../config';
import { useFormErrors } from '../form-errors';
import { useLogin } from '../hooks';
import { AppButton } from '../ui/button';
import { ErrorBanner } from '../ui/error-banner';
import { Screen } from '../ui/screen';
import { AppText } from '../ui/text';
import { TextField } from '../ui/text-field';
import { AuthHeader } from './header';

export function LoginScreen() {
  const { t } = useTranslation();
  const { clientApp, allowRegistration } = useMobileConfig();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { fieldErrors, validate, applyApiError } = useFormErrors();
  const login = useLogin();

  function submit() {
    const values = validate(loginSchema, { email, password, clientApp });
    if (!values) return;
    login.mutate(
      { email: values.email, password: values.password },
      { onSuccess: () => router.replace('/home'), onError: applyApiError },
    );
  }

  return (
    <Screen>
      <AuthHeader />
      <AppText variant="title">{t('auth.login.title')}</AppText>
      <AppText variant="muted">{t('auth.login.subtitle')}</AppText>
      <ErrorBanner error={login.error} />
      <TextField
        label={t('auth.email')}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        forceLtr
        error={fieldErrors.email}
        testID="login-email"
      />
      <TextField
        label={t('auth.password')}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        error={fieldErrors.password}
        onSubmitEditing={submit}
        testID="login-password"
      />
      <AppButton
        title={t('auth.login.submit')}
        onPress={submit}
        loading={login.isPending}
        testID="login-submit"
      />
      <AppButton
        variant="link"
        title={t('auth.login.forgotPassword')}
        onPress={() => router.push('/forgot-password')}
      />
      {allowRegistration ? (
        <AppButton
          variant="link"
          title={t('auth.login.createAccount')}
          onPress={() => router.push('/register')}
        />
      ) : null}
    </Screen>
  );
}
