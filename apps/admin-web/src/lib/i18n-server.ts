import 'server-only';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { createI18n } from '@coobra/i18n';
import { isLanguage, type Language } from '@coobra/shared';
import { LANGUAGE_COOKIE } from './constants';

/** The language chosen by the user, or null if they have not chosen yet. */
export const getChosenLanguage = cache(async (): Promise<Language | null> => {
  const value = (await cookies()).get(LANGUAGE_COOKIE)?.value;
  return isLanguage(value) ? value : null;
});

export async function getServerT() {
  const language = (await getChosenLanguage()) ?? 'en';
  return { t: createI18n(language).t, language };
}
