'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorAlert } from '@/components/error-alert';
import { Button } from '@/components/ui/button';
import { ClientApiError, newIdempotencyKey } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { translateValidation } from '@coobra/i18n';

/** Signed money, red when negative. */
export function Amount({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  const { i18n } = useTranslation();
  if (value === null || value === undefined) return <span className={className}>—</span>;
  return (
    <span
      className={`${value.startsWith('-') ? 'text-destructive' : ''} tabular-nums ${className ?? ''}`}
    >
      {formatMoney(value, i18n.language)}
    </span>
  );
}

/**
 * Mutation for a money-moving action. One Idempotency-Key per user action: retries after a
 * network error reuse it, so the server never applies the same action twice.
 */
export function useFinanceAction<TInput, TResult>(
  run: (input: TInput, idempotencyKey: string) => Promise<TResult>,
  invalidate: string[][] = [['admin', 'finance']],
) {
  const queryClient = useQueryClient();
  const key = useRef<string | null>(null);
  return useMutation({
    mutationFn: (input: TInput) => {
      key.current ??= newIdempotencyKey();
      return run(input, key.current);
    },
    onSuccess: () => {
      key.current = null;
      for (const queryKey of invalidate) void queryClient.invalidateQueries({ queryKey });
    },
  });
}

/** True inside an InlineAction whose form changed since the last attempt. */
const FormEditedContext = createContext(false);

function FieldErrorText({ children }: { children: ReactNode }) {
  const edited = useContext(FormEditedContext);
  return edited ? null : <p className="text-sm text-destructive">{children}</p>;
}

/** Field errors returned by the API for a form (validation keys → translated text). */
export function useFieldError(error: unknown) {
  const { t } = useTranslation();
  return function renderFieldError(name: string) {
    const key = error instanceof ClientApiError ? error.body.fieldErrors?.[name] : undefined;
    return key ? <FieldErrorText>{translateValidation(t, key)}</FieldErrorText> : null;
  };
}

/**
 * A button that opens a small inline form; closes on success and confirms what happened.
 * An error from the last attempt is hidden as soon as the user edits the form, so it never
 * describes input that is no longer there.
 */
export function InlineAction({
  label,
  variant = 'outline',
  pending,
  error,
  onSubmit,
  children,
  submitLabel,
  successMessage,
}: {
  label: string;
  variant?: 'outline' | 'default' | 'destructive' | 'ghost';
  pending: boolean;
  error: unknown;
  onSubmit: (form: FormData) => Promise<unknown> | void;
  children?: ReactNode;
  submitLabel?: string;
  /** Shown after success; defaults to a generic "Saved." */
  successMessage?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [edited, setEdited] = useState(false);
  if (!open) {
    return (
      <div className="flex flex-col items-start gap-2">
        {done ? (
          <p role="status" className="text-sm text-emerald-700">
            {successMessage ?? t('finance.actionDone')}
          </p>
        ) : null}
        <Button
          size="sm"
          variant={variant}
          onClick={() => {
            setDone(false);
            setEdited(true);
            setOpen(true);
          }}
        >
          {label}
        </Button>
      </div>
    );
  }
  const visibleError = edited ? null : error;
  return (
    <form
      noValidate
      className="flex w-full flex-col gap-2 rounded-md border p-3"
      onChange={() => setEdited(true)}
      onFocus={(event) => {
        // Prefilled amounts (counted cash, corrected fee) are replaced, not appended to.
        const target = event.target;
        if (target instanceof HTMLInputElement && target.inputMode === 'decimal') target.select();
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        setEdited(false);
        try {
          await onSubmit(new FormData(event.currentTarget));
          setOpen(false);
          setDone(true);
        } catch {
          // Shown below through `error`.
        }
      }}
    >
      <p className="text-sm font-medium">{label}</p>
      <FormEditedContext.Provider value={edited}>{children}</FormEditedContext.Provider>
      {visibleError instanceof ClientApiError && visibleError.body.fieldErrors ? null : (
        <ErrorAlert error={visibleError} />
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          type="submit"
          variant={variant === 'destructive' ? 'destructive' : 'default'}
          disabled={pending}
        >
          {submitLabel ?? t('finance.confirm')}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

export function StatusPill({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'warn' | 'ok' | 'bad';
}) {
  const tones = {
    muted: 'bg-muted text-foreground',
    warn: 'bg-amber-100 text-amber-900',
    ok: 'bg-emerald-100 text-emerald-900',
    bad: 'bg-red-100 text-red-900',
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}
