import 'server-only';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { isApiErrorBody, type ApiErrorBody, type MeResponse } from '@coobra/shared';
import { ADMIN_SESSION_COOKIE } from './constants';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
  }
}

function apiUrl(): string {
  const url = process.env.API_URL;
  if (!url) throw new Error('API_URL is not configured for the admin web app');
  return url;
}

/** Server-to-server call to the COOBRA API. */
export async function apiFetch(path: string, init: RequestInit & { token?: string } = {}) {
  const { token, headers, ...rest } = init;
  return fetch(new URL(path, apiUrl()), {
    ...rest,
    cache: 'no-store',
    headers: {
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

export async function readApiError(response: Response): Promise<ApiErrorBody> {
  const body: unknown = await response.json().catch(() => null);
  return isApiErrorBody(body)
    ? body
    : { statusCode: response.status, code: 'INTERNAL_ERROR', message: 'Unexpected API response' };
}

export async function getSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
}

/** The current admin session, validated by the API on every request. Null when signed out. */
export const getCurrentSession = cache(async (): Promise<MeResponse | null> => {
  const token = await getSessionToken();
  if (!token) return null;
  const response = await apiFetch('/v1/auth/me', { token });
  if (response.status === 401) return null;
  if (!response.ok) throw new ApiRequestError(response.status, await readApiError(response));
  return (await response.json()) as MeResponse;
});
