'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import {
  IMPERSONATION_MAX_DURATION_MINUTES,
  reauthenticateSchema,
  reasonTextSchema,
  startImpersonationSchema,
  type ImpersonationInfo,
  type ImpersonationStartResponse,
  type ImpersonationTargetRole,
} from '@coobra/shared';
import { translateValidation } from '@coobra/i18n';
import { ErrorAlert } from '@/components/error-alert';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { bff } from '@/lib/api-client';
import { HandoffError, runImpersonationHandoff } from '@/lib/impersonation-handoff';
import { useFormErrors } from '@/lib/use-form-errors';
import { ACTIVE_IMPERSONATIONS_KEY } from './use-impersonations';

const startFormSchema = z.object({
  reason: reasonTextSchema,
  ticketReference: startImpersonationSchema.shape.ticketReference,
  password: reauthenticateSchema.shape.password,
});

/** The window name: a second start reuses the same tab instead of piling up tabs. */
const TAB_NAME = 'coobra-impersonation';

export interface ImpersonationTarget {
  id: string;
  fullName: string;
  role: ImpersonationTargetRole;
}

/**
 * Reason, optional ticket and the admin's password, then the hand-off (ADR 0003 §8.3). The app
 * tab is opened inside the click (so popup blockers allow it); the password is sent once for
 * the step-up and never kept.
 */
export function StartImpersonationDialog({
  target,
  appUrl,
  onClose,
  onStarted,
}: {
  target: ImpersonationTarget;
  appUrl: string;
  onClose: () => void;
  onStarted: (info: ImpersonationInfo) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const reasonId = useId();
  const { fieldErrors, validate } = useFormErrors();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const app = t(target.role === 'MERCHANT' ? 'apps.merchant' : 'apps.driver');
  const reasonError = translateValidation(t, fieldErrors.reason);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const values = validate(startFormSchema, {
      reason: String(data.get('reason') ?? ''),
      ticketReference: String(data.get('ticketReference') ?? ''),
      password: String(data.get('password') ?? ''),
    });
    if (!values) return;
    // Synchronously, inside the click: popup blockers allow it. No `noopener`: the hand-off
    // needs window.opener in the new tab (only the target app's exact origin is trusted).
    const popup = window.open(`${appUrl}/impersonate`, TAB_NAME);
    const passwordInput = form.elements.namedItem('password');
    if (passwordInput instanceof HTMLInputElement) passwordInput.value = '';
    setError(null);
    setConnecting(true);
    runImpersonationHandoff({
      popup,
      appOrigin: appUrl,
      reauthenticate: () =>
        bff<void>('/v1/auth/reauthenticate', {
          method: 'POST',
          body: { password: values.password },
        }),
      start: (codeChallenge) =>
        bff<ImpersonationStartResponse>('/v1/admin/impersonations', {
          method: 'POST',
          body: {
            targetUserId: target.id,
            reason: values.reason,
            ticketReference: values.ticketReference,
            codeChallenge,
          },
        }),
      end: (id) => bff(`/v1/admin/impersonations/${id}/end`, { method: 'POST' }),
    })
      .then((info) => {
        popup?.focus();
        onStarted(info);
      })
      .catch((failure: unknown) => {
        setError(failure);
        setConnecting(false);
      })
      .finally(() => void queryClient.invalidateQueries({ queryKey: ACTIVE_IMPERSONATIONS_KEY }));
  }

  return (
    <Dialog
      open
      title={t('impersonation.admin.startTitle', { name: target.fullName })}
      description={t('impersonation.admin.intro', { app })}
      // Closing mid-hand-off would leave the outcome unseen; it finishes or fails on its own.
      onClose={connecting ? () => undefined : onClose}
    >
      <form noValidate className="flex flex-col gap-4" onSubmit={submit}>
        {error instanceof HandoffError ? (
          <Alert variant="destructive">{t(`impersonation.admin.failure.${error.reason}`)}</Alert>
        ) : (
          <ErrorAlert error={error} />
        )}
        <ul className="list-disc space-y-1 ps-5 text-sm text-muted-foreground">
          <li>
            {t('impersonation.admin.duration', { minutes: IMPERSONATION_MAX_DURATION_MINUTES })}
          </li>
          <li>{t('impersonation.admin.recorded')}</li>
          <li>{t('impersonation.admin.notified')}</li>
        </ul>
        <div className="flex flex-col gap-2">
          <Label htmlFor={reasonId}>{t('impersonation.admin.reason')}</Label>
          <Textarea
            id={reasonId}
            name="reason"
            rows={3}
            required
            disabled={connecting}
            aria-invalid={Boolean(reasonError)}
            aria-describedby={reasonError ? `${reasonId}-error` : undefined}
          />
          {reasonError ? (
            <p id={`${reasonId}-error`} className="text-sm text-destructive">
              {reasonError}
            </p>
          ) : null}
        </div>
        <FormField
          name="ticketReference"
          label={t('impersonation.admin.ticket')}
          hint={t('impersonation.admin.ticketHint')}
          disabled={connecting}
          error={fieldErrors.ticketReference}
        />
        <FormField
          name="password"
          type="password"
          autoComplete="current-password"
          label={t('impersonation.admin.password')}
          hint={t('impersonation.admin.passwordHint')}
          disabled={connecting}
          error={fieldErrors.password}
        />
        {connecting ? (
          <p role="status" className="text-sm font-medium">
            {t('impersonation.admin.connecting', { app })}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={connecting}>
            {t('users.cancel')}
          </Button>
          <Button type="submit" disabled={connecting}>
            {t('impersonation.admin.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
