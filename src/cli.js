#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { scrape, scrapeMany } from './scrape.js';
import { closeBrowser } from './fetchDynamic.js';

const HELP = `
json-scraper — pull embedded JSON out of any web page

Usage:
  node src/cli.js <url> [options]
  node src/cli.js --input urls.txt --out results [options]

Options:
  --mode <auto|static|browser>  auto = plain fetch, retry in a real browser if empty (default: auto)
  --dates-only                  print just the extracted date fields
  --json                        print the full raw JSON result
  --pretty                      human-readable summary (default when no format flag)
  --out <dir|file>              write result(s) to disk as JSON
  --input <file>                newline-separated list of URLs
  --concurrency <n>             parallel pages for batch mode (default: 3)
  --timeout <ms>                request/navigation timeout (default: 20000 / 45000)
  --wait <ms>                   extra wait after load in browser mode
  --headful                     show the browser window (browser mode)
  --fresh                       bypass the in-memory cache
  --allow-private               permit localhost / private-network targets
  -h, --help                    this message
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: 'string', default: 'auto' },
    'dates-only': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    pretty: { type: 'boolean', default: false },
    out: { type: 'string' },
    input: { type: 'string' },
    concurrency: { type: 'string', default: '3' },
    timeout: { type: 'string' },
    wait: { type: 'string', default: '0' },
    headful: { type: 'boolean', default: false },
    fresh: { type: 'boolean', default: false },
    'allow-private': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  }
});

if (values.help || (!positionals.length && !values.input)) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}

const options = {
  mode: values.mode,
  allowPrivate: values['allow-private'],
  headless: !values.headful,
  noCache: values.fresh,
  waitMs: Number(values.wait) || 0
};
if (values.timeout) options.timeout = Number(values.timeout);

function summarize(r) {
  const lines = [];
  lines.push(`\n${r.url}`);
  if (r.error) {
    lines.push(`  ERROR: ${r.error}`);
    return lines.join('\n');
  }
  lines.push(`  status=${r.status} mode=${r.mode} blocks=${r.blockCount} parsed=${r.parsedCount} ${r.elapsedMs}ms${r.cached ? ' (cached)' : ''}`);
  for (const b of r.blocks) {
    const label = b.label ?? `${b.selector}[${b.index}]`;
    lines.push(`  - ${label} ${b.bytes}B ${b.parsed ? 'OK' : `PARSE FAIL: ${b.error}`}`);
  }
  if (r.primaryDate) {
    lines.push(`  primary date: ${r.primaryDate.iso}  (${r.primaryDate.key} @ ${r.primaryDate.path})`);
  }
  if (r.dates?.length) {
    lines.push(`  all dates (${r.dates.length}):`);
    for (const d of r.dates.slice(0, 25)) lines.push(`    ${d.key.padEnd(18)} ${d.iso ?? d.value}  ${d.path}`);
  } else {
    lines.push('  no date fields found');
  }
  return lines.join('\n');
}

function slug(url) {
  return url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 120);
}

async function writeOut(target, results, isBatch) {
  if (!target) return;
  if (isBatch) {
    await fs.mkdir(target, { recursive: true });
    await Promise.all(
      results.map((r, i) =>
        fs.writeFile(path.join(target, `${String(i + 1).padStart(4, '0')}_${slug(r.url)}.json`), JSON.stringify(r, null, 2))
      )
    );
    await fs.writeFile(
      path.join(target, 'summary.json'),
      JSON.stringify(results.map((r) => ({ url: r.url, error: r.error ?? null, primaryDate: r.primaryDate?.iso ?? null })), null, 2)
    );
    console.log(`\nWrote ${results.length} files to ${target}/`);
  } else {
    const file = target.endsWith('.json') ? target : path.join(target, `${slug(results[0].url)}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(results[0], null, 2));
    console.log(`\nWrote ${file}`);
  }
}

function print(results) {
  if (values.json) {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    return;
  }
  if (values['dates-only']) {
    for (const r of results) {
      console.log(JSON.stringify({ url: r.url, primaryDate: r.primaryDate?.iso ?? null, dates: r.dates ?? [], error: r.error ?? null }, null, 2));
    }
    return;
  }
  for (const r of results) console.log(summarize(r));
}

try {
  if (values.input) {
    const raw = await fs.readFile(values.input, 'utf8');
    const urls = raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (!urls.length) throw new Error(`No URLs found in ${values.input}`);
    const results = await scrapeMany(urls, {
      ...options,
      onProgress: (done, total) => process.stderr.write(`\r[${done}/${total}]`)
    }, Number(values.concurrency) || 3);
    process.stderr.write('\n');
    print(results);
    await writeOut(values.out, results, true);
  } else {
    const result = await scrape(positionals[0], options);
    print([result]);
    await writeOut(values.out, [result], false);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  await closeBrowser();
  process.exit(1);
}

await closeBrowser();
