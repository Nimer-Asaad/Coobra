import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRootEnvFile } from '../src/config/load-env-file.js';

/** Applies the committed migrations to the dedicated test database (a real PostgreSQL). */
export default function setup(): void {
  loadRootEnvFile();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests need a real PostgreSQL database ' +
        '(see docker-compose.yml). They are never run against SQLite or mocks.',
    );
  }
  const databaseDir = fileURLToPath(new URL('../../../packages/database', import.meta.url));
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: databaseDir,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
