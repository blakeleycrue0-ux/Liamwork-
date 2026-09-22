import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicConfig } from './public.config.js';

// NOT named __dirname: bundlers for serverless (Netlify) inject their own
// __dirname, and two declarations in the same scope are a SyntaxError that
// stops the whole function from loading.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(moduleDir, '..', '..');

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * La dirección pública del panel: la que va en el botón "See every change"
 * del correo y en el "View change" de Slack.
 *
 * Por qué NO basta con APP_BASE_URL: es una variable que hay que acordarse de
 * poner, y cuando se olvida el enlace no falla de forma ruidosa - se queda en
 * http://localhost:3000, que para quien recibe el correo significa su propio
 * ordenador. Pulsa y le sale "no se puede conectar al servidor", sin ninguna
 * pista de por qué. Pasó de verdad.
 *
 * Netlify define URL en todos los despliegues, y este proyecto ya se fía de
 * ella para lanzar la revisión de fondo (status.routes.js). Así que el correo
 * se fía también, y configurar APP_BASE_URL pasa a ser opcional: sólo hace
 * falta si el panel vive en un dominio propio.
 *
 * Y UNA EXCEPCIÓN A "LO ESCRITO A MANO MANDA": si lo escrito a mano es una
 * dirección local y la plataforma nos está dando una pública, gana la
 * pública. No es una corrección arbitraria del gusto de nadie: un enlace a
 * localhost dentro de un correo es incorrecto por definición, porque el
 * destinatario nunca es esta máquina. Y es un error fácil de cometer, porque
 * .env.example trae esa línea literal y copiarla a Netlify es lo natural.
 *
 * En local no cambia nada: ahí no hay URL de plataforma, así que localhost
 * sobrevive, que es lo que se quiere.
 */

