'use client';

import { useState } from 'react';
import type { z } from 'zod';
import { toFieldErrors } from '@coobra/shared';
import { ClientApiError } from './api-client';

/** Validates with a shared schema and merges field errors returned by the API. */
export function useFormErrors() {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function validate<TSchema extends z.ZodType>(
    schema: TSchema,
    values: unknown,
  ): z.output<TSchema> | null {
    const result = schema.safeParse(values);
    if (!result.success) {
      setFieldErrors(toFieldErrors(result.error));
      return null;
    }
    setFieldErrors({});
    return result.data;
  }

  function applyApiError(error: unknown) {
    if (error instanceof ClientApiError && error.body.fieldErrors) {
      setFieldErrors(error.body.fieldErrors);
    }
  }

  return { fieldErrors, validate, applyApiError };
}
