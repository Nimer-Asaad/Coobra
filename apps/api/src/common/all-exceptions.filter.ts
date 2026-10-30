import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import type { ApiErrorBody, ErrorCode } from '@coobra/shared';
import { AppException } from './app-exception.js';
import { redactForLog } from './log-redaction.js';

const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
};

/** Normalises every error into the `ApiErrorBody` shape and never leaks internals. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body = this.toBody(exception);
    if (body.statusCode >= 500) {
      this.logger.error(redactForLog(exception));
    }
    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ApiErrorBody {
    if (exception instanceof AppException) return exception.toBody();
    if (exception instanceof ThrottlerException) {
      return { statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests' };
    }
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const code = STATUS_CODES[statusCode];
      if (code) return { statusCode, code, message: exception.message };
      if (statusCode < 500) {
        // e.g. malformed JSON bodies rejected by the body parser.
        return { statusCode: 400, code: 'VALIDATION_FAILED', message: exception.message };
      }
    }
    return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
  }
}
