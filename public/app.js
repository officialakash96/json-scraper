const form = document.getElementById('scrape-form');
const urlInput = document.getElementById('url');
const modeSelect = document.getElementById('mode');
const waitInput = document.getElementById('waitMs');
const submitBtn = document.getElementById('submit');
const statusBox = document.getElementById('status');
const results = document.getElementById('results');
const rawPre = document.getElementById('raw-json');

let lastResult = null;

/** Scraped content is untrusted, so everything rendered goes through this. */
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function highlight(json) {
  return esc(json).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = 'j-num';
      if (/^"/.test(match)) cls = /:$/.test(match) ? 'j-key' : 'j-str';
      else if (/true|false/.test(match)) cls = 'j-bool';
      else if (/null/.test(match)) cls = 'j-null';
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

function setStatus(message, kind = 'info') {
  statusBox.hidden = !message;
  statusBox.className = `status ${kind}`;
  statusBox.textContent = message;
}

function stat(k, v) {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
}

const MAX_LEAVES = 20000;
const MAX_FIELDS = 2000;

/** Flattens a JSON tree into leaf key/value rows with their full paths. */
function flatten(data, prefix = '', out = []) {
  if (out.length >= MAX_LEAVES) return out;

  if (Array.isArray(data)) {
    data.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return out;
  }
  if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
      if (out.length >= MAX_LEAVES) break;
    }
    return out;
  }

  const path = prefix || '(root)';
  out.push({
    path,
    xpath: prefix ? (prefix.startsWith('[') ? `$${prefix}` : `$.${prefix}`) : '$',
    key: path.split('.').pop(),
    value: data === null ? 'null' : String(data),
    type: data === null ? 'null' : typeof data
  });
  return out;
}

/**
 * Collapses array repetitions so each distinct field appears once.
 * `$.posts[0].title` and `$.posts[1].title` become `$.posts[*].title` with a count.
 */
function groupFields(leaves) {
  const groups = new Map();

  for (const leaf of leaves) {
    const pattern = leaf.xpath.replace(/\[\d+\]/g, '[*]');
    const existing = groups.get(pattern);
    if (existing) {
      existing.count++;
      continue;
    }
    if (groups.size >= MAX_FIELDS) break;
    groups.set(pattern, {
      key: leaf.key,
      xpath: pattern,
      samplePath: leaf.xpath,
      value: leaf.value,
      type: leaf.type,
      count: 1
    });
  }

  return [...groups.values()];
}

/* Values are held here so copy buttons reference an index instead of
   embedding untrusted content in data attributes. */
let fieldSets = [];
let blocksCache = [];
let renderedFieldPanes = new Set();

/** Field panes can be expensive to compute for huge blocks, so they're built lazily on first expand. */
function fieldPanePlaceholder(blockIndex) {
  return `<aside class="kv-pane kv-pane-slot" data-block-slot="${blockIndex}"><div class="kv-empty">Loading fields…</div></aside>`;
}

function ensureFieldPane(blockIndex, container) {
  if (renderedFieldPanes.has(blockIndex)) return;
  const block = blocksCache[blockIndex];
  const slot = container.querySelector(`.kv-pane-slot[data-block-slot="${blockIndex}"]`);
  if (!block || !slot) return;
  slot.outerHTML = renderFieldPane(block, blockIndex);
  renderedFieldPanes.add(blockIndex);
}

function renderFieldPane(block, blockIndex) {
  if (!block.parsed) return '<aside class="kv-pane"><div class="kv-empty">Block could not be parsed.</div></aside>';

  const leaves = flatten(block.data);
  const fields = groupFields(leaves);
  fieldSets[blockIndex] = fields;

  const rows = fields
    .map(
      (f, i) => `<li class="kv-row" data-key="${esc(f.key.toLowerCase())}" data-path="${esc(f.xpath.toLowerCase())}">
        <div class="kv-text">
          <div class="kv-k" title="${esc(f.samplePath)}">${esc(f.key)}${
            f.count > 1 ? `<span class="kv-count" title="${f.count} occurrences">\u00d7${f.count}</span>` : ''
          }</div>
          <div class="kv-v kv-${esc(f.type)}">${esc(f.value)}</div>
        </div>
        <div class="kv-actions">
          <button type="button" class="kv-copy" data-kind="key" data-block="${blockIndex}" data-field="${i}" title="Copy key">Key</button>
          <button type="button" class="kv-copy" data-kind="xpath" data-block="${blockIndex}" data-field="${i}" title="Copy XPath">XPath</button>
        </div>
      </li>`
    )
    .join('');

  return `<aside class="kv-pane">
    <div class="kv-head">
      <span class="kv-title">Key values <span class="count" title="${leaves.length} total leaf values">${fields.length}${
        fields.length >= MAX_FIELDS ? '+' : ''
      }</span></span>
      <span class="kv-head-actions">
        <button type="button" class="ghost kv-copy-all" data-kind="key" data-block="${blockIndex}">All keys</button>
        <button type="button" class="ghost kv-copy-all" data-kind="xpath" data-block="${blockIndex}">All XPaths</button>
      </span>
    </div>
    <input type="search" class="kv-filter" placeholder="Filter keys or paths…" aria-label="Filter fields" />
    <ul class="kv-list">${rows}</ul>
  </aside>`;
}