/** ¿Apunta esto a la propia máquina, y por tanto no sirve para un correo? */
const isLocalAddress = (value) => {
  try {
    const { hostname } = new URL(value);
    return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
};

export function resolveAppBaseUrl(env = process.env) {
  const tidy = (value) => String(value ?? '').trim().replace(/\/+$/, '');

  const configured = tidy(env.APP_BASE_URL);
  // La que da la plataforma. En Netlify, URL es el dominio principal del
  // sitio y DEPLOY_PRIME_URL el del despliegue de rama.
  const platform = tidy(env.URL) || tidy(env.DEPLOY_PRIME_URL);

  if (configured && !(isLocalAddress(configured) && platform)) return configured;
  return platform || 'http://localhost:3000';
}

const APP_BASE_URL = resolveAppBaseUrl();

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
    // 'sqlite' for local development, 'postgres' (Supabase) everywhere else.
    driver:
      (process.env.DB_DRIVER || '').toLowerCase() ||
      (process.env.DATABASE_URL ||
      process.env.NETLIFY ||
      // Inside a serverless function NETLIFY is not set, but the Lambda
      // runtime always exposes these. SQLite is never an option there: the
      // filesystem is read-only and gone after every invocation.
      process.env.LAMBDA_TASK_ROOT ||
      process.env.AWS_LAMBDA_FUNCTION_NAME
        ? 'postgres'
        : 'sqlite'),
    file: path.resolve(ROOT_DIR, process.env.DATABASE_FILE || './data/web-monitor.sqlite'),
    // Supabase: Project Settings -> Database -> Connection string.
    connectionString: process.env.DATABASE_URL || '',
  },

  auth: {
    // 'local'    -> single admin from ADMIN_USERNAME/ADMIN_PASSWORD_HASH
    // 'supabase' -> real users managed by Supabase Auth (email + password)
    // Precedence: an explicit AUTH_PROVIDER wins; then whatever the app ships
    // with; only as a last resort is the provider inferred from SUPABASE_URL.
    // (Inferring it first meant that merely having SUPABASE_URL configured
    // silently switched a passwordless dashboard back to asking for a login.)
    provider: (
      process.env.AUTH_PROVIDER ||
      publicConfig.authProvider ||
      (process.env.SUPABASE_URL ? 'supabase' : 'local')
    ).toLowerCase(),
    username: process.env.ADMIN_USERNAME || 'admin',
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
    password: process.env.ADMIN_PASSWORD || '',
    sessionSecret: process.env.SESSION_SECRET || '',
    sessionTtl: int(process.env.SESSION_TTL, 8 * 60 * 60),
    secureCookies: bool(process.env.SECURE_COOKIES, false),
  },

  brand: {
    name: process.env.APP_NAME || publicConfig.brand?.name || 'Web Monitor',
    credit: process.env.APP_CREDIT || publicConfig.brand?.credit || 'Web Monitor',
    owner: process.env.APP_OWNER || publicConfig.brand?.owner || '',
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
    timeoutMs: int(process.env.CRAWLER_TIMEOUT_MS, 15000),
    // A bot-shaped User-Agent is enough for a WAF to answer 403 before it
    // even looks at the request - measured, on one of the watched clubs. The
    // crawler reads public pages at most twice a day, so it identifies itself
    // the way any reader's browser would. Override with CRAWLER_USER_AGENT.
    userAgent:
      process.env.CRAWLER_USER_AGENT ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/140.0.0.0 Safari/537.36',
    runInWeb: bool(process.env.RUN_SCHEDULER_IN_WEB, true),
    // Las horas UTC a las que dispara el cron. Tiene que coincidir con el
    // literal `schedule` de netlify/functions/crawl-scheduled.mts -Netlify
    // exige que aquello sea una constante-, y hay una prueba que comprueba
    // que los dos dicen lo mismo. De aquí sale el plazo con el que el panel
    // decide si una pasada se ha saltado.
    scheduleUtc: (process.env.CRAWLER_SCHEDULE_UTC || '5,21')
      .split(',')
      .map((hour) => Number.parseInt(hour.trim(), 10))
      .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23),
  },

  /**
   * Slack, opcional y sólo del lado del servidor.
   *
   * El webhook es un secreto: quien lo tenga puede publicar en el canal del
   * club. Vive SÓLO aquí, no se manda nunca al navegador y no se escribe en
   * ningún registro; el panel se entera de si existe por un booleano, jamás
   * por el valor. Si no está, todo lo demás sigue funcionando igual.
   *
   * Se configura en Netlify como SLACK_WEBHOOK_URL, que es el mismo patrón
   * que SMTP_PASSWORD o SUPABASE_SERVICE_ROLE_KEY: variable de entorno, nunca
   * public.config.json, que sí se publica.
   */
  slack: {
    webhookUrl: process.env.SLACK_WEBHOOK_URL || '',
    // Sólo para el botón "View change" del mensaje. No es un secreto.
    appBaseUrl: APP_BASE_URL,
  },

  mail: {
    transport: (process.env.MAIL_TRANSPORT || 'console').toLowerCase(),
    from: process.env.MAIL_FROM || 'Web Monitor <monitor@example.com>',
    appBaseUrl: APP_BASE_URL,
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: int(process.env.SMTP_PORT, 587),
      secure: bool(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER || '',
      password: process.env.SMTP_PASSWORD || '',
    },
  },

  seed: {
    // Publish the code-managed list (src/config/sites.js) on boot. Tests turn
    // it off so they start from an empty table.
    watched: bool(process.env.SEED_WATCHED_SITES, true),
    // Six hours: short enough that both of the day's scheduled runs find every
    // site due, long enough that a manual run does not re-read all 27 at once.
    websiteInterval: int(process.env.SEED_WEBSITE_INTERVAL, 21600),
    workerName: process.env.SEED_WORKER_NAME || 'Test Worker',
    // `??` on purpose: an empty string disables the seed, which is how tests
    // (and anyone who wants an empty install) opt out.
    workerEmail: process.env.SEED_WORKER_EMAIL ?? 'cruecrv9445@gmail.com',
  },
};

/** Fatal configuration problems (only enforced in production). */
export function validateConfig({ strict = config.isProduction } = {}) {
  const problems = [];
  // Sessions are only used by the local provider: Supabase uses bearer tokens
  // and the open mode has no login at all.
  if (config.auth.provider === 'local' && (!config.auth.sessionSecret || config.auth.sessionSecret.length < 16)) {
    problems.push('SESSION_SECRET is missing or too short (min. 16 characters).');
  }
  if (config.auth.provider === 'none') {
    // Nothing to validate: the dashboard is open.
  } else if (config.auth.provider === 'supabase') {
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
