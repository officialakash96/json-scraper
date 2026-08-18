import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { scrape } from './src/scrape.js';
import { closeBrowser } from './src/fetchDynamic.js';
import { cacheStats, cacheClear } from './src/cache.js';
import { config } from './src/config.js';

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

// Only worth the CPU cost for compressible/text-ish payloads above a small size.
const COMPRESSIBLE = /^(text\/|application\/(json|javascript))/;
const MIN_COMPRESS_BYTES = 1024;

function pickEncoding(req) {
  const accept = req.headers['accept-encoding'] || '';
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

/** Compresses `body` when the client supports it and it's worth the CPU; writes headers + ends the response. */
async function sendCompressed(req, res, status, headers, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const contentType = headers['Content-Type'] || '';
  const encoding = COMPRESSIBLE.test(contentType) && buf.length >= MIN_COMPRESS_BYTES ? pickEncoding(req) : null;

  res.setHeader('Vary', 'Accept-Encoding');
  if (!encoding) {
    res.writeHead(status, { ...headers, 'Content-Length': buf.length });
    res.end(buf);
    return;
  }

  try {
    const compressed = encoding === 'br' ? await brotli(buf) : await gzip(buf);
    res.writeHead(status, { ...headers, 'Content-Encoding': encoding, 'Content-Length': compressed.length });
    res.end(compressed);
  } catch {
    // Compression failure shouldn't fail the request — fall back to the uncompressed body.
    res.writeHead(status, { ...headers, 'Content-Length': buf.length });
    res.end(buf);
  }
}

/* --------------------------- CORS --------------------------- */
// The browser never talks to the target site, so target-site CORS can't apply.
// These headers only open up *our* API so the page (or another local tool) can call it.
function applyCors(req, res) {
  const allowed = config.server.allowedOrigins;
  const origin = req.headers.origin;
  if (allowed.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'"
  );
}

/* ------------------------ rate limiting ------------------------ */
const hits = new Map();
function rateLimited(ip) {
  const { windowMs, max } = config.server.rateLimit;
  const now = Date.now();
  const bucket = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  bucket.push(now);
  hits.set(ip, bucket);
  if (hits.size > 5000) hits.clear();
  return bucket.length > max;
}

/* --------------------------- helpers --------------------------- */
async function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload);
  applyCors(req, res);
  securityHeaders(res);
  await sendCompressed(req, res, status, { 'Content-Type': 'application/json; charset=utf-8' }, body);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.destroy();
      throw new Error('Request body too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(req, res) {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const stat = await fs.stat(filePath);
    // Cheap freshness check: size+mtime is enough to detect a changed deploy.
    const etag = `"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;
    const isHtml = path.extname(filePath) === '.html';
    const cacheControl = isHtml ? 'no-cache' : 'public, max-age=600, must-revalidate';

    securityHeaders(res);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', cacheControl);

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304).end();
      return;
    }

    const data = await fs.readFile(filePath);
    await sendCompressed(
      req,
      res,
      200,
      { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', ETag: etag, 'Cache-Control': cacheControl },
      data
    );
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

/* ---------------------------- routes ---------------------------- */
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const ip = req.socket.remoteAddress ?? 'unknown';

  if (req.method === 'OPTIONS') {
    applyCors(req, res);
    res.writeHead(204).end();
    return;
  }

  if (pathname === '/api/health') {
    return sendJson(req, res, 200, { ok: true, uptimeSec: Math.round(process.uptime()), cache: cacheStats() });
  }

  if (pathname === '/api/cache' && req.method === 'DELETE') {
    cacheClear();
    return sendJson(req, res, 200, { cleared: true });
  }

  if (pathname === '/api/scrape') {
    if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'Use POST' });
    if (rateLimited(ip)) {
      res.setHeader('Retry-After', Math.ceil(config.server.rateLimit.windowMs / 1000));
      return sendJson(req, res, 429, { error: 'Rate limit exceeded — slow down and retry shortly.' });
    }

    const started = Date.now();
    try {
      const body = JSON.parse((await readBody(req, config.server.maxBodyBytes)) || '{}');
      const url = String(body.url || '').trim();
      if (!url) return sendJson(req, res, 400, { error: 'A URL is required' });
      if (url.length > 2048) return sendJson(req, res, 400, { error: 'URL is too long' });

      const result = await scrape(url, {
        mode: ['auto', 'static', 'browser'].includes(body.mode) ? body.mode : 'auto',
        waitMs: Math.min(Math.max(Number(body.waitMs) || 0, 0), 15000),
        noCache: Boolean(body.noCache)
      });
      console.log(`${new Date().toISOString()} ${result.mode ?? '-'} ${result.status ?? '-'} ${Date.now() - started}ms ${url}`);
      return sendJson(req, res, 200, result);
    } catch (err) {
      console.warn(`${new Date().toISOString()} FAIL ${Date.now() - started}ms ${err.message}`);
      return sendJson(req, res, 400, { error: err.message });
    }
  }

  if (req.method !== 'GET') return sendJson(req, res, 405, { error: 'Method not allowed' });
  await serveStatic(req, res);
});

server.headersTimeout = 65000;
server.requestTimeout = 120000;

server.listen(config.server.port, () => {
  console.log(`JSON Scraper UI  →  http://localhost:${config.server.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('\nShutting down…');
    server.close();
    await closeBrowser();
    process.exit(0);
  });
}
