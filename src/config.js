/** Central tunables. Every value can be overridden with an environment variable. */
const num = (name, fallback) => {
  const raw = process.env[name];
  const parsed = Number(raw);
  return raw !== undefined && Number.isFinite(parsed) ? parsed : fallback;
};
const bool = (name, fallback) => {
  const raw = process.env[name];
  return raw === undefined ? fallback : /^(1|true|yes|on)$/i.test(raw);
};

export const config = {
  userAgent:
    process.env.HJP_USER_AGENT ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',

  static: {
    timeout: num('HJP_STATIC_TIMEOUT', 20000),
    maxBytes: num('HJP_MAX_BYTES', 8 * 1024 * 1024),
    maxRedirects: num('HJP_MAX_REDIRECTS', 5),
    retries: num('HJP_RETRIES', 2)
  },

  browser: {
    timeout: num('HJP_BROWSER_TIMEOUT', 45000),
    selectorTimeout: num('HJP_SELECTOR_TIMEOUT', 5000),
    idleShutdownMs: num('HJP_BROWSER_IDLE_MS', 60000),
    maxConcurrent: num('HJP_BROWSER_CONCURRENCY', 3),
    maxGlobalBytes: num('HJP_MAX_GLOBAL_BYTES', 1024 * 1024),
    maxGlobals: num('HJP_MAX_GLOBALS', 12)
  },

  cache: {
    enabled: bool('HJP_CACHE', true),
    ttlMs: num('HJP_CACHE_TTL', 5 * 60 * 1000),
    maxEntries: num('HJP_CACHE_MAX', 200)
  },

  server: {
    port: num('PORT', 3000),
    maxBodyBytes: num('HJP_MAX_BODY', 64 * 1024),
    rateLimit: {
      windowMs: num('HJP_RATE_WINDOW', 60000),
      max: num('HJP_RATE_MAX', 30)
    },
    // '*' is fine for a laptop; set an explicit origin list when hosting it.
    allowedOrigins: (process.env.HJP_ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim())
  },

  allowPrivate: bool('HJP_ALLOW_PRIVATE', false)
};
