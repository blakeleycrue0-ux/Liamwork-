import { XMLParser } from 'fast-xml-parser';
import { fetchText } from '../httpClient.js';
import { dedupeItems, toItem } from '../normalize.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

const asArray = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

const textOf = (node) => {
  if (node === undefined || node === null) return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object') return node['#text'] ?? null;
  return null;
};

const linkOf = (node) => {
  const link = node.link;
  if (typeof link === 'string') return link;
  // Atom: <link rel="alternate" href="..."/>
  for (const candidate of asArray(link)) {
    if (typeof candidate === 'string') return candidate;
    if (candidate?.['@_href'] && (!candidate['@_rel'] || candidate['@_rel'] === 'alternate')) {
      return candidate['@_href'];
    }
  }
  return textOf(link) ?? node.guid?.['#text'] ?? (typeof node.guid === 'string' ? node.guid : null);
};

/** Parses an RSS 2.0 / Atom / RDF document into canonical items. */
export function parseFeed(xml, baseUrl) {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel ?? doc?.['rdf:RDF'] ?? doc?.feed ?? null;
  if (!channel) return [];

  const entries = [
    ...asArray(channel.item),
    ...asArray(channel.entry),
    ...asArray(doc?.['rdf:RDF']?.item),
  ];

  return dedupeItems(
    entries.map((entry) =>
      toItem(
        {
          title: textOf(entry.title) ?? entry.title,
          url: linkOf(entry),
          guid: textOf(entry.guid) ?? textOf(entry.id) ?? null,
          publishedAt:
            textOf(entry.pubDate) ??
            textOf(entry.published) ??
            textOf(entry.updated) ??
            textOf(entry['dc:date']),
          excerpt: textOf(entry.description) ?? textOf(entry.summary),
        },
        baseUrl,
      ),
    ),
  );
}

export async function fetchViaRss(website, { feedUrl } = {}) {
  const target = feedUrl || website.selector_config?.feed_url || website.url;
  const { body, finalUrl } = await fetchText(target, {
    accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
  });
  const items = parseFeed(body, finalUrl);
  if (!items.length) throw new Error(`No items found in feed ${target}`);
  return { items, method: 'rss', source: target };
}
