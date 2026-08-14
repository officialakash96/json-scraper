import { assertHttpUrl, assertPublicTarget } from './urlGuard.js';
import { config } from './config.js';

/**
 * This is the user's console snippet, generalised to querySelectorAll so that
 * pages carrying several JSON blocks are not truncated to the first one.
 * It is injected verbatim into the page context (same thing as pasting it in
 * the DevTools Console tab), so it also sees JSON injected after page load.
 */
export const CONSOLE_SNIPPET = `() => {
  const selectors = ['script[type="application/ld+json"]', 'script[type="application/json"]'];
  const results = [];
  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((scriptTag, index) => {
      if (!scriptTag || !scriptTag.textContent) return;
      results.push({
        selector,
        index,
        id: scriptTag.id || null,
        type: scriptTag.getAttribute('type'),
        text: scriptTag.textContent
      });
    });
  }
  return { url: location.href, title: document.title, results };
}`;

/**
 * Some sites (Zoho Recruit, Nuxt, Apollo, Redux SSR) never use a JSON script
 * tag and instead assign data to a global. A pristine iframe window gives the
 * baseline of built-in keys so only page-defined globals are reported.
 */
export const GLOBALS_SNIPPET = `(maxBytes, maxCount) => {
  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  document.documentElement.appendChild(frame);
  const builtins = new Set(Object.getOwnPropertyNames(frame.contentWindow));
  frame.remove();

  const KNOWN = /^(__NEXT_DATA__|__NUXT__|__APOLLO_STATE__|__INITIAL_STATE__|__PRELOADED_STATE__|__data|jobs|job|posts|products|items|results|records|listings|pageData|initialData|appData)$/i;
  const DATAISH = /(job|post|product|article|item|record|listing|detail|content|page|state|data|search)/i;
  const LIBRARYISH = /(i18n|locale|mapping|validator|util|component|icon|entity|config|toolbar|mixin|fingerprint|countr|esapi|lyte|zia|crux|csrf|polyfill|sdk|analytics|gtm|dataLayer|sentry|bugsnag|datadog|core-js|webpack|chunk)/i;

  const candidates = [];
  for (const name of Object.getOwnPropertyNames(window)) {
    if (builtins.has(name)) continue;
    let value;
    try { value = window[name]; } catch (e) { continue; }
    if (!value || typeof value !== 'object') continue;
    if (value instanceof Node || value instanceof Window || typeof value.nodeType === 'number') continue;

    const isArray = Array.isArray(value);
    if (isArray ? value.length === 0 : Object.keys(value).length < 2) continue;

    // Library namespaces are numerous and useless here, so rank first and skip
    // serialising the losers — JSON.stringify on a multi-MB vendor blob is slow.
    let score = 0;
    if (KNOWN.test(name)) score += 1000;
    if (/^__.+__$/.test(name)) score += 500;
    if (isArray) score += 200;
    if (isArray && value.length && typeof value[0] === 'object' && value[0] !== null) score += 200;
    if (DATAISH.test(name)) score += 100;
    if (LIBRARYISH.test(name)) score -= 400;
    if (score < 0) continue;

    candidates.push({ name, value, score });
  }

  candidates.sort((a, b) => b.score - a.score);

  const results = [];
  for (const candidate of candidates) {
    if (results.length >= maxCount) break;
    let text;
    try { text = JSON.stringify(candidate.value); } catch (e) { continue; }
    if (!text || text.length < 100 || text.length > maxBytes) continue;
    results.push({ name: candidate.name, text });
  }
  return results;
}`;

async function loadChromium() {
  try {
    const mod = await import('playwright');
    return mod.chromium;
  } catch {
    throw new Error('Browser mode needs Playwright. Run: npm i playwright && npx playwright install chromium');
  }
}

/* ------------------------------------------------------------------ *
 * Shared browser: launching Chromium costs ~1.5s, so one instance is
 * reused across requests and shut down after a period of inactivity.
 * ------------------------------------------------------------------ */
let browserPromise = null;
let idleTimer = null;
let inFlight = 0;

function scheduleShutdown() {
  clearTimeout(idleTimer);
  if (config.browser.idleShutdownMs <= 0) return;
  idleTimer = setTimeout(() => {
    if (inFlight === 0) closeBrowser();
  }, config.browser.idleShutdownMs);
  idleTimer.unref?.();
}

