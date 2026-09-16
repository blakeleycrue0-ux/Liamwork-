import { ValidationError } from './validate.js';

const URL_RE = /https?:\/\/\S+/i;

/** A readable club name out of a bare domain: "brohofslott.com" -> "Brohofslott". */
const nameFromUrl = (url) => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const label = host.split('.')[0].replace(/[-_]/g, ' ');
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch {
    return url;
  }
};

/**
 * Parses a pasted list of websites. Accepts the shapes people actually paste:
 *
 *   Albatross                        (name on its own line, URL on the next)
 *   https://www.albatrossgolfklubb.se/
 *
 *   Bro Hof  https://brohofslott.com (name and URL on one line)
 *   https://bgk.se/                  (just the URL; the name is derived)
 *
 * Never throws on a single bad line: it reports it and keeps going, because
 * losing 26 good entries over one typo would be absurd.
 */
export function parseWebsiteList(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ValidationError('Pega la lista de webs');
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const entries = [];
  const problems = [];
  let pendingName = null;

  for (const line of lines) {
    const match = line.match(URL_RE);

    if (!match) {
      // A line that was clearly meant to be an address but is malformed gets
      // reported; anything else is simply the name of what comes next.
      const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/*/i.test(line) || (!/\s/.test(line) && /\.[a-z]{2,}/i.test(line));
      if (looksLikeUrl) problems.push(line);
      else pendingName = line;
      continue;
    }

    const url = match[0].replace(/[),.;]+$/, '');
    const inlineName = line.slice(0, match.index).trim().replace(/[-–—:|]+$/, '').trim();
    const name = inlineName || pendingName || nameFromUrl(url);
    pendingName = null;

    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocolo');
      entries.push({ name: name.slice(0, 120), url: parsed.toString() });
    } catch {
      problems.push(line);
    }
  }

  if (!entries.length) throw new ValidationError('No se ha encontrado ninguna URL válida en la lista');

  // Same URL twice in one paste: keep the first.
  const seen = new Set();
  const unique = entries.filter((entry) => {
    const key = entry.url.replace(/\/+$/, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { entries: unique, problems };
}
