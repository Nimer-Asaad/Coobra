import { IDEMPOTENCY_HEADER, isApiErrorBody, type ApiErrorBody } from '@coobra/shared';

/** Error thrown by browser-side API calls; `body` carries the translatable error code. */
export class ClientApiError extends Error {
  constructor(readonly body: ApiErrorBody) {
    super(body.message);
  }
}

/**
 * Browser calls go to this app's own route handlers (BFF). The session token stays
 * in an httpOnly cookie and is attached server-side.
 */
export async function clientFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.idempotencyKey) headers[IDEMPOTENCY_HEADER] = init.idempotencyKey;
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ClientApiError(
      isApiErrorBody(body)
        ? body
        : { statusCode: response.status, code: 'INTERNAL_ERROR', message: 'Unexpected response' },
    );
  }
  return body as T;
}

/** Calls an API endpoint through the generic BFF proxy, e.g. `bff('/v1/admin/users')`. */
export function bff<T>(
  apiPath: string,
  init?: { method?: string; body?: unknown; idempotencyKey?: string },
) {
  return clientFetch<T>(`/api/bff${apiPath}`, init);
}

/** A fresh key per user action; retries of the same action must reuse it. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
