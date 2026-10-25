'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { forgotPasswordSchema, type ForgotPasswordInput } from '@coobra/shared';
import { ErrorAlert } from '@/components/error-alert';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { bff } from '@/lib/api-client';
import { useFormErrors } from '@/lib/use-form-errors';

export function ForgotPasswordForm() {
  const { t } = useTranslation();
  const { fieldErrors, validate, applyApiError } = useFormErrors();
  const request = useMutation({
    mutationFn: (body: ForgotPasswordInput) =>
      bff('/v1/auth/forgot-password', { method: 'POST', body }),
    onError: applyApiError,
  });

  if (request.isSuccess) {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="success">{t('auth.forgot.sent')}</Alert>
        <Link href="/login" className="text-center text-sm text-primary hover:underline">
          {t('auth.forgot.backToLogin')}
        </Link>
      </div>
    );
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const values = validate(forgotPasswordSchema, {
          email: new FormData(event.currentTarget).get('email'),
        });
        if (values) request.mutate(values);
      }}
    >
      <p className="text-sm text-muted-foreground">{t('auth.forgot.description')}</p>
      <ErrorAlert error={request.error} />
      <FormField
        name="email"
        type="email"
        dir="ltr"
        autoComplete="email"
        label={t('auth.email')}
        error={fieldErrors.email}
      />
      <Button type="submit" disabled={request.isPending}>
        {t('auth.forgot.submit')}
      </Button>
      <Link href="/login" className="text-center text-sm text-primary hover:underline">
        {t('auth.forgot.backToLogin')}
      </Link>
    </form>
  );
}
