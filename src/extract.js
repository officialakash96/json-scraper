import * as cheerio from 'cheerio';

export const DEFAULT_SELECTORS = [
  'script[type="application/ld+json"]',
  'script[type="application/json"]',
  'script[type="application/ld+json; charset=utf-8"]'
];

/**
 * Browsers tolerate things JSON.parse does not, so clean the raw text first.
 */
export function sanitize(raw) {
  if (!raw) return '';
  let text = raw.trim();
  text = text.replace(/^<!--/, '').replace(/-->$/, '').trim();
  text = text.replace(/^\/\*\s*<!\[CDATA\[\s*\*\//, '').replace(/\/\*\s*\]\]>\s*\*\/$/, '').trim();
  text = text.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
  text = text.replace(/^\uFEFF/, '');
  text = text.replace(/;\s*$/, '');
  return text.trim();
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    // Some sites emit multiple concatenated objects or trailing garbage.
    const firstBrace = text.search(/[[{]/);
    if (firstBrace > 0) {
      try {
        return { ok: true, value: JSON.parse(text.slice(firstBrace)) };
      } catch { /* fall through */ }
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Extract every embedded JSON block from an HTML string.
 * Unlike `document.querySelector`, this returns ALL matching tags.
 */
export function extractFromHtml(html, selectors = DEFAULT_SELECTORS) {
  // Parsing a multi-MB document is the expensive part, so bail out first when
  // the markup cannot possibly contain a match.
  if (!html || !html.includes('application/ld+json') && !html.includes('application/json')) return [];

  const $ = cheerio.load(html);
  const blocks = [];
  const seen = new Set();

  for (const selector of selectors) {
    $(selector).each((index, el) => {
      const node = $(el);
      const text = sanitize(node.text());
      if (!text) return;

      const key = `${selector}::${text.slice(0, 200)}::${text.length}`;
      if (seen.has(key)) return;
      seen.add(key);

      const parsed = tryParse(text);
      blocks.push({
        selector,
        label: `${selector}[${index}]`,
        source: 'script-tag',
        index,
        id: node.attr('id') || null,
        type: node.attr('type') || null,
        bytes: text.length,
        parsed: parsed.ok,
        data: parsed.ok ? parsed.value : null,
        error: parsed.ok ? null : parsed.error,
        raw: parsed.ok ? null : text.slice(0, 500)
      });
    });
  }

  return blocks;
}

const DATE_KEYS = [
  'datepublished',
  'dateposted',
  'datemodified',
  'datecreated',
  'uploaddate',
  'publisheddate',
  'publishedat',
  'publishtime',
  'firstpublishedat',
  'lastmodified',
  'lastupdated',
  'updatedat',
  'createdat',
  'startdate',
  'enddate',
  'expires',
  'date'
];

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;

function looksLikeDate(value) {
  if (typeof value === 'number') {
    // plausible epoch seconds / millis
    return value > 946684800 && value < 4102444800000;
  }
  if (typeof value !== 'string') return false;
  if (ISO_LIKE.test(value)) return true;
  return value.length >= 8 && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function normalize(value) {
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Walk any JSON structure and collect date-looking fields with their JSON paths.
 */
export function extractDates(data, path = '$', out = []) {
  if (data === null || data === undefined) return out;

  if (Array.isArray(data)) {
    data.forEach((item, i) => extractDates(item, `${path}[${i}]`, out));
    return out;
  }

  if (typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      const childPath = `${path}.${key}`;
      const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
      const keyMatches = DATE_KEYS.includes(normalizedKey) ||
        (/date|time|published|modified|updated|created/.test(normalizedKey) && normalizedKey.length <= 30);

      if (keyMatches && (typeof value === 'string' || typeof value === 'number') && looksLikeDate(value)) {
        out.push({ path: childPath, key, value, iso: normalize(value) });
      } else {
        extractDates(value, childPath, out);
      }
    }
  }

  return out;
}

/**
 * Best-effort "the" date for a page: prefers schema.org publish fields.
 */
export function pickPrimaryDate(dates) {
  const priority = ['datepublished', 'dateposted', 'uploaddate', 'publisheddate', 'publishedat', 'datecreated', 'datemodified'];
  for (const wanted of priority) {
    const hit = dates.find((d) => d.key.toLowerCase().replace(/[_-]/g, '') === wanted && d.iso);
    if (hit) return hit;
  }
  return dates.find((d) => d.iso) || null;
}

/** Fallback when no JSON block exists: <meta> and <time> tags. */
export function extractMetaDates(html) {
  const $ = cheerio.load(html);
  const out = [];
  const metaNames = [
    'article:published_time',
    'article:modified_time',
    'og:updated_time',
    'datePublished',
    'dateModified',
    'pubdate',
    'publishdate',
    'date',
    'DC.date.issued',
    'parsely-pub-date'
  ];

  for (const name of metaNames) {
    const content =
      $(`meta[property="${name}" i]`).attr('content') ||
      $(`meta[name="${name}" i]`).attr('content') ||
      $(`meta[itemprop="${name}" i]`).attr('content');
    if (content && looksLikeDate(content)) {
      out.push({ path: `meta[${name}]`, key: name, value: content, iso: normalize(content) });
    }
  }

  $('time[datetime]').each((_, el) => {
    const content = $(el).attr('datetime');
    if (content && looksLikeDate(content)) {
      out.push({ path: 'time[datetime]', key: 'datetime', value: content, iso: normalize(content) });
    }
  });

  return out;
}
