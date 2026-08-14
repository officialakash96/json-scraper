const VIEWS = ['home', 'learn', 'about'];
const TITLES = {
  home: 'JSON Scraper',
  learn: 'Learn JSON — JSON Scraper',
  about: 'About — JSON Scraper'
};

const nav = document.querySelector('.site-nav');
const navToggle = document.getElementById('nav-toggle');

function showView(name, { scroll = true } = {}) {
  const view = VIEWS.includes(name) ? name : 'home';
  for (const id of VIEWS) {
    document.getElementById(`view-${id}`).hidden = id !== view;
  }
  document.querySelectorAll('.site-nav a').forEach((link) => {
    link.classList.toggle('is-active', link.dataset.view === view);
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.title = TITLES[view];
  nav.classList.remove('is-open');
  navToggle.setAttribute('aria-expanded', 'false');
  if (scroll) window.scrollTo({ top: 0 });
}

/** In-page anchors such as #learn-python must not be treated as a view. */
function routeFromHash() {
  const hash = location.hash.replace('#', '');
  if (hash.startsWith('learn-')) {
    showView('learn', { scroll: false });
    document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  showView(hash);
}

navToggle.addEventListener('click', () => {
  const open = nav.classList.toggle('is-open');
  navToggle.setAttribute('aria-expanded', String(open));
});

window.addEventListener('hashchange', routeFromHash);
routeFromHash();

/* --------------------- copy buttons on code samples --------------------- */
document.querySelectorAll('.code-copy').forEach((button) =>
  button.addEventListener('click', async () => {
    const code = button.parentElement.querySelector('code')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = 'Copied';
      button.classList.add('copied');
    } catch {
      button.textContent = 'Failed';
    }
    setTimeout(() => {
      button.textContent = 'Copy';
      button.classList.remove('copied');
    }, 1200);
  })
);


/* ----------------------------- share ----------------------------- */
const SHARE_URL = `${location.origin}/`;
const SHARE_TEXT = 'Extract embedded JSON (ld+json, application/json and JS globals) from any web page.';

const encodedUrl = encodeURIComponent(SHARE_URL);
const encodedText = encodeURIComponent(SHARE_TEXT);

const SHARE_TARGETS = {
  linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
  x: `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedText}`,
  whatsapp: `https://api.whatsapp.com/send?text=${encodedText}%20${encodedUrl}`
};

for (const [key, href] of Object.entries(SHARE_TARGETS)) {
  const link = document.querySelector(`.share-item[data-share="${key}"]`);
  if (link) link.href = href;
}

const shareToggle = document.getElementById('share-toggle');
const shareMenu = document.getElementById('share-menu');

function setShareOpen(open) {
  shareMenu.hidden = !open;
  shareToggle.setAttribute('aria-expanded', String(open));
}

shareToggle.addEventListener('click', (event) => {
  event.stopPropagation();
  setShareOpen(shareMenu.hidden);
});

document.addEventListener('click', (event) => {
  if (!shareMenu.hidden && !event.target.closest('#share')) setShareOpen(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !shareMenu.hidden) {
    setShareOpen(false);
    shareToggle.focus();
  }
});

shareMenu.querySelectorAll('a.share-item').forEach((link) =>
  link.addEventListener('click', () => setShareOpen(false))
);

const copyBtn = document.getElementById('share-copy');
const copyLabel = document.getElementById('share-copy-label');
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(SHARE_URL);
    copyLabel.textContent = 'Link copied';
    copyBtn.classList.add('copied');
  } catch {
    copyLabel.textContent = 'Copy failed';
  }
  setTimeout(() => {
    copyLabel.textContent = 'Copy Link';
    copyBtn.classList.remove('copied');
    setShareOpen(false);
  }, 1200);
});
