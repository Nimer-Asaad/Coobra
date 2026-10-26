import { describe, expect, it } from 'vitest';
import {
  loginSchema,
  passwordSchema,
  registerMerchantSchema,
  toFieldErrors,
  createUserSchema,
  phoneSchema,
} from './validation.js';

const validMerchant = {
  fullName: 'Nimer Asaad',
  businessName: 'Coobra Store',
  email: '  Merchant@Example.COM ',
  phone: '+970599000000',
  password: 'correct-horse-42',
  language: 'ar',
};

describe('registerMerchantSchema', () => {
  it('accepts a valid merchant and normalizes the email', () => {
    const result = registerMerchantSchema.parse(validMerchant);
    expect(result.email).toBe('merchant@example.com');
  });

  it('strips unknown fields such as a role escalation attempt', () => {
    const result = registerMerchantSchema.parse({ ...validMerchant, role: 'SUPER_ADMIN' });
    expect(result).not.toHaveProperty('role');
  });

  it('returns i18n keys for invalid fields', () => {
    const result = registerMerchantSchema.safeParse({
      ...validMerchant,
      email: 'not-an-email',
      password: 'short',
      language: 'fr',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(toFieldErrors(result.error)).toEqual({
        email: 'validation.email.invalid',
        password: 'validation.password.tooShort',
        language: 'validation.language.invalid',
      });
    }
  });
});

describe('passwordSchema', () => {
  it.each([
    ['onlyletterspassword', 'validation.password.needsNumber'],
    ['1234567890123', 'validation.password.needsLetter'],
    ['a1'.repeat(65), 'validation.password.tooLong'],
  ])('rejects %s', (password, key) => {
    const result = passwordSchema.safeParse(password);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe(key);
  });

  it('accepts Arabic letters and digits', () => {
    expect(passwordSchema.safeParse('كلمةسرقوية١٢٣').success).toBe(true);
  });
});

describe('loginSchema', () => {
  it('requires a known client app', () => {
    const result = loginSchema.safeParse({ email: 'a@b.co', password: 'x', clientApp: 'OTHER' });
    expect(result.success).toBe(false);
  });
});

describe('createUserSchema', () => {
  it('does not allow creating merchants through the admin flow', () => {
    const result = createUserSchema.safeParse({
      fullName: 'Someone',
      email: 'a@b.co',
      role: 'MERCHANT',
      language: 'en',
    });
    expect(result.success).toBe(false);
  });
});

// QA BUG-001: account phones must accept the same input as recipient phones.
describe('phoneSchema (account phones)', () => {
  it.each([
    ['٠٥٩٩١١١٢٢٢', '0599111222'],
    ['۰۵۹۹۱۱۱۲۲۲', '0599111222'],
    ['059-911 1222', '0599111222'],
    ['00970599111222', '+970599111222'],
    ['+970599111222', '+970599111222'],
  ])('normalises %s to %s', (input, expected) => {
    expect(phoneSchema.parse(input)).toBe(expected);
  });

  it('still rejects invalid numbers', () => {
    expect(phoneSchema.safeParse('05x9').success).toBe(false);
    expect(phoneSchema.safeParse('١٢٣').success).toBe(false);
  });

  it('normalises on merchant registration and on staff/driver accounts', () => {
    expect(registerMerchantSchema.parse({ ...validMerchant, phone: '٠٥٩٩١١١٢٢٢' }).phone).toBe(
      '0599111222',
    );
    expect(
      createUserSchema.parse({
        fullName: 'Driver',
        email: 'd@b.co',
        role: 'DRIVER',
        language: 'ar',
        phone: '٠٥٩٩٠٠٠٠٠٢',
      }).phone,
    ).toBe('0599000002');
  });
});
