import { config } from '../config/index.js';

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * Small wrapper around fetch with timeout, UA and redirect handling.
 * Every fetcher goes through here so timeouts behave consistently.
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
        'accept-language': 'es,en;q=0.8',
      },
    });
    if (!response.ok) throw new HttpError(response.status, url);
    const body = await response.text();
    return { body, finalUrl: response.url || url, contentType: response.headers.get('content-type') || '' };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Timeout after ${timeoutMs}ms for ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
