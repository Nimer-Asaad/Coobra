import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@coobra/shared';
import { ar, createI18n, en } from './index.js';

function flatKeys(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === 'string' ? [`${prefix}${key}`] : flatKeys(child as object, `${prefix}${key}.`),
  );
}

describe('locales', () => {
  it('Arabic and English define the same keys', () => {
    expect(flatKeys(ar).sort()).toEqual(flatKeys(en).sort());
  });

  it('every API error code is translated', () => {
    for (const code of ERROR_CODES) {
      expect(en.errors).toHaveProperty(code);
      expect(ar.errors).toHaveProperty(code);
    }
  });

  it('translates synchronously with interpolation', () => {
    const t = createI18n('ar').t;
    expect(t('home.welcome', { name: 'نمر' })).toBe('مرحباً، نمر');
    expect(createI18n('en').t('validation.password.tooShort', { min: 10 })).toBe(
      'Password must be at least 10 characters.',
    );
  });
});
