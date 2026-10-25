'use client';

import { useId, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { translateValidation } from '@coobra/i18n';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface FormFieldProps extends ComponentProps<'input'> {
  label: string;
  /** i18n key of the validation error, e.g. `validation.email.invalid`. */
  error?: string;
  hint?: string;
}

export function FormField({ label, error, hint, ...inputProps }: FormFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  const message = translateValidation(t, error);
  const describedBy = message ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={Boolean(message)}
        aria-describedby={describedBy}
        {...inputProps}
      />
      {message ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {message}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
