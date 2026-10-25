import { describe, expect, it } from 'vitest';
import { clientAppForRole, isRoleAllowedForApp } from './roles.js';
import { directionOf } from './language.js';

describe('roles', () => {
  it('only lets staff into the admin web app', () => {
    expect(isRoleAllowedForApp('ACCOUNTANT', 'ADMIN_WEB')).toBe(true);
    expect(isRoleAllowedForApp('MERCHANT', 'ADMIN_WEB')).toBe(false);
    expect(isRoleAllowedForApp('DRIVER', 'ADMIN_WEB')).toBe(false);
  });

  it('keeps drivers and merchants in their own apps', () => {
    expect(isRoleAllowedForApp('DRIVER', 'DRIVER_APP')).toBe(true);
    expect(isRoleAllowedForApp('DRIVER', 'MERCHANT_APP')).toBe(false);
    expect(isRoleAllowedForApp('MERCHANT', 'MERCHANT_APP')).toBe(true);
    expect(clientAppForRole('OPERATIONS')).toBe('ADMIN_WEB');
  });
});

describe('language', () => {
  it('maps Arabic to RTL and English to LTR', () => {
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
  });
});
