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
    /**
     * How many reverse proxies (load balancer, CDN, ingress) sit in front of the API; 0 when it is
     * reached directly. Required in production: it decides the client address used by rate limits
     * and the audit log, so it is never guessed. See docs/deployment.md.
     */
    TRUST_PROXY: z.coerce.number().int().min(0).optional(),
    SESSION_TTL_HOURS_ADMIN: z.coerce.number().positive().default(12),
    SESSION_TTL_DAYS_MOBILE: z.coerce.number().positive().default(30),
    COOKIE_SECURE: booleanString.default(false),
    RATE_LIMIT_ENABLED: booleanString.default(true),
    /** Phase 4C: closes expired impersonations and sends their summaries (every instance). */
    IMPERSONATION_SWEEPER_ENABLED: booleanString.default(true),
    /** Production impersonation (ADR 0003 R4): the API's public HTTPS URL. */
    API_PUBLIC_URL: z.url().optional(),
    /** Production impersonation (R4): the approved site every host belongs to, e.g. coobra.ps. */
    IMPERSONATION_SITE: z.string().trim().toLowerCase().optional(),
    /** Phase 4C.4: impersonated writes (ADR 0003 §4). Off unless explicitly enabled, everywhere. */
    IMPERSONATION_WRITES_ENABLED: booleanString.default(false),
    /**
     * R2 confirmation signing keys, '<kid>:<base64url secret>' separated by commas, each secret at
     * least 32 bytes; CONSEQUENCE_SIGNING_ACTIVE_KEY names the one used to sign (others verify only).
     */
    CONSEQUENCE_SIGNING_KEYS: z.string().optional(),
    CONSEQUENCE_SIGNING_ACTIVE_KEY: z.string().trim().optional(),
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
    if (env.TRUST_PROXY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message:
          'must be set in production to the number of reverse proxies in front of the API (0 if none)',
      });
    }
    if (!env.RATE_LIMIT_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['RATE_LIMIT_ENABLED'],
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
  impersonationSweeperEnabled: boolean;
  /** ADR 0003 R4: impersonation fails closed in production unless the deployment qualifies. */
  impersonation: { enabled: boolean; problems: string[] };
  /** Impersonated writes: off unless enabled, and only with a valid signing key ring (fail closed). */
  impersonationWrites: {
    enabled: boolean;
    problems: string[];
    signing: { activeKid: string; keys: Map<string, Buffer> } | null;
  };
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

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * ADR 0003 R4. In production the impersonation cookie is only safe when the API and every web
 * application are served over HTTPS on hosts of one approved site: then the cookie is first-party
 * (SameSite=Strict holds) and the exact-origin checks are meaningful. The site is set explicitly
 * by the owner (IMPERSONATION_SITE) instead of guessed, because registrable domains depend on the
 * public suffix list (e.g. example.co.uk). Any problem disables impersonation (fail closed); the
 * rest of the API is unaffected. Development and test are not checked (localhost over HTTP).
 */
/** Parses the signing key ring. Problems name settings only, never key material. */
export function consequenceSigningKeys(raw: string | undefined, active: string | undefined) {
  const problems: string[] = [];
  const keys = new Map<string, Buffer>();
  if (!raw) problems.push('CONSEQUENCE_SIGNING_KEYS is not set');
  for (const entry of (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(':');
    const kid = separator > 0 ? entry.slice(0, separator) : '';
    const secret = separator > 0 ? entry.slice(separator + 1) : '';
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid) || !/^[A-Za-z0-9_-]+$/.test(secret)) {
      problems.push('CONSEQUENCE_SIGNING_KEYS has an entry that is not <kid>:<base64url secret>');
      continue;
    }
    const bytes = Buffer.from(secret, 'base64url');
    if (bytes.length < 32) {
      problems.push(`CONSEQUENCE_SIGNING_KEYS key ${kid} is shorter than 32 bytes`);
      continue;
    }
    if (keys.has(kid)) problems.push(`CONSEQUENCE_SIGNING_KEYS repeats key id ${kid}`);
    keys.set(kid, bytes);
  }
  if (!active) problems.push('CONSEQUENCE_SIGNING_ACTIVE_KEY is not set');
  else if (!keys.has(active))
    problems.push('CONSEQUENCE_SIGNING_ACTIVE_KEY is not one of the keys');
  return problems.length === 0 && active
    ? { signing: { activeKid: active, keys }, problems }
    : { signing: null, problems };
}

