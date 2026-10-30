import {
  AUTH_TRANSPORT_HEADER,
  IDEMPOTENCY_HEADER,
  IMPERSONATION_HEADER,
  isApiErrorBody,
  type ApiErrorBody,
} from '@coobra/shared';
import { usesCookieSessions } from './storage';

export class ApiError extends Error {
  constructor(readonly body: ApiErrorBody) {
    super(body.message);
  }
}

/** Thrown when the server cannot be reached (offline, wrong API URL, CORS). */
export class NetworkError extends Error {}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Required by money-moving endpoints; reuse the same key when retrying the same action. */
  idempotencyKey?: string;
  /** Sends the impersonation header even before the tab is impersonating (the code exchange). */
  impersonation?: boolean;
}

export interface ApiClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
}

/** A key unique enough for replay protection (not a secret). */
export function newIdempotencyKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createApiClient(options: {
  apiUrl: string;
  getToken: () => string | null;
  onUnauthenticated: () => void;
  /** True while this tab acts as another account (web only, ADR 0003 §8.2). */
  isImpersonating?: () => boolean;
  /** The impersonation is no longer accepted: the tab must not fall back to the real session. */
  onImpersonationLost?: () => void;
}): ApiClient {
  return {
    async request<T>(
      path: string,
      { method = 'GET', body, idempotencyKey, impersonation }: RequestOptions = {},
    ) {
      const impersonating = Boolean(impersonation || options.isImpersonating?.());
      const headers: Record<string, string> = { accept: 'application/json' };
      if (idempotencyKey) headers[IDEMPOTENCY_HEADER] = idempotencyKey;
      // With this header the API uses only the impersonation cookie, never `coobra_session`.
      if (impersonating) headers[IMPERSONATION_HEADER] = '1';
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (usesCookieSessions) {
        headers[AUTH_TRANSPORT_HEADER] = 'cookie';
      } else {
        const token = options.getToken();
        if (token) headers.authorization = `Bearer ${token}`;
      }

      let response: Response;
      try {
        response = await fetch(`${options.apiUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: usesCookieSessions ? 'include' : 'omit',
        });
      } catch {
        throw new NetworkError('Network request failed');
      }

      if (response.status === 204) return undefined as T;
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = isApiErrorBody(data)
          ? data
          : ({
              statusCode: response.status,
              code: 'INTERNAL_ERROR',
              message: 'Unexpected response',
            } as const);
        if (error.code === 'UNAUTHENTICATED') {
          if (impersonating) options.onImpersonationLost?.();
          else options.onUnauthenticated();
        }
        throw new ApiError(error);
      }
      return data as T;
    },
  };
}
