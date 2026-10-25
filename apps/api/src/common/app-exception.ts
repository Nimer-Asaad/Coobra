import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorBody, ErrorCode } from '@coobra/shared';

/** An HTTP error with a stable, translatable error code. */
export class AppException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ErrorCode,
    message: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message, status);
  }

  toBody(): ApiErrorBody {
    return {
      statusCode: this.getStatus(),
      code: this.code,
      message: this.message,
      ...(this.fieldErrors ? { fieldErrors: this.fieldErrors } : {}),
    };
  }
}

export const Errors = {
  unauthenticated: () =>
    new AppException(HttpStatus.UNAUTHORIZED, 'UNAUTHENTICATED', 'Authentication required'),
  forbidden: () => new AppException(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Insufficient permissions'),
  invalidCredentials: () =>
    new AppException(
      HttpStatus.UNAUTHORIZED,
      'AUTH_INVALID_CREDENTIALS',
      'Invalid email or password',
    ),
  accountDisabled: () =>
    new AppException(HttpStatus.FORBIDDEN, 'AUTH_ACCOUNT_DISABLED', 'Account is disabled'),
  roleNotAllowedForApp: () =>
    new AppException(
      HttpStatus.FORBIDDEN,
      'AUTH_ROLE_NOT_ALLOWED_FOR_APP',
      'This role cannot sign in to the requested application',
    ),
  emailNotVerified: () =>
    new AppException(
      HttpStatus.FORBIDDEN,
      'AUTH_EMAIL_NOT_VERIFIED',
      'Email address is not verified',
    ),
  emailAlreadyRegistered: () =>
    new AppException(
      HttpStatus.CONFLICT,
      'AUTH_EMAIL_ALREADY_REGISTERED',
      'Email is already registered',
    ),
  emailAlreadyVerified: () =>
    new AppException(
      HttpStatus.CONFLICT,
      'AUTH_EMAIL_ALREADY_VERIFIED',
      'Email is already verified',
    ),
  tokenInvalid: () =>
    new AppException(HttpStatus.BAD_REQUEST, 'AUTH_TOKEN_INVALID', 'Token is invalid or expired'),
  csrfOriginRejected: () =>
    new AppException(HttpStatus.FORBIDDEN, 'CSRF_ORIGIN_REJECTED', 'Request origin is not allowed'),
  validation: (fieldErrors: Record<string, string>) =>
    new AppException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Validation failed', fieldErrors),
};
