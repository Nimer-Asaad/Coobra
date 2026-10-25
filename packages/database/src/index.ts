import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export * from './generated/prisma/client.js';

export interface CreatePrismaClientOptions {
  connectionString: string;
  log?: ('query' | 'info' | 'warn' | 'error')[];
}

/** Creates a Prisma client backed by the `pg` driver adapter. Connects lazily on first query. */
export function createPrismaClient({
  connectionString,
  log,
}: CreatePrismaClientOptions): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: log ?? ['warn', 'error'],
  });
}
