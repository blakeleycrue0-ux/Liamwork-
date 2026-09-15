import crypto from 'node:crypto';

export const cleanText = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

export function absoluteUrl(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

/** Removes tracking noise so the same post always hashes to the same value. */
export function canonicalUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref)/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch {
    return url;
  }
}

export function parseDate(value) {
  if (!value) return null;
  const raw = cleanText(value);
  if (!raw) return null;
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  // dd/mm/yyyy or dd-mm-yyyy (common on Spanish sites)
  const match = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (match) {
    const [, d, m, y] = match;
    const parsed = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

/**
 * Identity of a publication. Prefers an explicit guid, then the canonical URL,
 * and finally the title - so a site without permalinks still de-duplicates.
 */
export function contentHash({ guid, url, title }) {
  const basis = guid || canonicalUrl(url) || cleanText(title).toLowerCase();
  return crypto.createHash('sha256').update(String(basis)).digest('hex');
}

/** Shapes a raw fetcher result into the canonical item used everywhere else. */
export function toItem({ title, url, guid, publishedAt, excerpt }, baseUrl) {
  const cleanTitle = cleanText(title);
  const resolved = canonicalUrl(absoluteUrl(url, baseUrl));
  if (!cleanTitle && !resolved) return null;
  return {
    title: cleanTitle || resolved,
    url: resolved,
    guid: guid ? cleanText(guid) : null,
    publishedAt: parseDate(publishedAt),
    excerpt: excerpt ? cleanText(excerpt).slice(0, 500) : null,
    contentHash: contentHash({ guid, url: resolved, title: cleanTitle }),
  };
}

export function dedupeItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item || seen.has(item.contentHash)) continue;
    seen.add(item.contentHash);
    result.push(item);
  }
  return result;
}
