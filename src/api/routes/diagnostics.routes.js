import { Router } from 'express';
import { config } from '../../config/index.js';
import { getDb } from '../../db/index.js';
import { readyError } from '../../bootstrap.js';

/**
 * Public self-check: says whether the app can reach its database and which
 * auth provider it is using. No secrets, no data - just enough to tell a
 * misconfiguration from a real failure without digging through logs.
 */
export const diagnosticsRoutes = Router();

diagnosticsRoutes.get('/', async (req, res) => {
  const startup = readyError();
  const result = {
    ok: false,
    auth: {
      provider: config.auth.provider,
      supabase_url: config.supabase.url || null,
      anon_key_configured: Boolean(config.supabase.anonKey),
      service_role_configured: Boolean(config.supabase.serviceKey),
    },
    database: { driver: config.db.driver, ok: false, error: null },
    mail: { transport: config.mail.transport },
    startup_error: startup ? startup.message.slice(0, 300) : null,
    server_time: new Date().toISOString(),
  };

  const withTimeout = (promise, ms) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`sin respuesta tras ${ms}ms`)), ms).unref?.(),
      ),
    ]);

  try {
    const db = await withTimeout(getDb(), 6000);
    await withTimeout(db.get('SELECT 1 AS ok'), 6000);
    const websites = await withTimeout(db.get('SELECT COUNT(*) AS n FROM websites'), 6000);
    result.database.ok = true;
    result.database.websites = Number(websites?.n ?? 0);
  } catch (error) {
    result.database.error = String(error.message).slice(0, 300);
  }

  result.ok = result.database.ok && !result.startup_error;
  res.status(result.ok ? 200 : 503).json(result);
});
