export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

export const DETECTION_METHODS = ['auto', 'rss', 'html', 'browser', 'ai'];
const SELECTOR_KEYS = ['feed_url', 'list', 'title', 'link', 'date', 'wait_for'];

export function parseWebsitePayload(body, { partial = false } = {}) {
  const data = {};

  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new ValidationError('El nombre es obligatorio');
    data.name = name.slice(0, 120);
  }

  if (body.url !== undefined || !partial) {
    const raw = String(body.url ?? '').trim();
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new ValidationError('La URL no es válida');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ValidationError('La URL debe empezar por http:// o https://');
    }
    data.url = parsed.toString();
  }

  if (body.active !== undefined) data.active = Boolean(body.active);
  else if (!partial) data.active = true;

  if (body.check_interval !== undefined || !partial) {
    const interval = Number.parseInt(body.check_interval ?? 60, 10);
    if (!Number.isFinite(interval) || interval < 10 || interval > 86400) {
      throw new ValidationError('El intervalo debe estar entre 10 y 86400 segundos');
    }
    data.check_interval = interval;
  }

  if (body.detection_method !== undefined || !partial) {
    const method = String(body.detection_method ?? 'auto');
    if (!DETECTION_METHODS.includes(method)) {
      throw new ValidationError(`Método de detección no válido (${DETECTION_METHODS.join(', ')})`);
    }
    data.detection_method = method;
  }

  if (body.selector_config !== undefined) {
    const raw = body.selector_config;
    const source = typeof raw === 'string' ? safeJson(raw) : raw ?? {};
    const selectors = {};
    for (const key of SELECTOR_KEYS) {
      const value = String(source?.[key] ?? '').trim();
      if (value) selectors[key] = value.slice(0, 500);
    }
    if (selectors.feed_url) {
      try {
        selectors.feed_url = new URL(selectors.feed_url).toString();
      } catch {
        throw new ValidationError('La URL del RSS no es válida');
      }
    }
    data.selector_config = selectors;
  } else if (!partial) {
    data.selector_config = {};
  }

  if (body.notes !== undefined) data.notes = String(body.notes).slice(0, 1000) || null;
  return data;
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new ValidationError('selector_config debe ser un JSON válido');
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseWorkerPayload(body, { partial = false } = {}) {
  const data = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new ValidationError('El nombre es obligatorio');
    data.name = name.slice(0, 120);
  }
  if (body.email !== undefined || !partial) {
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new ValidationError('El email no es válido');
    data.email = email.slice(0, 200);
  }
  if (body.active !== undefined) data.active = Boolean(body.active);
  else if (!partial) data.active = true;
  return data;
}
