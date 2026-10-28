import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { validationParams } from '@coobra/i18n';
import { resetPasswordSchema } from '@coobra/shared';
import { useFormErrors } from '../form-errors';
import { useResetPassword } from '../hooks';
import { AppButton } from '../ui/button';
import { Banner } from '../ui/banner';
import { ErrorBanner } from '../ui/error-banner';
import { Screen } from '../ui/screen';
import { AppText } from '../ui/text';
import { TextField } from '../ui/text-field';

/** Opened from password-reset and account-setup (invitation) emails. */
export function ResetPasswordScreen({ token }: { token: string | undefined }) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const { fieldErrors, validate, applyApiError } = useFormErrors();
  const reset = useResetPassword();

  function submit() {
    const values = validate(resetPasswordSchema, { token, password });
    if (values) reset.mutate(values, { onError: applyApiError });
  }

  return (
    <Screen>
      <AppText variant="title">{t('auth.reset.title')}</AppText>
      {!token ? (
        <Banner message={t('auth.reset.missingToken')} />
      ) : reset.isSuccess ? (
        <Banner tone="success" message={t('auth.reset.success')} />
      ) : (
        <>
          <ErrorBanner error={reset.error} />
          <TextField
            label={t('auth.reset.newPassword')}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="new-password"
            hint={t('auth.register.passwordHint', validationParams)}
            error={fieldErrors.password ?? fieldErrors.token}
            onSubmitEditing={submit}
          />
          <AppButton title={t('auth.reset.submit')} onPress={submit} loading={reset.isPending} />
        </>
      )}
      <AppButton
        variant="link"
        title={t('auth.reset.goToLogin')}
        onPress={() => router.replace('/login')}
      />
    </Screen>
  );
}
