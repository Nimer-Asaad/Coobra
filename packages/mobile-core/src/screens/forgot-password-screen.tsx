import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { forgotPasswordSchema } from '@coobra/shared';
import { useFormErrors } from '../form-errors';
import { useForgotPassword } from '../hooks';
import { AppButton } from '../ui/button';
import { Banner } from '../ui/banner';
import { ErrorBanner } from '../ui/error-banner';
import { Screen } from '../ui/screen';
import { AppText } from '../ui/text';
import { TextField } from '../ui/text-field';
import { AuthHeader } from './header';

export function ForgotPasswordScreen() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const { fieldErrors, validate, applyApiError } = useFormErrors();
  const request = useForgotPassword();

  function submit() {
    const values = validate(forgotPasswordSchema, { email });
    if (values) request.mutate(values, { onError: applyApiError });
  }

  return (
    <Screen>
      <AuthHeader />
      <AppText variant="title">{t('auth.forgot.title')}</AppText>
      {request.isSuccess ? (
        <Banner tone="success" message={t('auth.forgot.sent')} />
      ) : (
        <>
          <AppText variant="muted">{t('auth.forgot.description')}</AppText>
          <ErrorBanner error={request.error} />
          <TextField
            label={t('auth.email')}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            forceLtr
            error={fieldErrors.email}
            onSubmitEditing={submit}
          />
          <AppButton title={t('auth.forgot.submit')} onPress={submit} loading={request.isPending} />
        </>
      )}
      <AppButton
        variant="link"
        title={t('auth.forgot.backToLogin')}
        onPress={() => router.replace('/login')}
      />
    </Screen>
  );
}
