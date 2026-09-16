import { Buffer } from 'node:buffer';
import { config } from '../config/index.js';
import { decodeBody } from './encoding.js';

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Refuse to buffer a response that is clearly not a page. */
const MAX_BYTES = 8 * 1024 * 1024;

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
        'user-agent': config.crawler.userAgent,
        accept: accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'sv,es,en;q=0.8',
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
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
