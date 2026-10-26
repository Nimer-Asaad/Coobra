import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { validationParams } from '@coobra/i18n';
import { registerMerchantSchema } from '@coobra/shared';
import { useFormErrors } from '../form-errors';
import { useRegisterMerchant } from '../hooks';
import { useLanguageStore } from '../state/language-store';
import { AppButton } from '../ui/button';
import { ErrorBanner } from '../ui/error-banner';
import { Screen } from '../ui/screen';
import { AppText } from '../ui/text';
import { TextField } from '../ui/text-field';
import { AuthHeader } from './header';

/** Public merchant self-registration. The API always assigns the MERCHANT role. */
export function RegisterScreen() {
  const { t } = useTranslation();
  const language = useLanguageStore((state) => state.language) ?? 'en';
  const [form, setForm] = useState({
    fullName: '',
    businessName: '',
    email: '',
    phone: '',
    password: '',
  });
  const { fieldErrors, validate, applyApiError } = useFormErrors();
  const register = useRegisterMerchant();
  const update = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  function submit() {
    const values = validate(registerMerchantSchema, { ...form, language });
    if (!values) return;
    register.mutate(values, { onSuccess: () => router.replace('/home'), onError: applyApiError });
  }

  return (
    <Screen>
      <AuthHeader />
      <AppText variant="title">{t('auth.register.title')}</AppText>
      <AppText variant="muted">{t('auth.register.subtitle')}</AppText>
      <ErrorBanner error={register.error} />
      <TextField
        label={t('auth.register.fullName')}
        value={form.fullName}
        onChangeText={update('fullName')}
        testID="register-fullName"
        autoComplete="name"
        error={fieldErrors.fullName}
      />
      <TextField
        label={t('auth.register.businessName')}
        value={form.businessName}
        onChangeText={update('businessName')}
        testID="register-businessName"
        error={fieldErrors.businessName}
      />
      <TextField
        label={t('auth.email')}
        value={form.email}
        onChangeText={update('email')}
        testID="register-email"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        forceLtr
        error={fieldErrors.email}
      />
      <TextField
        label={t('auth.register.phone')}
        value={form.phone}
        onChangeText={update('phone')}
        testID="register-phone"
        keyboardType="phone-pad"
        autoComplete="tel"
        forceLtr
        error={fieldErrors.phone}
      />
      <TextField
        label={t('auth.password')}
        value={form.password}
        onChangeText={update('password')}
        testID="register-password"
        secureTextEntry
        autoComplete="new-password"
        hint={t('auth.register.passwordHint', validationParams)}
        error={fieldErrors.password}
        onSubmitEditing={submit}
      />
      <AppButton
        title={t('auth.register.submit')}
        onPress={submit}
        loading={register.isPending}
        testID="register-submit"
      />
      <AppButton
        variant="link"
        title={`${t('auth.register.haveAccount')} ${t('auth.register.signIn')}`}
        onPress={() => router.replace('/login')}
      />
    </Screen>
  );
}
