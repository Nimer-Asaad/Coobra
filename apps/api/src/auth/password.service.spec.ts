import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with Argon2id and verifies the right password only', async () => {
    const hash = await service.hash('correct-horse-42');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toMatch(/m=19456,p=1,t=2/);
    await expect(service.verify(hash, 'correct-horse-42')).resolves.toBe(true);
    await expect(service.verify(hash, 'wrong-horse-42')).resolves.toBe(false);
    expect(service.needsRehash(hash)).toBe(false);
  });

  it('produces a different salt for every hash', async () => {
    const [a, b] = await Promise.all([
      service.hash('same-password-1'),
      service.hash('same-password-1'),
    ]);
    expect(a).not.toBe(b);
  });

  it('returns false instead of throwing for malformed hashes', async () => {
    await expect(service.verify('not-a-hash', 'x')).resolves.toBe(false);
  });
});
