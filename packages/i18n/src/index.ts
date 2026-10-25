import i18next, { type i18n, type TFunction } from 'i18next';
import {
  isApiErrorBody,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type Language,
} from '@coobra/shared';
import { ar } from './locales/ar.js';
import { en } from './locales/en.js';

export type { TranslationResource } from './types.js';
export { ar, en };

export const DEFAULT_NAMESPACE = 'translation';

export const resources = {
  ar: { [DEFAULT_NAMESPACE]: ar },
  en: { [DEFAULT_NAMESPACE]: en },
} as const;

/** Values interpolated into validation messages (e.g. password length limits). */
export const validationParams = {
  min: PASSWORD_MIN_LENGTH,
  max: PASSWORD_MAX_LENGTH,
} as const;

/**
 * Creates an isolated, synchronously initialised i18next instance.
 * Pass extra plugins (e.g. react-i18next's `initReactI18next`) for UI apps.
 */
export function createI18n(language: Language, plugins: Parameters<i18n['use']>[0][] = []): i18n {
  const instance = i18next.createInstance();
  for (const plugin of plugins) instance.use(plugin);
  void instance.init({
    lng: language,
    fallbackLng: 'en',
    supportedLngs: ['ar', 'en'],
    resources,
    defaultNS: DEFAULT_NAMESPACE,
    initAsync: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance;
}

/** Translates an API error (or network failure) into a user-facing message. */
export function translateError(t: TFunction, error: unknown): string {
  if (isApiErrorBody(error)) return t(`errors.${error.code}`);
  if (error instanceof Error && 'body' in error && isApiErrorBody(error.body)) {
    return t(`errors.${error.body.code}`);
  }
  return t('errors.NETWORK');
}

/** Translates a validation key such as `validation.password.tooShort`. */
export function translateValidation(t: TFunction, key: string | undefined): string | undefined {
  return key ? t(key, validationParams) : undefined;
}
