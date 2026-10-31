import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AUTH_TRANSPORT_HEADER, IDEMPOTENCY_HEADER, IMPERSONATION_HEADER } from '@coobra/shared';
import { proxyTrustMonitor } from './common/proxy-trust.js';
import type { AppConfig } from './config/env.js';

export const API_PREFIX = 'v1';
/** Routes served without the prefix (load balancer and orchestrator probes). */
export const API_PREFIX_EXCLUDE = ['health', 'health/ready'];

/** HTTP-level setup shared by the real server and the integration tests. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.set('trust proxy', config.trustProxy);
  app.use(proxyTrustMonitor(config.trustProxy));
  app.disable('x-powered-by');
  app.use(helmet());
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: [
      'content-type',
      'authorization',
      AUTH_TRANSPORT_HEADER,
      IDEMPOTENCY_HEADER,
      // Phase 4C: sent only by an app tab that is impersonating (ADR 0003 §8.2).
      IMPERSONATION_HEADER,
    ],
    maxAge: 600,
  });
  app.setGlobalPrefix(API_PREFIX, { exclude: API_PREFIX_EXCLUDE });
  app.enableShutdownHooks();
}
