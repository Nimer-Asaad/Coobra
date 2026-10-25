'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { validationParams } from '@coobra/i18n';
import { resetPasswordSchema, type ResetPasswordInput } from '@coobra/shared';
import { ErrorAlert } from '@/components/error-alert';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { bff } from '@/lib/api-client';
import { useFormErrors } from '@/lib/use-form-errors';

/** Used both for "forgot password" links and for invited users setting their first password. */
export function ResetPasswordForm({ token }: { token: string | undefined }) {
  const { t } = useTranslation();
  const { fieldErrors, validate, applyApiError } = useFormErrors();
  const reset = useMutation({
    mutationFn: (body: ResetPasswordInput) =>
      bff('/v1/auth/reset-password', { method: 'POST', body }),
    onError: applyApiError,
  });

  if (!token) return <Alert variant="destructive">{t('auth.reset.missingToken')}</Alert>;

  if (reset.isSuccess) {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="success">{t('auth.reset.success')}</Alert>
        <Button asChild>
          <Link href="/login">{t('auth.reset.goToLogin')}</Link>
        </Button>
      </div>
    );
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const values = validate(resetPasswordSchema, {
          token,
          password: new FormData(event.currentTarget).get('password'),
        });
        if (values) reset.mutate(values);
      }}
    >
      <ErrorAlert error={reset.error} />
      <FormField
        name="password"
        type="password"
        autoComplete="new-password"
        label={t('auth.reset.newPassword')}
        hint={t('auth.register.passwordHint', validationParams)}
        error={fieldErrors.password}
      />
      <Button type="submit" disabled={reset.isPending}>
        {t('auth.reset.submit')}
      </Button>
    </form>
  );
}
