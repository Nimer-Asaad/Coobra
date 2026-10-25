import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Loads the monorepo root `.env` (if present) without overriding variables already set. */
export function loadRootEnvFile(): void {
  const file = fileURLToPath(new URL('../../../../.env', import.meta.url));
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}
