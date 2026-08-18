import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFromHtml, extractDates, pickPrimaryDate, extractMetaDates, sanitize } from '../src/extract.js';
import { assertHttpUrl, assertPublicTarget } from '../src/urlGuard.js';
import { cacheGet, cacheSet, cacheClear } from '../src/cache.js';

test('extracts every ld+json and application/json block', () => {
  const html = `
    <html><head>
      <script type="application/ld+json">{"@type":"Article","datePublished":"2024-01-02T03:04:05Z"}</script>
      <script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
      <script type="application/json" id="__NEXT_DATA__">{"props":{"publishedAt":"2023-05-06"}}</script>
    </head></html>`;
  const blocks = extractFromHtml(html);
  assert.equal(blocks.length, 3);
  assert.ok(blocks.every((b) => b.parsed));
  assert.equal(blocks[2].id, '__NEXT_DATA__');
});

test('sanitize strips CDATA, comments and trailing semicolons', () => {
  assert.equal(sanitize('<!--{"a":1}-->'), '{"a":1}');
  assert.equal(sanitize('<![CDATA[{"a":1}]]>'), '{"a":1}');
  assert.equal(sanitize('{"a":1};'), '{"a":1}');
});

test('records a parse error instead of throwing', () => {
  const blocks = extractFromHtml('<script type="application/ld+json">{ not json }</script>');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].parsed, false);
  assert.ok(blocks[0].error);
});

test('recovers from literal newlines inside string values (bad control character)', () => {
  const html = `<script type="application/ld+json">{
  "@type": "JobPosting",
  "description": "Line one\nLine two\tend"
}</script>`;
  const blocks = extractFromHtml(html);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].parsed, true);
  assert.equal(blocks[0].data.description, 'Line one\nLine two\tend');
});

test('recovers from raw HTML (unescaped quotes + newlines) embedded in a string value', () => {
  const html = `<script type="application/ld+json">{
  "@type": "JobPosting",
  "title": "Talent Sourcing Specialist",
  "description": "
  Intro text <br><br>Details <h2 id="job_description">Heading</h2> more text
",
  "id": "7089"
}</script>`;
  const blocks = extractFromHtml(html);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].parsed, true);
  assert.equal(blocks[0].data.id, '7089');
  assert.ok(blocks[0].data.description.includes('id="job_description"'));
});

test('finds nested date fields with JSON paths', () => {
  const dates = extractDates({ a: { b: [{ datePublished: '2024-01-02T03:04:05Z' }] } });
  assert.equal(dates.length, 1);
  assert.equal(dates[0].path, '$.a.b[0].datePublished');
  assert.equal(dates[0].iso, '2024-01-02T03:04:05.000Z');
});

test('ignores non-date values on date-ish keys', () => {
  assert.equal(extractDates({ dateFormat: 'DD/MM' }).length, 0);
});

test('primary date prefers datePublished over dateModified', () => {
  const picked = pickPrimaryDate([
    { key: 'dateModified', iso: '2025-01-01T00:00:00.000Z' },
    { key: 'datePublished', iso: '2024-01-01T00:00:00.000Z' }
  ]);
  assert.equal(picked.key, 'datePublished');
});

test('falls back to meta and time tags', () => {
  const html = '<meta property="article:published_time" content="2024-03-04T05:06:07Z"><time datetime="2024-03-05"></time>';
  const found = extractMetaDates(html);
  assert.equal(found.length, 2);
  assert.equal(found[0].iso, '2024-03-04T05:06:07.000Z');
});

test('url guard rejects non-http protocols', () => {
  assert.throws(() => assertHttpUrl('file:///etc/passwd'), /Unsupported protocol/);
  assert.throws(() => assertHttpUrl('javascript:alert(1)'), /Unsupported protocol/);
  assert.throws(() => assertHttpUrl('not a url'), /Invalid URL/);
});

test('url guard blocks private and loopback targets (SSRF)', async () => {
  await assert.rejects(assertPublicTarget(new URL('http://127.0.0.1/admin')), /private address/);
  await assert.rejects(assertPublicTarget(new URL('http://169.254.169.254/latest/meta-data/')), /private address/);
  await assert.rejects(assertPublicTarget(new URL('http://localhost:8080/')), /private host/);
  await assert.rejects(assertPublicTarget(new URL('http://192.168.1.1/')), /private address/);
});

test('url guard honours the explicit override', async () => {
  await assert.doesNotReject(assertPublicTarget(new URL('http://127.0.0.1/'), { allowPrivate: true }));
});

test('cache stores and expires by key', () => {
  cacheClear();
  assert.equal(cacheGet('k'), null);
  cacheSet('k', { ok: true });
  assert.deepEqual(cacheGet('k'), { ok: true });
  cacheClear();
  assert.equal(cacheGet('k'), null);
});
