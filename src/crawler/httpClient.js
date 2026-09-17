import { Buffer } from 'node:buffer';
import { config } from '../config/index.js';
import { decodeBody } from './encoding.js';

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/**
 * A network failure with its real reason attached.
 *
 * `fetch` throws a bare "fetch failed" and hides what actually went wrong in
 * `error.cause`. That is how a website sat in the dashboard for days saying
 * "fetch failed", which tells nobody whether the domain does not resolve, the
 * certificate expired or the server simply never answered.
 */
export class NetworkError extends Error {
  constructor(url, cause) {
    const reason = describeCause(cause);
    super(reason ? `${reason} para ${url}` : `No se pudo conectar con ${url}`);
    this.name = 'NetworkError';
    this.code = cause?.code ?? cause?.cause?.code ?? null;
    this.url = url;
    this.cause = cause;
  }
}

/** The human sentence behind an undici/OpenSSL error code. */
const CAUSES = {
  ENOTFOUND: 'El dominio no existe o no resuelve (DNS)',
  EAI_AGAIN: 'El DNS no respondió a tiempo',
  ECONNREFUSED: 'El servidor rechazó la conexión',
  ECONNRESET: 'El servidor cortó la conexión',
  EHOSTUNREACH: 'No hay ruta hasta el servidor',
  ENETUNREACH: 'La red no alcanza el servidor',
  EPROTO: 'Fallo de protocolo TLS',
  ETIMEDOUT: 'El servidor no respondió a tiempo',
  UND_ERR_CONNECT_TIMEOUT: 'La conexión caducó antes de abrirse',
  UND_ERR_HEADERS_TIMEOUT: 'El servidor no envió las cabeceras a tiempo',
  UND_ERR_SOCKET: 'La conexión se cerró de forma inesperada',
  CERT_HAS_EXPIRED: 'El certificado del servidor ha caducado',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'El certificado del servidor es autofirmado',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'No se pudo verificar el certificado del servidor',
  ERR_TLS_CERT_ALTNAME_INVALID: 'El certificado no corresponde a este dominio',
  SELF_SIGNED_CERT_IN_CHAIN: 'La cadena de certificados está autofirmada',
};

function describeCause(cause) {
  const code = cause?.code ?? cause?.cause?.code;
  if (code && CAUSES[code]) return `${CAUSES[code]} (${code})`;
  if (code) return `Error de red ${code}`;
  const message = cause?.message ?? cause?.cause?.message;
  return message && message !== 'fetch failed' ? message : '';
}

/** Refuse to buffer a response that is clearly not a page. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * El resto de cabeceras, y las que deliberadamente NO se mandan.
 *
 * Medido, no supuesto: fetch() no deja fijar `sec-fetch-mode`. Es una cabecera
 * que la propia especificación controla, y undici la reescribe a "cors". Un
 * navegador que ABRE una página manda siempre "navigate"; "cors" es lo que
 * manda una llamada de fondo. Enviar el resto del juego sec-fetch/sec-ch-ua
 * junto a un "cors" produce una combinación que ningún navegador genera
 * jamás, y eso delata al cliente ante un cortafuegos con más claridad que no
 * mandarlas. Así que no se mandan: lo que queda es coherente y cierto.
 */
const BROWSER_HEADERS = {
  'accept-language': 'sv-SE,sv;q=0.9,es;q=0.8,en;q=0.7',
  'upgrade-insecure-requests': '1',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
};

export const userAgent = () => config.crawler.userAgent;

/** Las cookies que el servidor acaba de dar, listas para devolvérselas. */
function cookiesFrom(response) {
  const jar = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const pairs = jar
    .map((line) => String(line).split(';')[0].trim())
    .filter((pair) => pair.includes('='));
  return pairs.length ? pairs.join('; ') : '';
}

/** El mismo sitio escrito de la otra manera: con www o sin él. */
function otherHost(url) {
  try {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.startsWith('www.')
      ? parsed.hostname.slice(4)
      : `www.${parsed.hostname}`;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Una sola petición, sin reintentos. Lo que antes era fetchText entero. */
async function once(url, { timeoutMs, accept, cookie }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        ...BROWSER_HEADERS,
        'user-agent': userAgent(),
        accept: accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(cookie ? { cookie } : {}),
      },
    });
    if (!response.ok) {
      const error = new HttpError(response.status, url);
      error.cookies = cookiesFrom(response);
      throw error;
    }

    const contentType = response.headers.get('content-type') || '';
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > MAX_BYTES) throw new Error(`Respuesta demasiado grande (${raw.length} bytes) en ${url}`);

    return {
      body: decodeBody(raw, { contentType }),
      bytes: raw.length,
      finalUrl: response.url || url,
      contentType,
    };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Timeout after ${timeoutMs}ms for ${url}`);
    // "fetch failed" on its own is not a diagnosis. Unwrap it once, here, so
    // every caller and the dashboard get the reason instead of the wrapper.
    if (error instanceof TypeError && error.message === 'fetch failed') {
      throw new NetworkError(url, error.cause);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Los códigos en los que un segundo intento tiene sentido de verdad. */
const WORTH_A_COOKIE = new Set([401, 403, 429, 503]);

/**
 * Descarga una página, con exactamente dos segundas oportunidades.
 *
 * Ninguna de las dos es un apaño para un sitio concreto: son las dos formas
 * en que un servidor sano rechaza una primera petición perfectamente legítima.
 *
 *   1. El cortafuegos contesta 403 y de paso deja una cookie (Cloudflare pone
 *      __cf_bm así). Un navegador la guarda y vuelve a pedir; este cliente no
 *      lo hacía, así que se quedaba fuera para siempre. Se reintenta UNA vez
 *      devolviéndole lo que acaba de dar.
 *
 *   2. La conexión ni se abre. Muchísimos dominios publican sólo "www" o sólo
 *      el dominio pelado, y la lista guarda el otro. Se prueba el gemelo UNA
 *      vez, y sólo cuando el fallo es de conexión: si el servidor respondió
 *      algo, respondió, y no hay nada que adivinar.
 *
 * Como mucho una petición extra. El crawler recorre veintisiete sitios dos
 * veces al día: duplicar el tráfico por si acaso sería una falta de respeto.
 */
export async function fetchText(url, { timeoutMs = config.crawler.timeoutMs, accept, retry = true } = {}) {
  try {
    return await once(url, { timeoutMs, accept });
  } catch (error) {
    if (!retry) throw error;

    if (error instanceof HttpError && WORTH_A_COOKIE.has(error.status) && error.cookies) {
      return once(url, { timeoutMs, accept, cookie: error.cookies });
    }

    if (error instanceof NetworkError) {
      const twin = otherHost(url);
      if (twin && twin !== url) {
        // Si el gemelo tampoco abre, el error que se cuenta es el original:
        // el que interesa es el de la dirección que está en la lista.
        return once(twin, { timeoutMs, accept }).catch(() => {
          throw error;
        });
      }
    }

    throw error;
  }
}