async function getBrowser(headless) {
  if (!browserPromise) {
    browserPromise = loadChromium().then((chromium) =>
      chromium.launch({
        headless,
        args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu']
      })
    );
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  const browser = await browserPromise;
  if (!browser.isConnected()) {
    browserPromise = null;
    return getBrowser(headless);
  }
  return browser;
}

export async function closeBrowser() {
  clearTimeout(idleTimer);
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  await pending.then((b) => b.close()).catch(() => {});
}

/* Simple semaphore so N parallel requests can't spawn unbounded tabs. */
const queue = [];
async function acquireSlot() {
  if (inFlight < config.browser.maxConcurrent) {
    inFlight++;
    return;
  }
  await new Promise((resolve) => queue.push(resolve));
  inFlight++;
}
function releaseSlot() {
  inFlight--;
  queue.shift()?.();
}

/**
 * Headless-browser path: renders the page, runs JS, then evaluates the snippet
 * in the page console context. Use for SPA / client-rendered sites.
 */
export async function fetchDynamic(rawUrl, options = {}) {
  const {
    timeout = config.browser.timeout,
    waitUntil = 'domcontentloaded',
    allowPrivate = config.allowPrivate,
    headless = true,
    waitMs = 0,
    selectorTimeout = config.browser.selectorTimeout,
    userAgent = config.userAgent,
    includeGlobals = true,
    maxGlobalBytes = config.browser.maxGlobalBytes,
    maxGlobals = config.browser.maxGlobals
  } = options;

  const url = assertHttpUrl(rawUrl);
  await assertPublicTarget(url, { allowPrivate });

  await acquireSlot();
  let context;
  try {
    const browser = await getBrowser(headless);
    context = await browser.newContext({
      locale: 'en-US',
      userAgent,
      viewport: { width: 1440, height: 900 },
      javaScriptEnabled: true
    });
    context.setDefaultTimeout(timeout);
    const page = await context.newPage();

    // Styling, media and tracking add seconds and never carry JSON.
    const BLOCKED_HOSTS = /(google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|segment\.io|mixpanel|clarity\.ms|newrelic|sentry\.io|intercom|zohopublic\.com\/analytics)/i;
    await page.route('**/*', (route) => {
      const request = route.request();
      const type = request.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type) || BLOCKED_HOSTS.test(request.url())) {
        return route.abort();
      }
      return route.continue();
    });

    const response = await page.goto(url.href, { waitUntil, timeout });

    // `networkidle` hangs on pages with polling/analytics, and waiting for full
    // DOMContentLoaded means waiting on every blocking vendor script. Instead:
    // stop as soon as a known data global exists, otherwise once parsing is
    // done and a JSON tag is present (covers SPAs that inject it after load).
    await page
      .waitForFunction(
        () => {
          const known = ['__NEXT_DATA__', '__NUXT__', '__APOLLO_STATE__', '__INITIAL_STATE__', '__PRELOADED_STATE__', 'jobs'];
          if (known.some((name) => window[name] && typeof window[name] === 'object')) return true;
          if (document.readyState === 'loading') return false;
          return !!(
            document.querySelector('script[type="application/ld+json"]') ||
            document.querySelector('script[type="application/json"]')
          );
        },
        undefined,
        { timeout: selectorTimeout, polling: 150 }
      )
      .catch(() => {});

    if (waitMs > 0) await page.waitForTimeout(waitMs);

    // A string is evaluated as an expression, so the snippet must be invoked.
    const evaluated = await page.evaluate(`(${CONSOLE_SNIPPET})()`);
    const globals = includeGlobals
      ? await page.evaluate(`(${GLOBALS_SNIPPET})(${maxGlobalBytes}, ${maxGlobals})`).catch(() => [])
      : [];

    // Serialising a multi-MB DOM is expensive, so only do it when there is
    // nothing to show and the HTML fallback is actually needed.
    const needsHtml = evaluated.results.length === 0 && globals.length === 0;
    const html = needsHtml ? await page.content() : '';

    return {
      status: response ? response.status() : null,
      finalUrl: evaluated.url,
      title: evaluated.title,
      html,
      bytes: html.length,
      consoleBlocks: evaluated.results,
      globals,
      mode: 'browser'
    };
  } finally {
    await context?.close().catch(() => {});
    releaseSlot();
    scheduleShutdown();
  }
}