function impersonationWrites(
  env: {
    IMPERSONATION_WRITES_ENABLED: boolean;
    CONSEQUENCE_SIGNING_KEYS?: string;
    CONSEQUENCE_SIGNING_ACTIVE_KEY?: string;
  } & Parameters<typeof impersonationDeployment>[0],
) {
  if (!env.IMPERSONATION_WRITES_ENABLED) {
    return { enabled: false, problems: ['IMPERSONATION_WRITES_ENABLED is false'], signing: null };
  }
  const deployment = impersonationDeployment(env);
  const { signing, problems } = consequenceSigningKeys(
    env.CONSEQUENCE_SIGNING_KEYS,
    env.CONSEQUENCE_SIGNING_ACTIVE_KEY,
  );
  const all = [...deployment.problems, ...problems];
  return { enabled: all.length === 0 && signing !== null, problems: all, signing };
}

export function impersonationDeployment(env: {
  NODE_ENV: string;
  COOKIE_SECURE: boolean;
  API_PUBLIC_URL?: string;
  IMPERSONATION_SITE?: string;
  ADMIN_WEB_URL: string;
  MERCHANT_APP_URL: string;
  DRIVER_APP_URL: string;
}): { enabled: boolean; problems: string[] } {
  if (env.NODE_ENV !== 'production') return { enabled: true, problems: [] };
  const problems: string[] = [];
  if (!env.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true');
  const site = env.IMPERSONATION_SITE;
  if (!site) problems.push('IMPERSONATION_SITE is not set');
  else if (!site.includes('.') || IPV4.test(site) || site.startsWith('.') || site.endsWith('.')) {
    problems.push('IMPERSONATION_SITE must be a domain such as example.com');
  }
  const urls: [string, string | undefined][] = [
    ['API_PUBLIC_URL', env.API_PUBLIC_URL],
    ['ADMIN_WEB_URL', env.ADMIN_WEB_URL],
    ['MERCHANT_APP_URL', env.MERCHANT_APP_URL],
    ['DRIVER_APP_URL', env.DRIVER_APP_URL],
  ];
  for (const [name, value] of urls) {
    if (!value) {
      problems.push(`${name} is not set`);
      continue;
    }
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') problems.push(`${name} must use https`);
    if (host === 'localhost' || IPV4.test(host) || host.startsWith('[')) {
      problems.push(`${name} must use a domain name`);
    } else if (site && host !== site && !host.endsWith(`.${site}`)) {
      problems.push(`${name} must be on ${site}`);
    }
  }
  return { enabled: problems.length === 0, problems };
}

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
    trustProxy: env.TRUST_PROXY ?? 0,
    session: {
      adminTtlMs: env.SESSION_TTL_HOURS_ADMIN * HOUR_MS,
      mobileTtlMs: env.SESSION_TTL_DAYS_MOBILE * 24 * HOUR_MS,
      cookieSecure: env.COOKIE_SECURE,
    },
    rateLimitEnabled: env.RATE_LIMIT_ENABLED,
    impersonationSweeperEnabled: env.IMPERSONATION_SWEEPER_ENABLED,
    impersonation: impersonationDeployment(env),
    impersonationWrites: impersonationWrites(env),
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

export interface StartupDiagnostic {
  level: 'log' | 'error';
  message: string;
}

/**
 * What the API prints at start-up about its security settings (setting names and switches only,
 * never values that could be secret). An operator can see at once why impersonation or
 * impersonated writes are off.
 */
export function startupDiagnostics(config: AppConfig): StartupDiagnostic[] {
  const on = (value: boolean) => (value ? 'on' : 'off');
  const out: StartupDiagnostic[] = [
    {
      level: 'log',
      message:
        `Security: rate limiting ${on(config.rateLimitEnabled)}, trusted proxies ${config.trustProxy}, ` +
        `impersonation ${on(config.impersonation.enabled)}, impersonated writes ${on(config.impersonationWrites.enabled)}`,
    },
  ];
  if (!config.impersonation.enabled) {
    out.push({
      level: 'error',
      message: `Impersonation is disabled: ${config.impersonation.problems.join('; ')} (ADR 0003 R4)`,
    });
  }
  const writes = config.impersonationWrites;
  const requested = !writes.problems.includes('IMPERSONATION_WRITES_ENABLED is false');
  if (requested && !writes.enabled) {
    out.push({
      level: 'error',
      message: `Impersonated writes were requested but are disabled: ${writes.problems.join('; ')}`,
    });
  }
  return out;
}
