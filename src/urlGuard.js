import dns from 'node:dns/promises';
import net from 'node:net';

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./
];

export function assertHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol "${url.protocol}" (only http/https allowed)`);
  }
  return url;
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) return PRIVATE_V4.some((re) => re.test(address));
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    return a === '::1' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80');
  }
  return false;
}

/** Blocks SSRF into localhost / RFC1918 targets unless explicitly allowed. */
export async function assertPublicTarget(url, { allowPrivate = false } = {}) {
  if (allowPrivate) return;
  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error(`Refusing to fetch private host "${host}" (use --allow-private to override)`);
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error(`Refusing to fetch private address "${host}" (use --allow-private to override)`);
    }
    return;
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    return; // let the request itself surface the DNS failure
  }
  if (records.some((r) => isPrivateAddress(r.address))) {
    throw new Error(`Host "${host}" resolves to a private address (use --allow-private to override)`);
  }
}
