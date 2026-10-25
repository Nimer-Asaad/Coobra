import { generateOpaqueToken, hashToken } from './token.util.js';

describe('token utilities', () => {
  it('generates unique 256-bit URL-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, generateOpaqueToken));
    expect(tokens.size).toBe(100);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically without storing the raw token', () => {
    const token = generateOpaqueToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });
});
