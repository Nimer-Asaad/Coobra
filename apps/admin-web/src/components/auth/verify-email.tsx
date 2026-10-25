'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorAlert } from '@/components/error-alert';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { bff } from '@/lib/api-client';

export function VerifyEmail({ token }: { token: string | undefined }) {
  const { t } = useTranslation();
  const verify = useMutation({
    mutationFn: (value: string) =>
      bff('/v1/auth/verify-email', { method: 'POST', body: { token: value } }),
  });
  const { mutate } = verify;
  // Tokens are single-use: never submit twice (e.g. React Strict Mode double effects).
  const submitted = useRef(false);

  useEffect(() => {
    if (token && !submitted.current) {
      submitted.current = true;
      mutate(token);
    }
  }, [token, mutate]);

  if (!token) return <Alert variant="destructive">{t('auth.verify.missingToken')}</Alert>;
  if (verify.isError) return <ErrorAlert error={verify.error} />;
  if (!verify.isSuccess)
    return <p className="text-sm text-muted-foreground">{t('auth.verify.verifying')}</p>;
  return (
    <div className="flex flex-col gap-4">
      <Alert variant="success">{t('auth.verify.success')}</Alert>
      <Button asChild>
        <Link href="/login">{t('auth.reset.goToLogin')}</Link>
      </Button>
    </div>
  );
}