function renderBlocks(data) {
  const panel = document.getElementById('panel-blocks');
  const blocks = data.blocks ?? [];
  document.getElementById('blocks-count').textContent = blocks.length;
  fieldSets = [];
  blocksCache = blocks;
  renderedFieldPanes = new Set();

  if (!blocks.length) {
    panel.innerHTML = '<div class="empty">No embedded JSON script tags were found. Try Browser mode.</div>';
    return;
  }

  panel.innerHTML = blocks
    .map((b, i) => {
      const body = b.parsed ? JSON.stringify(b.data, null, 2) : b.raw ?? '';
      const code = b.error
        ? `<pre class="code">${esc(b.error)}\n\n${esc(body)}</pre>`
        : `<pre class="code">${highlight(body)}</pre>`;
      return `<details class="block" data-index="${i}"${i === 0 ? ' open' : ''}>
        <summary>
          <span>${esc(b.label ?? b.selector)}</span>
          ${b.source === 'js-global' ? '<span class="pill">JS global</span>' : ''}
          ${b.id && b.source !== 'js-global' ? `<span class="pill">#${esc(b.id)}</span>` : ''}
          <span class="pill">${esc(b.bytes)} B</span>
          <span class="pill ${b.parsed ? 'ok' : 'fail'}">${b.parsed ? 'parsed' : 'parse error'}</span>
        </summary>
        <div class="block-body">${code}${fieldPanePlaceholder(i)}</div>
      </details>`;
    })
    .join('');

  // The first block starts expanded, so its pane needs building right away; the rest build on toggle.
  ensureFieldPane(0, panel);
}

async function copyText(text, button, label) {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = label;
    button.classList.add('copied');
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove('copied');
    }, 1200);
  } catch {
    setStatus('Clipboard access was blocked by the browser.', 'error');
  }
}

document.getElementById('panel-blocks').addEventListener('click', (event) => {
  const one = event.target.closest('.kv-copy');
  if (one) {
    const field = fieldSets[Number(one.dataset.block)]?.[Number(one.dataset.field)];
    if (field) copyText(one.dataset.kind === 'xpath' ? field.xpath : field.key, one, 'Copied');
    return;
  }
  const all = event.target.closest('.kv-copy-all');
  if (all) {
    const fields = fieldSets[Number(all.dataset.block)] ?? [];
    const kind = all.dataset.kind;
    copyText(fields.map((f) => (kind === 'xpath' ? f.xpath : f.key)).join('\n'), all, 'Copied');
  }
});

document.getElementById('panel-blocks').addEventListener(
  'toggle',
  (event) => {
    const details = event.target.closest('details.block');
    if (!details || !details.open) return;
    ensureFieldPane(Number(details.dataset.index), document.getElementById('panel-blocks'));
  },
  true // the toggle event doesn't bubble, so this must run in the capture phase
);

const filterTimers = new WeakMap();
function applyFilter(filter) {
  const term = filter.value.trim().toLowerCase();
  filter.parentElement.querySelectorAll('.kv-row').forEach((row) => {
    row.hidden = term !== '' && !row.dataset.key.includes(term) && !row.dataset.path.includes(term);
  });
}
document.getElementById('panel-blocks').addEventListener('input', (event) => {
  const filter = event.target.closest('.kv-filter');
  if (!filter) return;
  clearTimeout(filterTimers.get(filter));
  filterTimers.set(filter, setTimeout(() => applyFilter(filter), 120));
});

function render(data) {
  lastResult = data;
  results.hidden = false;

  document.getElementById('stats').innerHTML = [
    stat('Status', data.status ?? '—'),
    stat('Mode used', data.mode ?? '—'),
    stat('JSON blocks', `${data.parsedCount}/${data.blockCount}`),
    stat('Elapsed', `${data.elapsedMs} ms`)
  ].join('');

  renderBlocks(data);
  rawPre.innerHTML = highlight(JSON.stringify(data, null, 2));
}

async function run(url) {
  const mode = modeSelect.value;
  setStatus(`Fetching ${url} …`, 'info');
  results.hidden = true;
  submitBtn.disabled = true;
  submitBtn.classList.add('is-loading');

  // Browser-mode fallback can take several seconds; let the user know why the wait is longer than usual.
  const stageTimer =
    mode !== 'static'
      ? setTimeout(() => {
          setStatus(`Still working on ${url} — rendering with a headless browser, this can take a bit longer…`, 'info');
        }, 4000)
      : null;

  try {
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, mode, waitMs: Number(waitInput.value) || 0 })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);

    const browserFailure = (data.attempts ?? []).find((a) => a.mode === 'browser' && a.error);
    setStatus(
      browserFailure
        ? `Done via ${data.mode}. Browser fallback unavailable: ${browserFailure.error}`
        : `Done — ${data.parsedCount} JSON block(s) parsed via ${data.mode} mode.`,
      'info'
    );
    render(data);
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    clearTimeout(stageTimer);
    submitBtn.disabled = false;
    submitBtn.classList.remove('is-loading');
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  const field = urlInput.closest('.field');
  if (!/^https?:\/\/.+/i.test(url)) {
    field.classList.add('invalid');
    setStatus('Enter a full URL starting with http:// or https://', 'error');
    return;
  }
  field.classList.remove('invalid');
  run(url);
});

document.querySelectorAll('.chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    urlInput.value = chip.dataset.url;
    form.requestSubmit();
  })
);

document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('is-active'));
    tab.classList.add('is-active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('is-active');
  })
);

document.getElementById('copy-raw').addEventListener('click', async () => {
  if (!lastResult) return;
  await navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2));
  setStatus('Raw JSON copied to clipboard.', 'info');
});

document.getElementById('download-raw').addEventListener('click', () => {
  if (!lastResult) return;
  const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${lastResult.url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 80)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});
