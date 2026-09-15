import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import publicConfig from './public.config.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..', '..');

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  env: process.env.NODE_ENV || 'development',
  get isProduction() {
    return this.env === 'production';
  },

  server: {
    port: int(process.env.PORT, 3000),
    host: process.env.HOST || '0.0.0.0',
  },

  db: {
    // 'sqlite' for local development, 'postgres' when running on Netlify
    // (or anywhere DATABASE_URL / NETLIFY_DATABASE_URL is provided).
    driver: (process.env.DB_DRIVER || '').toLowerCase() ||
      (process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL || process.env.NETLIFY
        ? 'postgres'
        : 'sqlite'),
    file: path.resolve(ROOT_DIR, process.env.DATABASE_FILE || './data/web-monitor.sqlite'),
    connectionString:
      process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL || '',
  },

  auth: {
    // 'local'    -> single admin from ADMIN_USERNAME/ADMIN_PASSWORD_HASH
    // 'supabase' -> real users managed by Supabase Auth (email + password)
    provider: (
      process.env.AUTH_PROVIDER ||
      (process.env.SUPABASE_URL ? 'supabase' : publicConfig.authProvider) ||
      'local'
    ).toLowerCase(),
    username: process.env.ADMIN_USERNAME || 'admin',
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
    password: process.env.ADMIN_PASSWORD || '',
    sessionSecret: process.env.SESSION_SECRET || '',
    sessionTtl: int(process.env.SESSION_TTL, 8 * 60 * 60),
    secureCookies: bool(process.env.SECURE_COOKIES, false),
  },

  supabase: {
    // URL and anon key ship with the app on purpose (see public.config.json);
    // environment variables override them when pointing at another project.
    url: (process.env.SUPABASE_URL || publicConfig.supabase?.url || '').replace(/\/+$/, ''),
    anonKey: process.env.SUPABASE_ANON_KEY || publicConfig.supabase?.anonKey || '',
    // Server-only: lets the dashboard list, invite and remove users.
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    // Legacy projects sign tokens with HS256 and this shared secret; newer
    // ones use asymmetric keys and are verified through JWKS.
    jwtSecret: process.env.SUPABASE_JWT_SECRET || '',
  },

  crawler: {
    schedulerTick: int(process.env.SCHEDULER_TICK, 15),
    concurrency: int(process.env.CRAWLER_CONCURRENCY, 8),
    timeoutMs: int(process.env.CRAWLER_TIMEOUT_MS, 20000),
    userAgent: process.env.CRAWLER_USER_AGENT || 'WebMonitorBot/1.0',
    runInWeb: bool(process.env.RUN_SCHEDULER_IN_WEB, true),
  },

  mail: {
    transport: (process.env.MAIL_TRANSPORT || 'console').toLowerCase(),
    from: process.env.MAIL_FROM || 'Web Monitor <monitor@example.com>',
    appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: int(process.env.SMTP_PORT, 587),
      secure: bool(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER || '',
      password: process.env.SMTP_PASSWORD || '',
    },
  },

  seed: {
    websiteName: process.env.SEED_WEBSITE_NAME || 'FFSP',
    websiteUrl: process.env.SEED_WEBSITE_URL || 'https://ffsp.info',
    websiteInterval: int(process.env.SEED_WEBSITE_INTERVAL, 60),
    workerName: process.env.SEED_WORKER_NAME || 'Test Worker',
    workerEmail: process.env.SEED_WORKER_EMAIL || 'cruecrv9445@gmail.com',
  },
};

/** Fatal configuration problems (only enforced in production). */
export function validateConfig({ strict = config.isProduction } = {}) {
  const problems = [];
  // Sessions are only used by the local provider; Supabase uses bearer tokens.
  if (config.auth.provider !== 'supabase' && (!config.auth.sessionSecret || config.auth.sessionSecret.length < 16)) {
    problems.push('SESSION_SECRET is missing or too short (min. 16 characters).');
  }
  if (config.auth.provider === 'supabase') {
    if (!config.supabase.url) problems.push('AUTH_PROVIDER=supabase requires SUPABASE_URL.');
    if (!config.supabase.anonKey) problems.push('AUTH_PROVIDER=supabase requires SUPABASE_ANON_KEY.');
  } else if (!config.auth.passwordHash && !config.auth.password) {
    problems.push('Set ADMIN_PASSWORD_HASH (recommended) or ADMIN_PASSWORD.');
  }
  if (config.mail.transport === 'smtp' && !config.mail.smtp.host) {
    problems.push('MAIL_TRANSPORT=smtp requires SMTP_HOST.');
  }
  if (problems.length && strict) {
    throw new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
  }
  return problems;
}
