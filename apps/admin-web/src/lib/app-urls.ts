import 'server-only';
import type { ImpersonationTargetRole } from '@coobra/shared';

/** Where an impersonation opens, by target role; null when not configured. */
export type ImpersonationAppUrls = Record<ImpersonationTargetRole, string | null>;

const DEVELOPMENT_DEFAULTS: ImpersonationAppUrls = {
  MERCHANT: 'http://localhost:8082',
  DRIVER: 'http://localhost:8081',
};

function origin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * The merchant and driver web apps (the same MERCHANT_APP_URL and DRIVER_APP_URL the API uses).
 * Local development falls back to the default ports; production must configure both, otherwise
 * the console does not offer impersonation.
 */
export function impersonationAppUrls(): ImpersonationAppUrls {
  const production = process.env.NODE_ENV === 'production';
  return {
    MERCHANT:
      origin(process.env.MERCHANT_APP_URL) ?? (production ? null : DEVELOPMENT_DEFAULTS.MERCHANT),
    DRIVER: origin(process.env.DRIVER_APP_URL) ?? (production ? null : DEVELOPMENT_DEFAULTS.DRIVER),
  };
}
