'use client';

import { useTranslation } from 'react-i18next';
import { translateError } from '@coobra/i18n';
import { Alert } from '@/components/ui/alert';

export function ErrorAlert({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  return <Alert variant="destructive">{translateError(t, error)}</Alert>;
}
