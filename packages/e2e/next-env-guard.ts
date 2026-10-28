import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * The isolated admin (`next dev` with distDir .next-e2e) rewrites apps/admin-web/next-env.d.ts,
 * which the developer's own `next dev` also uses. prepare-db.mjs saves it before any server
 * starts; this restores it after the run.
 */
const file = new URL('../../apps/admin-web/next-env.d.ts', import.meta.url);
const backup = new URL('./.auth/next-env.d.ts.backup', import.meta.url);

export function restoreNextEnv() {
  if (existsSync(backup)) writeFileSync(file, readFileSync(backup));
}
