import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AUTH_TRANSPORT_HEADER, IDEMPOTENCY_HEADER } from '@coobra/shared';
import type { AppConfig } from './config/env.js';

export const API_PREFIX = 'v1';

/** HTTP-level setup shared by the real server and the integration tests. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet());
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', AUTH_TRANSPORT_HEADER, IDEMPOTENCY_HEADER],
    maxAge: 600,
  });
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health', 'health/ready'] });
  app.enableShutdownHooks();
}
