import { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { toFieldErrors } from '@coobra/shared';
import { Errors } from './app-exception.js';

/** Validates and parses a request value with a shared zod schema. */
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.output<TSchema> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) throw Errors.validation(toFieldErrors(result.error));
    return result.data;
  }
}
