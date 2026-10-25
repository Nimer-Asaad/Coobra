import { Injectable } from '@nestjs/common';
import { argon2id, hash, needsRehash, verify } from 'argon2';

/** OWASP-recommended Argon2id parameters (19 MiB memory, 2 iterations, 1 lane). */
const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  /** Used to spend equal time on logins for unknown emails (prevents user enumeration by timing). */
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  needsRehash(passwordHash: string): boolean {
    return needsRehash(passwordHash, ARGON2_OPTIONS);
  }

  async verifyAgainstDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('coobra-dummy-password-for-timing');
    await this.verify(await this.dummyHash, password);
  }
}
