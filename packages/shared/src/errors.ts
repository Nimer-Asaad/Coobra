/**
 * Stable, machine-readable error codes returned by the API.
 * Clients translate them with the `errors.<CODE>` i18n keys.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_ACCOUNT_DISABLED',
  'AUTH_ROLE_NOT_ALLOWED_FOR_APP',
  'AUTH_EMAIL_NOT_VERIFIED',
  'AUTH_EMAIL_ALREADY_REGISTERED',
  'AUTH_EMAIL_ALREADY_VERIFIED',
  'AUTH_TOKEN_INVALID',
  'CSRF_ORIGIN_REJECTED',
  'SHIPMENT_INVALID_TRANSITION',
  'SHIPMENT_CONCURRENT_UPDATE',
  'SHIPMENT_MERCHANT_INVALID',
  'SHIPMENT_DRIVER_INVALID',
  'SHIPMENT_COD_MISMATCH',
  'PRICING_UNAVAILABLE',
  'PRICE_CHANGED',
  'QUOTE_INVALID',
  'ZONE_INVALID',
  'ZONE_INACTIVE',
  'ORIGIN_ZONE_REQUIRED',
  'FEE_OVERRIDE_NOT_ALLOWED',
  'CONFLICT',
  'SELF_APPROVAL_FORBIDDEN',
  'USER_SELF_CHANGE_FORBIDDEN',
  'LAST_SUPER_ADMIN',
  'USER_ROLE_NOT_CHANGEABLE',
  'USER_CHANGED',
  'APPROVAL_LIMIT_EXCEEDED',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_IN_PROGRESS',
  'COD_EXCEEDS_EXPECTED',
  'INVALID_STATE',
  'INSUFFICIENT_FUNDS',
  'DUPLICATE_POSTING',
  /** Phase 4C impersonation (ADR 0003). */
  'IMPERSONATION_FORBIDDEN_ACTION',
  'IMPERSONATION_NOT_ALLOWED',
  'IMPERSONATION_ACTIVE',
  'IMPERSONATION_CONFLICT',
  'IMPERSONATION_CODE_INVALID',
  'REAUTH_REQUIRED',
  'CONSEQUENCE_CONFIRMATION_REQUIRED',
  'CONSEQUENCE_CHANGED',
  /** The admin BFF could not reach the API (outage or restart). */
  'SERVICE_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  statusCode: number;
  code: ErrorCode;
  /** Developer-facing message (English). Never show it to end users; translate `code` instead. */
  message: string;
  /** For VALIDATION_FAILED: field path -> i18n key of the validation message. */
  fieldErrors?: Record<string, string>;
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ApiErrorBody).code === 'string' &&
    typeof (value as ApiErrorBody).statusCode === 'number'
  );
}
