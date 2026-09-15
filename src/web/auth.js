/* Shared authentication helper for the dashboard and the login page. */

const STORAGE_KEY = 'wm.auth.session';
let configPromise = null;

export function authConfig() {
  if (!configPromise) {
    configPromise = fetch('/api/auth/config')
      .then((response) => response.json())
      .catch(() => ({ provider: 'local', supabase: null }));
  }
  return configPromise;
}

const readStored = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeStored = (session) => {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage disabled */
  }
};

const store = (tokens) =>
  writeStored({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    // 60 s of margin so a request never travels with an almost-expired token.
    expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000 - 60_000,
    user: tokens.user ? { id: tokens.user.id, email: tokens.user.email } : null,
  });

async function supabaseToken(supabase, grant, body) {
  const response = await fetch(`${supabase.url}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: supabase.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error_description || data.msg || data.message || 'No se pudo iniciar sesión');
  }
  store(data);
  return data;
}

/** Email + password sign-in against Supabase Auth. */
export async function signIn(email, password) {
  const { provider, supabase } = await authConfig();
  if (provider !== 'supabase') throw new Error('Este despliegue no usa Supabase');
  return supabaseToken(supabase, 'password', { email, password });
}

/** Returns a valid access token, refreshing it when it is about to expire. */
export async function accessToken() {
  const session = readStored();
  if (!session) return null;
  if (session.expires_at > Date.now()) return session.access_token;

  const { supabase } = await authConfig();
  try {
    const refreshed = await supabaseToken(supabase, 'refresh_token', {
      refresh_token: session.refresh_token,
    });
    return refreshed.access_token;
  } catch {
    writeStored(null);
    return null;
  }
}

export const storedUser = () => readStored()?.user ?? null;
export const clearSession = () => writeStored(null);
