import { config } from './config.js';

/** TTL + insertion-order LRU. Keeps repeat lookups off the network. */
const store = new Map();

export function cacheGet(key) {
  if (!config.cache.enabled) return null;
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    store.delete(key);
    return null;
  }
  store.delete(key);
  store.set(key, entry);
  return entry.value;
}

export function cacheSet(key, value) {
  if (!config.cache.enabled) return;
  store.set(key, { value, expires: Date.now() + config.cache.ttlMs });
  while (store.size > config.cache.maxEntries) {
    store.delete(store.keys().next().value);
  }
}

export function cacheClear() {
  store.clear();
}

export const cacheStats = () => ({ size: store.size, maxEntries: config.cache.maxEntries, ttlMs: config.cache.ttlMs });
