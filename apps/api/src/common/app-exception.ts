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
  notFound: () => new AppException(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found'),
  shipmentInvalidTransition: () =>
    new AppException(
      HttpStatus.CONFLICT,
      'SHIPMENT_INVALID_TRANSITION',
      'This status change is not allowed from the current status',
    ),
  shipmentConcurrentUpdate: () =>
    new AppException(
      HttpStatus.CONFLICT,
      'SHIPMENT_CONCURRENT_UPDATE',
      'The shipment was changed by someone else; reload and try again',
    ),
  shipmentMerchantInvalid: () =>
    new AppException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'SHIPMENT_MERCHANT_INVALID',
      'Merchant does not exist or is not active',
    ),
  shipmentDriverInvalid: () =>
    new AppException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'SHIPMENT_DRIVER_INVALID',
      'Driver does not exist or is not active',
    ),
  shipmentCodMismatch: () =>
    new AppException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'SHIPMENT_COD_MISMATCH',
      'Collected amount does not match the expected cash on delivery',
    ),
  pricingUnavailable: () =>
    new AppException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'PRICING_UNAVAILABLE',
      'No pricing rule applies to this route; an administrator must configure one',
    ),
  priceChanged: () =>
    new AppException(
      HttpStatus.CONFLICT,
      'PRICE_CHANGED',
      'The price for this route changed since the quote; request a new quote',
    ),
  quoteInvalid: () =>
    new AppException(
      HttpStatus.CONFLICT,
      'QUOTE_INVALID',
      'The quote is expired, already used or does not match this shipment',
    ),
  zoneInvalid: () =>
    new AppException(HttpStatus.UNPROCESSABLE_ENTITY, 'ZONE_INVALID', 'Zone does not exist'),
  zoneInactive: () =>
    new AppException(HttpStatus.UNPROCESSABLE_ENTITY, 'ZONE_INACTIVE', 'Zone is not active'),
  originZoneRequired: () =>
    new AppException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'ORIGIN_ZONE_REQUIRED',
      'No pickup zone: set the merchant pickup zone or choose an origin zone',
    ),
  feeOverrideNotAllowed: () =>
    new AppException(
      HttpStatus.CONFLICT,
      'FEE_OVERRIDE_NOT_ALLOWED',
      'The fee can no longer be changed directly in the current shipment status',
    ),
  conflict: (message: string) => new AppException(HttpStatus.CONFLICT, 'CONFLICT', message),
  userSelfChangeForbidden: () =>
    new AppException(
      HttpStatus.FORBIDDEN,
      'USER_SELF_CHANGE_FORBIDDEN',
      'You cannot deactivate your own account or change your own role',
    ),
  lastSuperAdmin: () =>
    new AppException(
      HttpStatus.CONFLICT,
      'LAST_SUPER_ADMIN',
      'The last active super admin cannot be deactivated or demoted',
    ),
  userRoleNotChangeable: () =>
    new AppException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'USER_ROLE_NOT_CHANGEABLE',
      'Only staff roles can be changed; drivers and merchants keep their role',
    ),
  userChanged: () =>
    new AppException(
      HttpStatus.CONFLICT,
      'USER_CHANGED',
      'This user was changed by someone else; reload and try again',
    ),
  selfApprovalForbidden: () =>
    new AppException(
      HttpStatus.FORBIDDEN,
      'SELF_APPROVAL_FORBIDDEN',
      'The person who created or proposed this cannot approve it',
    ),
  approvalLimitExceeded: () =>
    new AppException(
      HttpStatus.FORBIDDEN,
      'APPROVAL_LIMIT_EXCEEDED',
      'This amount is above your approval limit; a SUPER_ADMIN must approve it',
    ),
  idempotencyKeyRequired: () =>
    new AppException(
      HttpStatus.BAD_REQUEST,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Send an Idempotency-Key header (8-100 characters) with this request',
    ),
  idempotencyKeyReused: () =>
    new AppException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for a different request',
    ),
  idempotencyInProgress: () =>
    new AppException(
      HttpStatus.CONFLICT,
      'IDEMPOTENCY_IN_PROGRESS',
      'A request with this Idempotency-Key is still being processed',
    ),
  codExceedsExpected: () =>
    new AppException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'COD_EXCEEDS_EXPECTED',
      'The amount is more than the outstanding cash on delivery',
    ),
  invalidState: (message: string) =>
    new AppException(HttpStatus.CONFLICT, 'INVALID_STATE', message),
  insufficientFunds: (message: string) =>
    new AppException(HttpStatus.UNPROCESSABLE_ENTITY, 'INSUFFICIENT_FUNDS', message),
  duplicatePosting: () =>
    new AppException(HttpStatus.CONFLICT, 'DUPLICATE_POSTING', 'This was already posted'),
};
