'use server';

import { cookies } from 'next/headers';
import { isLanguage } from '@coobra/shared';
import { apiFetch, getSessionToken } from '@/lib/api-server';
import { LANGUAGE_COOKIE, LANGUAGE_COOKIE_MAX_AGE } from '@/lib/constants';

/** Persists the UI language in a cookie and, when signed in, on the user's account. */
export async function setLanguageAction(language: string): Promise<void> {
  if (!isLanguage(language)) throw new Error('Unsupported language');
  (await cookies()).set(LANGUAGE_COOKIE, language, {
    path: '/',
    sameSite: 'lax',
    maxAge: LANGUAGE_COOKIE_MAX_AGE,
    secure: process.env.NODE_ENV === 'production',
  });
  const token = await getSessionToken();
  if (token) {
    await apiFetch('/v1/me/preferences', {
      method: 'PATCH',
      token,
      body: JSON.stringify({ language }),
    }).catch(() => undefined);
  }
}
