import { fetchStatic } from './fetchStatic.js';
import { fetchDynamic } from './fetchDynamic.js';
import { cacheGet, cacheSet } from './cache.js';
import {
  extractFromHtml,
  extractDates,
  extractMetaDates,
  pickPrimaryDate,
  sanitize
} from './extract.js';

function blocksFromConsole(consoleBlocks = []) {
  return consoleBlocks.map((b) => {
    const text = sanitize(b.text);
    const base = { ...b, label: `${b.selector}[${b.index}]`, source: 'script-tag', bytes: text.length, text: undefined };
    try {
      return { ...base, parsed: true, data: JSON.parse(text), error: null, raw: null };
    } catch (err) {
      return { ...base, parsed: false, data: null, error: err.message, raw: text.slice(0, 500) };
    }
  });
}

/** Page globals (Zoho `var jobs`, `__NUXT__`, `__APOLLO_STATE__`, …). */
function blocksFromGlobals(globals = [], existing = []) {
  // Frameworks expose the same payload as both a script tag and a global;
  // keeping both doubles the response for no extra information.
  const seenIds = new Set(existing.map((b) => b.id).filter(Boolean));
  const seenSizes = new Set(existing.map((b) => b.bytes));

  return globals
    .filter((g) => !seenIds.has(g.name) && !seenSizes.has(g.text.length))
    .map((g, index) => {
      const base = {
        selector: `window.${g.name}`,
        label: `window.${g.name}`,
        source: 'js-global',
        index,
        id: g.name,
        type: 'js-global',
        bytes: g.text.length
      };
      try {
        return { ...base, parsed: true, data: JSON.parse(g.text), error: null, raw: null };
      } catch (err) {
        return { ...base, parsed: false, data: null, error: err.message, raw: g.text.slice(0, 500) };
      }
    });
}

/**
 * mode: 'static' | 'browser' | 'auto' (static first, browser only if nothing parsed)
 */
export async function scrape(url, options = {}) {
  const { mode = 'auto', dates = true, noCache = false, onProgress, ...rest } = options;
  const started = Date.now();
  const attempts = [];

  const cacheKey = `${mode}::${url}`;
  if (!noCache) {
    const hit = cacheGet(cacheKey);
    if (hit) return { ...hit, cached: true, elapsedMs: Date.now() - started };
  }

  let result = null;
  let blocks = [];

  if (mode === 'static' || mode === 'auto') {
    try {
      result = await fetchStatic(url, rest);
      blocks = extractFromHtml(result.html);
      attempts.push({ mode: 'static', status: result.status, blocks: blocks.length });
    } catch (err) {
      attempts.push({ mode: 'static', error: err.message });
      if (mode === 'static') throw err;
    }
  }

  const needsBrowser = mode === 'browser' || (mode === 'auto' && !blocks.some((b) => b.parsed));
  if (needsBrowser) {
    try {
      const dynamic = await fetchDynamic(url, rest);
      const tagBlocks = blocksFromConsole(dynamic.consoleBlocks);
      const fromTags = tagBlocks.length ? tagBlocks : extractFromHtml(dynamic.html);
      const fallback = [...fromTags, ...blocksFromGlobals(dynamic.globals, fromTags)];
      attempts.push({ mode: 'browser', status: dynamic.status, blocks: fallback.length });
      if (fallback.some((b) => b.parsed) || !result) {
        result = dynamic;
        blocks = fallback;
      }
    } catch (err) {
      attempts.push({ mode: 'browser', error: err.message });
      if (mode === 'browser' || !result) throw err;
    }
  }

  const output = {
    url,
    finalUrl: result?.finalUrl ?? url,
    status: result?.status ?? null,
    mode: result?.mode ?? null,
    cached: false,
    attempts,
    elapsedMs: Date.now() - started,
    bytes: result?.bytes ?? 0,
    blockCount: blocks.length,
    parsedCount: blocks.filter((b) => b.parsed).length,
    blocks
  };

  if (dates) {
    const found = [];
    for (const block of blocks) {
      if (!block.parsed) continue;
      for (const hit of extractDates(block.data)) {
        found.push({ ...hit, source: block.label });
      }
    }
    if (!found.length && result?.html) {
      for (const hit of extractMetaDates(result.html)) found.push({ ...hit, source: 'html-meta' });
    }    output.dates = found;
    // schema.org blocks describe the page itself, so they outrank app-state JSON
    const ranked = [...found].sort(
      (a, b) => Number(b.source.includes('ld+json')) - Number(a.source.includes('ld+json'))
    );
    output.primaryDate = pickPrimaryDate(ranked);
  }

  if (output.parsedCount > 0) cacheSet(cacheKey, output);
  return output;
}

/** Sequential-with-concurrency batch runner; failures never abort the run. */
export async function scrapeMany(urls, options = {}, concurrency = 3) {
  const results = new Array(urls.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < urls.length) {
      const i = cursor++;
      try {
        results[i] = await scrape(urls[i], options);
      } catch (err) {
        results[i] = { url: urls[i], error: err.message, blocks: [], dates: [], primaryDate: null };
      }
      if (options.onProgress) options.onProgress(i + 1, urls.length, results[i]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results;
}
