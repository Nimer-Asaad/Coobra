import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    SESSION_TTL_HOURS_ADMIN: z.coerce.number().positive().default(12),
    SESSION_TTL_DAYS_MOBILE: z.coerce.number().positive().default(30),
    COOKIE_SECURE: booleanString.default(false),
    RATE_LIMIT_ENABLED: booleanString.default(true),
    ADMIN_WEB_URL: z.url(),
    MERCHANT_APP_URL: z.url(),
    DRIVER_APP_URL: z.url(),
    MAIL_TRANSPORT: z.enum(['smtp', 'log']).default('smtp'),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    SMTP_SECURE: booleanString.default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().min(3),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (!env.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true in production',
      });
    }
    if (env.MAIL_TRANSPORT !== 'smtp') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message: 'must be smtp in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  port: number;
  databaseUrl: string;
  corsOrigins: string[];
  trustProxy: number;
  session: {
    adminTtlMs: number;
    mobileTtlMs: number;
    cookieSecure: boolean;
  };
  rateLimitEnabled: boolean;
  links: {
    adminWebUrl: string;
    merchantAppUrl: string;
    driverAppUrl: string;
  };
  mail: {
    transport: Env['MAIL_TRANSPORT'];
    from: string;
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      user?: string;
      password?: string;
    };
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

const HOUR_MS = 60 * 60 * 1000;

/** Parses and validates environment variables. Throws a readable error listing every problem. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const env = result.data;
  return {
    nodeEnv: env.NODE_ENV,
    port: env.API_PORT,
    databaseUrl: env.DATABASE_URL,
    corsOrigins: env.CORS_ORIGINS,
    trustProxy: env.TRUST_PROXY,
    session: {
      adminTtlMs: env.SESSION_TTL_HOURS_ADMIN * HOUR_MS,
      mobileTtlMs: env.SESSION_TTL_DAYS_MOBILE * 24 * HOUR_MS,
      cookieSecure: env.COOKIE_SECURE,
    },
    rateLimitEnabled: env.RATE_LIMIT_ENABLED,
    links: {
      adminWebUrl: env.ADMIN_WEB_URL,
      merchantAppUrl: env.MERCHANT_APP_URL,
      driverAppUrl: env.DRIVER_APP_URL,
    },
    mail: {
      transport: env.MAIL_TRANSPORT,
      from: env.MAIL_FROM,
      smtp: {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
      },
    },
  };
}
