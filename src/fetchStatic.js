import { assertHttpUrl, assertPublicTarget } from './urlGuard.js';
import { config } from './config.js';

const HTML_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain|application\/json|text\/xml|application\/xml)/i;

/** Streams the body so a hostile or huge page cannot exhaust memory. */
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Response too large (${declared} bytes, limit ${maxBytes})`);
  }
  if (!res.body) return '';

  const decoder = new TextDecoder('utf-8');
  const reader = res.body.getReader();
  let received = 0;
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response exceeded ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestOnce(rawUrl, { timeout, maxBytes, maxRedirects, userAgent, allowPrivate }) {
  let current = assertHttpUrl(rawUrl);
  let redirects = 0;

  for (;;) {
    // Re-checked on every hop: a public URL can redirect to 169.254.169.254.
    await assertPublicTarget(current, { allowPrivate });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9'
        }
      });
    } catch (err) {
      clearTimeout(timer);
      throw err.name === 'AbortError' ? new Error(`Request timed out after ${timeout}ms`) : err;
    }

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      clearTimeout(timer);
      await res.body?.cancel().catch(() => {});
      if (++redirects > maxRedirects) throw new Error(`Too many redirects (>${maxRedirects})`);
      current = assertHttpUrl(new URL(location, current).href);
      continue;
    }

    try {
      const contentType = res.headers.get('content-type') || '';
      if (contentType && !HTML_TYPES.test(contentType)) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`Unsupported content-type "${contentType.split(';')[0]}"`);
      }
      const html = await readCapped(res, maxBytes);
      return { status: res.status, finalUrl: current.href, html, bytes: html.length, mode: 'static' };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Plain HTTP fetch — fast path, works when JSON is in the server-rendered HTML. */
export async function fetchStatic(rawUrl, options = {}) {
  const settings = {
    timeout: options.timeout ?? config.static.timeout,
    maxBytes: options.maxBytes ?? config.static.maxBytes,
    maxRedirects: options.maxRedirects ?? config.static.maxRedirects,
    userAgent: options.userAgent ?? config.userAgent,
    allowPrivate: options.allowPrivate ?? config.allowPrivate
  };
  const retries = options.retries ?? config.static.retries;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await requestOnce(rawUrl, settings);
      if ((result.status === 429 || result.status >= 500) && attempt < retries) {
        lastError = new Error(`Upstream returned ${result.status}`);
        await sleep(500 * 2 ** attempt);
        continue;
      }
      return result;
    } catch (err) {
      lastError = err;
      const retryable = /timed out|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(err.message);
      if (!retryable || attempt === retries) throw err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}
