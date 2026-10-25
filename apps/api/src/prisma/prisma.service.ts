import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@coobra/database';
import { APP_CONFIG, type AppConfig } from '../config/env.js';

/** Owns the single Prisma client. Connects lazily, so the API boots without a database. */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = createPrismaClient({ connectionString: config.databaseUrl });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
