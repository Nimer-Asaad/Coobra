import { restoreNextEnv } from './next-env-guard';

/** prepare-db.mjs saved next-env.d.ts before any server started; put it back afterwards. */
export default function globalSetup() {
  return () => restoreNextEnv();
}
