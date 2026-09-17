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
 * The rest of the headers a browser sends.
 *
 * A request carrying only a User-Agent and an Accept is recognisable as a bot
 * from the header list alone, and some WAFs answer 403 on that basis without
 * ever looking at the page. These go to EVERY site, so there is no per-site
 * special case to maintain and no site is treated differently from the others.
 */
const BROWSER_HEADERS = {
  'accept-language': 'sv-SE,sv;q=0.9,es;q=0.8,en;q=0.7',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'upgrade-insecure-requests': '1',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

export const userAgent = () => config.crawler.userAgent;

/**
 * Small wrapper around fetch with timeout, UA and redirect handling.
 * Every fetcher goes through here, so timeouts and - more importantly -
 * character decoding behave identically everywhere.
 *
 * The body is read as BYTES and decoded by src/crawler/encoding.js rather
 * than by `response.text()`. `response.text()` believes the Content-Type
 * header, and a server that declares ISO-8859-1 while sending UTF-8 is
 * exactly how "Välkommen" became "VÃ¤lkommen" in the emails.
 */
export async function fetchText(url, { timeoutMs = config.crawler.timeoutMs, accept } = {}) {
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
      },
    });
    if (!response.ok) throw new HttpError(response.status, url);

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
