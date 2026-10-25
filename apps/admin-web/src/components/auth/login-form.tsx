'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { loginSchema, type LoginResponse } from '@coobra/shared';
import { ErrorAlert } from '@/components/error-alert';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { clientFetch } from '@/lib/api-client';
import { useFormErrors } from '@/lib/use-form-errors';

export function LoginForm() {
  const { t } = useTranslation();
  const router = useRouter();
  const { fieldErrors, validate, applyApiError } = useFormErrors();

  const login = useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      clientFetch<Omit<LoginResponse, 'token'>>('/api/session/login', { method: 'POST', body }),
    onSuccess: () => {
      router.replace('/dashboard');
      router.refresh();
    },
    onError: applyApiError,
  });

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = validate(loginSchema, {
      email: form.get('email'),
      password: form.get('password'),
      clientApp: 'ADMIN_WEB',
    });
    if (values) login.mutate({ email: values.email, password: values.password });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <ErrorAlert error={login.error} />
      <FormField
        name="email"
        type="email"
        autoComplete="email"
        dir="ltr"
        label={t('auth.email')}
        error={fieldErrors.email}
      />
      <FormField
        name="password"
        type="password"
        autoComplete="current-password"
        label={t('auth.password')}
        error={fieldErrors.password}
      />
      <Button type="submit" disabled={login.isPending}>
        {login.isPending ? t('common.loading') : t('auth.login.submit')}
      </Button>
      <Link href="/forgot-password" className="text-center text-sm text-primary hover:underline">
        {t('auth.login.forgotPassword')}
      </Link>
    </form>
  );
}
