import { useTranslation } from 'react-i18next';
import { translateError } from '@coobra/i18n';
import { ApiError } from '../api-client';
import { Banner } from './banner';

/** Shows a translated API/network error. Validation errors are shown on their fields instead. */
export function ErrorBanner({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  if (
    error instanceof ApiError &&
    error.body.code === 'VALIDATION_FAILED' &&
    error.body.fieldErrors
  ) {
    return null;
  }
  return <Banner message={translateError(t, error)} />;
}
