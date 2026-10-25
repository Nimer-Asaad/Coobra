export const SUPPORTED_LANGUAGES = ['ar', 'en'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export type TextDirection = 'rtl' | 'ltr';

const RTL_LANGUAGES: readonly Language[] = ['ar'];

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

export function isRtlLanguage(language: Language): boolean {
  return RTL_LANGUAGES.includes(language);
}

export function directionOf(language: Language): TextDirection {
  return isRtlLanguage(language) ? 'rtl' : 'ltr';
}
