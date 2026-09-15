import { config } from '../../config/index.js';
import { extractFromHtml } from './html.fetcher.js';

/**
 * Headless-browser fetcher for websites that render their listing with
 * JavaScript. Playwright is an OPTIONAL dependency: it is imported lazily so
 * the rest of the system runs without it. Enable with:
 *
 *   npm install playwright && npx playwright install chromium
 *
 * and set the website's detection_method to "browser".
 */
let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      let playwright;
      try {
        // Non-literal specifier on purpose: bundlers (esbuild on Netlify) must
        // not try to resolve this optional dependency at build time.
        const moduleName = 'playwright';
        playwright = await import(moduleName);
      } catch {
        throw new Error(
          'detection_method "browser" requires Playwright. Run: npm install playwright && npx playwright install chromium',
        );
      }
      return playwright.chromium.launch({ headless: true });
    })();
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch {
    /* already closed */
  } finally {
    browserPromise = null;
  }
}

export async function fetchViaBrowser(website) {
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: config.crawler.userAgent });
  const page = await context.newPage();
  try {
    await page.goto(website.url, { waitUntil: 'networkidle', timeout: config.crawler.timeoutMs });
    const waitFor = website.selector_config?.wait_for || website.selector_config?.list;
    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: config.crawler.timeoutMs }).catch(() => {});
    }
    const html = await page.content();
    const items = extractFromHtml(html, page.url(), website.selector_config || {});
    return { items, method: 'browser', source: website.url };
  } finally {
    await context.close();
  }
}
