'use strict';

/* ------------------------------------------------------------------ *
 * Constants & helpers
 * ------------------------------------------------------------------ */

const THEME_KEY = 'ficfolio:theme';
const SETTINGS_KEY = 'ficfolio:settings';
const POSITIONS_KEY = 'ficfolio:positions';

const DEFAULT_SETTINGS = { size: 19, leading: 1.75, family: 'serif' };
const THEME_ORDER = ['light', 'sepia', 'dark'];
const THEME_LABELS = { light: 'Light', sepia: 'Sepia', dark: 'Dark' };

const ICONS = {
  trash: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3.5 5.5h13M8 5.5V3.8h4v1.7M5.2 5.5l.7 10.2a1 1 0 0 0 1 .9h6.2a1 1 0 0 0 1-.9l.7-10.2M8.2 8.7v5M11.8 8.7v5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  upload: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 13V3.6M6.4 7 10 3.4 13.6 7M3.8 12.6v2.6a1.2 1.2 0 0 0 1.2 1.2h10a1.2 1.2 0 0 0 1.2-1.2v-2.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const $ = (selector, root = document) => root.querySelector(selector);

const els = {
  grid: $('#grid'),
  libraryMeta: $('#library-meta'),
  libraryTools: $('#library-tools'),
  search: $('#search'),
  clearSearch: $('#clear-search'),
  addBtn: $('#add-btn'),
  fileInput: $('#file-input'),
  themeBtn: $('#theme-btn'),
  sort: $('#sort'),
  tagBar: $('#tag-bar'),
  dropOverlay: $('#drop-overlay'),
  toasts: $('#toasts'),
  confirmDialog: $('#confirm-dialog'),
  confirmTitle: $('#confirm-title'),
  confirmMessage: $('#confirm-message'),
  confirmOk: $('#confirm-ok'),
  reader: $('#reader'),
  readerBack: $('#reader-back'),
  readerBookTitle: $('#reader-book-title'),
  readerBookAuthor: $('#reader-book-author'),
  readerScroll: $('#reader-scroll'),
  readerContent: $('#reader-content'),
  readerProgressFill: $('#reader-progress-fill'),
  readerSettings: $('#reader-settings'),
  settingsBtn: $('#settings-btn'),
  fontValue: $('#font-size-value'),
  chapterList: $('#chapter-list'),
  chapterListItems: $('#chapter-list-items'),
  chapterCount: $('#chapter-count'),
  chapterToggle: $('#chapter-toggle'),
  chapterScrim: $('#reader-scrim'),
  prevChapter: $('#prev-chapter'),
  nextChapter: $('#next-chapter'),
  prevChapterTitle: $('#prev-chapter-title'),
  nextChapterTitle: $('#next-chapter-title'),
};

const state = {
  books: [],
  booksLoaded: false,
  query: '',
  activeTag: null,
  sort: 'recent',
  readerOpen: false,
  book: null,
  chapterIndex: 0,
  chapterRequest: 0,
  chapterCache: new Map(),
  settings: { ...DEFAULT_SETTINGS },
  scrollSaveTimer: 0,
  firstRender: true,
};

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '"') return '&quot;';
    return '&#39;';
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatWords(count) {
  const n = Number(count) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

function hashHue(text) {
  let hash = 0;
  const value = String(text || 'ficfolio');
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) % 360;
  }
  return hash;
}

function assetUrl(id, relative) {
  return `/api/books/${encodeURIComponent(id)}/assets/${String(relative)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

function currentTheme() {
  const theme = document.documentElement.dataset.theme;
  return THEME_ORDER.includes(theme) ? theme : 'dark';
}

function isTypingTarget(target) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable)
  );
}

/* ------------------------------------------------------------------ *
 * Local persistence
 * ------------------------------------------------------------------ */

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be unavailable */
  }
}

function loadPositions() {
  const positions = readJson(POSITIONS_KEY, {});
  return positions && typeof positions === 'object' ? positions : {};
}

function savePosition(id, chapter, ratio) {
  const positions = loadPositions();
  positions[id] = { chapter, ratio: clamp(Number(ratio) || 0, 0, 1), updatedAt: Date.now() };
  writeJson(POSITIONS_KEY, positions);
}

function loadSettings() {
  const saved = readJson(SETTINGS_KEY, {});
  return {
    size: clamp(Number(saved.size) || DEFAULT_SETTINGS.size, 15, 28),
    leading: clamp(Number(saved.leading) || DEFAULT_SETTINGS.leading, 1.4, 2.1),
    family: saved.family === 'sans' ? 'sans' : 'serif',
  };
}

function persistSettings() {
  writeJson(SETTINGS_KEY, state.settings);
}

function getProgressFor(book) {
  const position = loadPositions()[book.id];
  if (!position || !book.chapterCount) return 0;
  const chapter = clamp(Number(position.chapter) || 0, 0, book.chapterCount - 1);
  const ratio = clamp(Number(position.ratio) || 0, 0, 1);
  return clamp(((chapter + ratio) / book.chapterCount) * 100, 0, 100);
}

/* ------------------------------------------------------------------ *
 * Theme & typography
 * ------------------------------------------------------------------ */

function setTheme(theme, { announce = false } = {}) {
  const next = THEME_ORDER.includes(theme) ? theme : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore */
  }
  syncThemeUI();
  if (announce) toast(`${THEME_LABELS[next]} theme`);
}

function syncThemeUI() {
  const theme = currentTheme();
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  els.themeBtn.title = `Theme: ${THEME_LABELS[theme]} — click for ${THEME_LABELS[next]}`;
  els.themeBtn.setAttribute('aria-label', `Change theme (currently ${THEME_LABELS[theme]})`);

  document.querySelectorAll('#reader-settings .segmented[data-setting="theme"] button').forEach((button) => {
    button.classList.toggle('active', button.dataset.value === theme);
  });
}

function applyReaderSettings() {
  const { size, leading, family } = state.settings;
  els.reader.style.setProperty('--reader-size', `${size}px`);
  els.reader.style.setProperty('--reader-leading', String(leading));
  els.reader.style.setProperty('--reader-font', family === 'sans' ? 'var(--ui-font)' : 'var(--serif)');
  els.fontValue.textContent = String(size);

  document.querySelectorAll('#reader-settings .segmented').forEach((group) => {
    const key = group.dataset.setting;
    group.querySelectorAll('button').forEach((button) => {
      let active = false;
      if (key === 'family') active = button.dataset.value === family;
      else if (key === 'leading') active = Math.abs(Number(button.dataset.value) - leading) < 0.01;
      button.classList.toggle('active', active);
    });
  });

  syncThemeUI();
}

/* ------------------------------------------------------------------ *
 * Toasts & dialogs
 * ------------------------------------------------------------------ */

function toast(message, type = 'info', duration = 4200) {
  const node = document.createElement('div');
  node.className = `toast${type === 'error' ? ' error' : ''}`;
  const icon = type === 'error' ? '!' : type === 'success' ? '✓' : 'i';
  node.innerHTML = `<span class="toast-icon" aria-hidden="true">${icon}</span><span>${escapeHtml(message)}</span>`;
  els.toasts.appendChild(node);
  window.setTimeout(() => {
    node.classList.add('leaving');
    window.setTimeout(() => node.remove(), 240);
  }, duration);
}

function askConfirm({ title, message, okLabel = 'Remove' }) {
  return new Promise((resolve) => {
    if (els.confirmDialog.open) {
      resolve(false);
      return;
    }
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmOk.textContent = okLabel;
    els.confirmDialog.returnValue = 'cancel';
    const onClose = () => {
      els.confirmDialog.removeEventListener('close', onClose);
      resolve(els.confirmDialog.returnValue === 'confirm');
    };
    els.confirmDialog.addEventListener('close', onClose);
    els.confirmDialog.showModal();
  });
}

/* ------------------------------------------------------------------ *
 * Library rendering
 * ------------------------------------------------------------------ */

function bookMatches(book) {
  if (state.activeTag) {
    const tag = state.activeTag.toLowerCase();
    if (!(book.tags || []).some((item) => item.toLowerCase() === tag)) return false;
  }
  const query = state.query.trim().toLowerCase();
  if (!query) return true;
  const haystack = [book.title, book.author, book.summary, ...(book.tags || [])].join(' ').toLowerCase();
  return query.split(/\s+/).every((term) => haystack.includes(term));
}

function getVisibleBooks() {
  const books = state.books.filter(bookMatches);
  const sorters = {
    recent: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
    author: (a, b) => a.author.localeCompare(b.author, undefined, { sensitivity: 'base' }) || a.title.localeCompare(b.title),
    chapters: (a, b) => (b.chapterCount || 0) - (a.chapterCount || 0) || a.title.localeCompare(b.title),
  };
  return books.sort(sorters[state.sort] || sorters.recent);
}

function renderLibrary({ animate = false } = {}) {
  els.grid.classList.toggle('intro', animate);

  if (!state.booksLoaded) {
    els.grid.classList.add('is-empty');
    els.grid.innerHTML =
      '<div class="library-loading"><span class="spinner"></span><span>Opening your library…</span></div>';
    els.libraryMeta.textContent = 'Gathering your stories…';
    els.tagBar.hidden = true;
    return;
  }

  const books = getVisibleBooks();
  const totalWords = state.books.reduce((sum, book) => sum + (book.wordCount || 0), 0);
  const count = state.books.length;

  els.libraryMeta.textContent = count
    ? `${count} ${count === 1 ? 'fic' : 'fics'} · ${formatWords(totalWords)} words · saved on this device`
    : 'No fics yet — add your first EPUB.';
  els.libraryTools.hidden = count === 0;

  renderTagBar();

  if (!count) {
    els.grid.classList.add('is-empty');
    els.grid.innerHTML = emptyStateMarkup();
    return;
  }

  if (!books.length) {
    els.grid.classList.add('is-empty');
    const detail = state.activeTag ? ` tagged “${state.activeTag}”` : '';
    els.grid.innerHTML = `
      <div class="no-results">
        <h2>No fics found</h2>
        <p>Nothing in your library matches “${escapeHtml(state.query.trim() || 'these filters')}”${escapeHtml(detail)}.</p>
        <button class="ghost-btn" type="button" data-action="clear-filters">Clear filters</button>
      </div>`;
    return;
  }

  els.grid.classList.remove('is-empty');
  const cards = [addCardMarkup(), ...books.map(bookCardMarkup)].join('');
  els.grid.innerHTML = cards;
  els.grid.classList.remove('intro');
  if (animate) {
    void els.grid.offsetWidth;
    els.grid.classList.add('intro');
  }
}

function bookCardMarkup(book) {
  const hue = hashHue(book.title);
  const tags = book.tags || [];
  const shownTags = tags.slice(0, 3);
  const extraTags = Math.max(0, tags.length - shownTags.length);
  const progress = getProgressFor(book);

  const cover = book.cover
    ? `<img src="${assetUrl(book.id, book.cover)}" alt="" loading="lazy" decoding="async" />`
    : `<div class="cover-fallback" style="--h:${hue}">
         <span class="cover-kicker">AO3 · EPUB</span>
         <span class="cover-title">${escapeHtml(book.title)}</span>
         <span class="cover-author">${escapeHtml(book.author)}</span>
       </div>`;

  return `
    <article class="card" data-id="${escapeHtml(book.id)}">
      <div class="card-cover">
        ${cover}
        ${progress > 0.5 ? `<div class="card-progress"><span style="width:${progress.toFixed(1)}%"></span></div>` : ''}
      </div>
      <button class="card-delete" type="button" title="Remove from library" aria-label="Remove ${escapeHtml(book.title)} from library">${ICONS.trash}</button>
      <div class="card-info">
        <h3 class="card-title"><a class="card-link" href="#/read/${encodeURIComponent(book.id)}">${escapeHtml(book.title)}</a></h3>
        <p class="card-author">${escapeHtml(book.author)}</p>
        <div class="card-tags">
          ${shownTags
            .map(
              (tag) =>
                `<button class="tag-pill" type="button" data-tag="${escapeHtml(tag)}" title="Filter by ${escapeHtml(tag)}">${escapeHtml(tag)}</button>`,
            )
            .join('')}
          ${extraTags ? `<span class="tag-pill more" title="${escapeHtml(tags.slice(3).join(', '))}">+${extraTags}</span>` : ''}
        </div>
      </div>
    </article>`;
}

function addCardMarkup() {
  return `
    <button class="add-card" type="button" data-action="upload">
      <span class="add-card-plus">${ICONS.plus}</span>
      <strong>Add EPUBs</strong>
      <small>or drop files anywhere</small>
    </button>`;
}

function emptyStateMarkup() {
  return `
    <div class="empty-state">
      <div class="empty-books" aria-hidden="true"><span></span><span></span><span></span></div>
      <h2>Bring your fics home.</h2>
      <p>Drop in your AO3 EPUB downloads. Ficfolio reads the title, author and tags straight from each file, then turns it into a card you can open and read.</p>
      <div class="empty-actions">
        <button class="primary-btn" type="button" data-action="upload">${ICONS.upload}<span>Add EPUBs</span></button>
        <span class="empty-hint">or drop files anywhere on this page</span>
      </div>
      <p class="empty-hint">Everything stays on this computer — no accounts, no uploads to the internet.</p>
    </div>`;
}

function renderTagBar() {
  const counts = new Map();
  for (const book of state.books) {
    for (const tag of book.tags || []) {
      const key = tag.toLowerCase();
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { label: tag, count: 1 });
    }
  }

  if (!counts.size) {
    els.tagBar.hidden = true;
    els.tagBar.innerHTML = '';
    return;
  }

  const top = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 10);
  if (state.activeTag && !top.some((entry) => entry.label.toLowerCase() === state.activeTag.toLowerCase())) {
    const active = counts.get(state.activeTag.toLowerCase());
    if (active) top.unshift(active);
  }

  els.tagBar.hidden = false;
  els.tagBar.innerHTML = top
    .map(
      (entry) => `
        <button class="tag-chip${state.activeTag && state.activeTag.toLowerCase() === entry.label.toLowerCase() ? ' active' : ''}"
          type="button" data-filter-tag="${escapeHtml(entry.label)}">
          <span class="tag-chip-label">${escapeHtml(entry.label)}</span>
          <span class="count">${entry.count}</span>
        </button>`,
    )
    .join('');
}

function setTagFilter(tag) {
  if (!tag) return;
  if (state.activeTag && state.activeTag.toLowerCase() === tag.toLowerCase()) {
    state.activeTag = null;
  } else {
    state.activeTag = tag;
  }
  renderLibrary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearFilters() {
  state.query = '';
  state.activeTag = null;
  els.search.value = '';
  els.clearSearch.hidden = true;
  renderLibrary();
}

/* ------------------------------------------------------------------ *
 * Library data & uploads
 * ------------------------------------------------------------------ */

async function requestJson(url, options) {
  const response = await fetch(url, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error || 'Something went wrong.');
  }
  return payload;
}

async function refreshLibrary({ animate = false } = {}) {
  const data = await requestJson('/api/books');
  state.books = Array.isArray(data.books) ? data.books : [];
  state.booksLoaded = true;
  renderLibrary({ animate });
}

function showLibraryError(error) {
  state.booksLoaded = false;
  els.grid.classList.add('is-empty');
  els.libraryMeta.textContent = 'Your library could not be loaded.';
  els.grid.innerHTML = `
    <div class="no-results">
      <h2>Couldn’t open your library</h2>
      <p>${escapeHtml(error?.message || 'The local server did not respond.')}</p>
      <button class="ghost-btn" type="button" data-action="retry">Try again</button>
    </div>`;
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []).filter(
    (file) => /\.epub$/i.test(file.name) || file.type === 'application/epub+zip',
  );

  if (!files.length) {
    toast('Please choose EPUB files — the ones AO3 gives you when you download a work.', 'error');
    return;
  }

  const original = els.addBtn.innerHTML;
  els.addBtn.disabled = true;
  els.addBtn.innerHTML = '<span class="spinner" style="width:15px;height:15px;border-width:2px" aria-hidden="true"></span><span>Importing…</span>';

  let added = 0;
  let duplicates = 0;
  let failed = 0;

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    if (files.length > 1) {
      toast(`Importing ${index + 1} of ${files.length} — ${file.name}`, 'info', 1800);
    }
    try {
      const data = await requestJson('/api/books', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/epub+zip',
          'X-Filename': encodeURIComponent(file.name),
        },
        body: file,
      });
      if (data?.duplicate) {
        duplicates += 1;
      } else if (data?.book) {
        added += 1;
        state.books = [data.book, ...state.books.filter((book) => book.id !== data.book.id)];
      }
    } catch (error) {
      failed += 1;
      toast(`${file.name} — ${error.message}`, 'error', 6500);
    }
  }

  els.addBtn.disabled = false;
  els.addBtn.innerHTML = original;

  try {
    await refreshLibrary({ animate: added > 0 });
  } catch (error) {
    renderLibrary();
  }

  if (added) toast(`Added ${added} ${added === 1 ? 'fic' : 'fics'} to your library.`, 'success');
  if (duplicates) {
    toast(`${duplicates} ${duplicates === 1 ? 'file was' : 'files were'} already in your library.`);
  }
  if (failed && !added && !duplicates) {
    toast('Nothing was imported. Check that the files are EPUB downloads from AO3.', 'error', 6000);
  }
}

async function deleteBook(id) {
  const book = state.books.find((item) => item.id === id);
  if (!book) return;

  const confirmed = await askConfirm({
    title: 'Remove this fic?',
    message: `“${book.title}” and its extracted files will be deleted from this library. Your original download is untouched.`,
    okLabel: 'Remove',
  });
  if (!confirmed) return;

  try {
    await requestJson(`/api/books/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.books = state.books.filter((item) => item.id !== id);
    const positions = loadPositions();
    delete positions[id];
    writeJson(POSITIONS_KEY, positions);
    if (state.book?.id === id) closeReader({ fromRoute: true });
    renderLibrary();
    toast('Removed from your library.');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ------------------------------------------------------------------ *
 * Reader
 * ------------------------------------------------------------------ */

function saveCurrentPosition() {
  if (!state.book) return;
  savePosition(state.book.id, state.chapterIndex, getScrollRatio());
}

function getScrollRatio() {
  const max = els.readerScroll.scrollHeight - els.readerScroll.clientHeight;
  if (max <= 0) return 0;
  return clamp(els.readerScroll.scrollTop / max, 0, 1);
}

function updateReaderProgress() {
  if (!state.book) {
    els.readerProgressFill.style.width = '0%';
    return;
  }
  const total = state.book.chapterCount || 1;
  const percent = ((state.chapterIndex + getScrollRatio()) / total) * 100;
  els.readerProgressFill.style.width = `${clamp(percent, 0, 100).toFixed(2)}%`;
}

async function openBook(id) {
  let book = state.books.find((item) => item.id === id);
  if (!book) {
    try {
      const data = await requestJson(`/api/books/${encodeURIComponent(id)}`);
      book = data.book;
    } catch {
      toast('That fic could not be found in your library.', 'error');
      clearReadHash();
      return;
    }
  }

  if (state.readerOpen && state.book?.id === book.id) return;

  state.book = book;
  state.chapterIndex = 0;
  state.chapterRequest += 1;
  state.chapterCache.clear();
  state.readerOpen = true;
  state.firstRender = true;

  document.body.classList.add('reader-open');
  els.reader.hidden = false;
  els.reader.setAttribute('aria-hidden', 'false');
  els.reader.classList.remove('show-chapters');
  closeReaderSettings();

  els.readerBookTitle.textContent = book.title;
  els.readerBookAuthor.textContent = book.author;
  els.readerBookTitle.title = book.title;
  els.readerBookAuthor.title = book.author;
  document.title = `${book.title} — Ficfolio`;

  renderChapterList();

  els.reader.hidden = false;
  void els.reader.offsetWidth;
  els.reader.classList.add('open');

  const positions = loadPositions();
  const saved = positions[book.id];
  const startIndex = clamp(Number(saved?.chapter) || 0, 0, Math.max(0, book.chapterCount - 1));
  const ratio = saved && startIndex === (Number(saved.chapter) || 0) ? Number(saved.ratio) || 0 : 0;

  await loadChapter(startIndex, { ratio });
  if (!state.readerOpen || state.book?.id !== book.id) return;
  els.reader.focus({ preventScroll: true });
}

function closeReader({ fromRoute = false } = {}) {
  if (!state.readerOpen) return;
  saveCurrentPosition();

  const bookId = state.book?.id;
  state.readerOpen = false;
  state.book = null;
  state.chapterRequest += 1;
  state.chapterCache.clear();
  els.reader.classList.remove('open', 'show-chapters');
  closeReaderSettings();
  els.reader.setAttribute('aria-hidden', 'true');
  els.reader.hidden = true;
  document.body.classList.remove('reader-open');
  document.title = 'Ficfolio — your AO3 library';

  if (!fromRoute) clearReadHash();

  renderLibrary();
  if (bookId) {
    setTimeout(() => {
      const link = els.grid.querySelector(`.card[data-id="${cssEscape(bookId)}"] .card-link`);
      if (link) link.focus({ preventScroll: true });
    }, 0);
  }
}

function clearReadHash() {
  if (location.hash.startsWith('#/read/')) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

function renderChapterList() {
  const book = state.book;
  if (!book) return;
  els.chapterCount.textContent = `${book.chapterCount}`;
  els.chapterListItems.innerHTML = book.chapters
    .map(
      (chapter, index) => `
        <button class="chapter-item" type="button" data-index="${index}" title="${escapeHtml(chapter.title)}">
          <span class="chapter-number">${index + 1}</span>
          <span class="chapter-item-title">${escapeHtml(chapter.title)}</span>
        </button>`,
    )
    .join('');
}

function setActiveChapter(index) {
  const items = els.chapterListItems.querySelectorAll('.chapter-item');
  items.forEach((item, itemIndex) => {
    const active = itemIndex === index;
    item.classList.toggle('active', active);
    if (active) {
      item.setAttribute('aria-current', 'true');
      if (state.firstRender) item.scrollIntoView({ block: 'nearest' });
    } else {
      item.removeAttribute('aria-current');
    }
  });
  state.firstRender = false;
}

function updateChapterUI(index, chapterTitle) {
  const book = state.book;
  if (!book) return;

  setActiveChapter(index);
  els.readerProgressFill.style.width = `${(((index + getScrollRatio()) / (book.chapterCount || 1)) * 100).toFixed(2)}%`;

  const prev = book.chapters[index - 1];
  const next = book.chapters[index + 1];

  els.prevChapter.disabled = !prev;
  els.nextChapter.disabled = !next;
  els.prevChapterTitle.textContent = prev ? prev.title : '';
  els.nextChapterTitle.textContent = next ? next.title : '';
  els.prevChapter.title = prev ? `Previous: ${prev.title}` : 'No previous chapter';
  els.nextChapter.title = next ? `Next: ${next.title}` : 'No next chapter';

  if (chapterTitle) els.readerBookTitle.title = `${book.title} — ${chapterTitle}`;
}

async function loadChapter(index, options = {}) {
  const book = state.book;
  if (!book) return;

  const total = book.chapterCount || 0;
  index = clamp(Number(index) || 0, 0, Math.max(0, total - 1));
  state.chapterIndex = index;

  const requestId = ++state.chapterRequest;
  updateChapterUI(index);

  let data = state.chapterCache.get(index);
  if (!data) {
    els.readerContent.innerHTML =
      '<div class="chapter-loading"><span class="spinner" aria-hidden="true"></span><span>Opening chapter…</span></div>';
    els.readerScroll.scrollTop = 0;

    try {
      data = await requestJson(`/api/books/${encodeURIComponent(book.id)}/chapters/${index}`);
      state.chapterCache.set(index, data);
    } catch (error) {
      if (requestId !== state.chapterRequest) return;
      els.readerContent.innerHTML = `
        <div class="no-results" style="border:0;background:none;margin:0 auto">
          <h2>This chapter didn’t open</h2>
          <p>${escapeHtml(error.message)}</p>
          <button class="ghost-btn" type="button" data-action="retry-chapter">Try again</button>
        </div>`;
      return;
    }
  }

  if (requestId !== state.chapterRequest || !state.readerOpen || state.book?.id !== book.id) return;

  renderChapter(data, options);
  updateChapterUI(index, data.title);
  savePosition(book.id, index, Number.isFinite(options.ratio) ? options.ratio : 0);
  preloadChapter(index + 1);
  preloadChapter(index - 1);
}

function renderChapter(data, options) {
  els.readerContent.innerHTML = sanitizeHtml(data.html || '<p>This chapter is empty.</p>');
  makeLinksSafe(els.readerContent);

  const ratio = Number.isFinite(options.ratio) ? clamp(options.ratio, 0, 1) : 0;
  const fragment = options.frag;

  if (ratio > 0.001) {
    setTimeout(() => {
      const max = els.readerScroll.scrollHeight - els.readerScroll.clientHeight;
      els.readerScroll.scrollTop = max > 0 ? max * ratio : 0;
      updateReaderProgress();
    }, 0);
  } else if (fragment) {
    setTimeout(() => {
      const target = findFragmentTarget(fragment);
      if (target) target.scrollIntoView({ block: 'start' });
      else els.readerScroll.scrollTop = 0;
      updateReaderProgress();
    }, 0);
  } else {
    els.readerScroll.scrollTop = 0;
    updateReaderProgress();
  }
}

function findFragmentTarget(fragment) {
  const cleaned = String(fragment).replace(/^#/, '');
  if (!cleaned) return null;
  try {
    return els.readerContent.querySelector(`#${CSS.escape(cleaned)}`) || els.readerContent.querySelector(`[name="${cleaned.replace(/"/g, '\\"')}"]`);
  } catch {
    return null;
  }
}

function preloadChapter(index) {
  const book = state.book;
  if (!book || index < 0 || index >= book.chapterCount || state.chapterCache.has(index)) return;
  requestJson(`/api/books/${encodeURIComponent(book.id)}/chapters/${index}`)
    .then((data) => {
      if (state.book?.id === book.id && data) state.chapterCache.set(index, data);
    })
    .catch(() => {});
}

function goToChapter(index, options = {}) {
  if (!state.readerOpen) return;
  els.reader.classList.remove('show-chapters');
  loadChapter(index, options);
}

function nextChapter() {
  if (!state.book || state.chapterIndex + 1 >= state.book.chapterCount) return;
  goToChapter(state.chapterIndex + 1);
}

function prevChapter() {
  if (!state.book || state.chapterIndex <= 0) return;
  goToChapter(state.chapterIndex - 1);
}

/* ------------------------------------------------------------------ *
 * Chapter HTML safety
 * ------------------------------------------------------------------ */

const BLOCKED_TAGS = new Set([
  'script', 'style', 'link', 'meta', 'base', 'iframe', 'object', 'embed', 'form',
  'input', 'button', 'textarea', 'select', 'option', 'video', 'audio', 'canvas',
  'noscript', 'svg', 'math', 'template',
]);

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><html><body><div id="__ficfolio_root">${html}</div></body></html>`,
    'text/html',
  );
  const root = doc.getElementById('__ficfolio_root');
  if (!root) return '';

  root.querySelectorAll('*').forEach((node) => {
    if (BLOCKED_TAGS.has(node.tagName.toLowerCase())) {
      node.remove();
      return;
    }
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith('on') ||
        name === 'style' ||
        name === 'srcset' ||
        name === 'sizes' ||
        name === 'background' ||
        name === 'formaction'
      ) {
        node.removeAttribute(attribute.name);
        continue;
      }
      if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^(?:javascript|vbscript|data:text\/html)/i.test(value.replace(/\s+/g, ''))
      ) {
        node.removeAttribute(attribute.name);
      }
    }
  });

  return root.innerHTML;
}

function makeLinksSafe(root) {
  root.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href') || '';
    if (/^https?:/i.test(href)) {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    } else if (href.startsWith('#')) {
      anchor.removeAttribute('target');
    }
  });
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ *
 * Reader settings & chapter drawer
 * ------------------------------------------------------------------ */

function openReaderSettings() {
  els.readerSettings.hidden = false;
  els.settingsBtn.setAttribute('aria-expanded', 'true');
}

function closeReaderSettings() {
  els.readerSettings.hidden = true;
  els.settingsBtn.setAttribute('aria-expanded', 'false');
}

function toggleReaderSettings() {
  if (els.readerSettings.hidden) openReaderSettings();
  else closeReaderSettings();
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

function bindEvents() {
  /* Theme */
  els.themeBtn.addEventListener('click', () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme()) + 1) % THEME_ORDER.length];
    setTheme(next, { announce: true });
  });

  /* Search */
  let searchTimer = 0;
  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    els.clearSearch.hidden = !state.query;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => renderLibrary(), 90);
  });
  els.clearSearch.addEventListener('click', () => {
    els.search.value = '';
    state.query = '';
    els.clearSearch.hidden = true;
    renderLibrary();
    els.search.focus();
  });

  /* Sort */
  els.sort.value = state.sort;
  els.sort.addEventListener('change', () => {
    state.sort = els.sort.value;
    renderLibrary();
  });

  /* Tag bar */
  els.tagBar.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-filter-tag]');
    if (!chip) return;
    setTagFilter(chip.dataset.filterTag);
  });

  /* Global actions (upload, retry, empty state, no results) */
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'upload') els.fileInput.click();
    else if (action === 'clear-filters') clearFilters();
    else if (action === 'retry') {
      els.grid.classList.add('is-empty');
      els.grid.innerHTML = '<div class="library-loading"><span class="spinner"></span><span>Opening your library…</span></div>';
      refreshLibrary({ animate: true }).catch((error) => showLibraryError(error));
    } else if (action === 'retry-chapter') {
      state.chapterCache.delete(state.chapterIndex);
      loadChapter(state.chapterIndex);
    }
  });

  /* Library cards */
  els.grid.addEventListener('click', (event) => {
    const deleteButton = event.target.closest('.card-delete');
    if (deleteButton) {
      event.preventDefault();
      event.stopPropagation();
      const card = deleteButton.closest('.card');
      if (card) deleteBook(card.dataset.id);
      return;
    }

    const tagButton = event.target.closest('.tag-pill[data-tag]');
    if (tagButton) {
      event.preventDefault();
      event.stopPropagation();
      setTagFilter(tagButton.dataset.tag);
    }
  });

  /* Upload button & picker */
  els.addBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    if (els.fileInput.files?.length) handleFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  /* Drag & drop */
  const isFileDrag = (event) => event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files');

  window.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    els.dropOverlay.hidden = false;
  });

  window.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (event) => {
    /* relatedTarget is null when the pointer leaves the whole document. */
    if (!event.relatedTarget) els.dropOverlay.hidden = true;
  });

  window.addEventListener('dragend', () => {
    els.dropOverlay.hidden = true;
  });

  window.addEventListener('drop', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    els.dropOverlay.hidden = true;
    handleFiles(event.dataTransfer.files);
  });

  /* Routing into the reader */
  window.addEventListener('hashchange', handleRoute);
  window.addEventListener('beforeunload', () => {
    if (state.readerOpen) saveCurrentPosition();
  });

  /* Reader chrome */
  els.readerBack.addEventListener('click', () => closeReader());
  els.chapterToggle.addEventListener('click', () => {
    els.reader.classList.toggle('show-chapters');
  });
  els.chapterScrim.addEventListener('click', () => els.reader.classList.remove('show-chapters'));

  els.chapterListItems.addEventListener('click', (event) => {
    const item = event.target.closest('.chapter-item');
    if (!item) return;
    goToChapter(Number(item.dataset.index));
  });

  els.prevChapter.addEventListener('click', prevChapter);
  els.nextChapter.addEventListener('click', nextChapter);

  els.readerContent.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-chapter]');
    if (!link) return;
    event.preventDefault();
    goToChapter(Number(link.dataset.chapter), { frag: link.dataset.frag });
  });

  /* Reader settings */
  els.settingsBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleReaderSettings();
  });

  document.addEventListener('click', (event) => {
    if (els.readerSettings.hidden) return;
    if (els.readerSettings.contains(event.target) || els.settingsBtn.contains(event.target)) return;
    closeReaderSettings();
  });

  els.readerSettings.addEventListener('click', (event) => {
    const sizeButton = event.target.closest('[data-font-size]');
    if (sizeButton) {
      const delta = Number(sizeButton.dataset.fontSize);
      state.settings.size = clamp(state.settings.size + delta, 15, 28);
      persistSettings();
      applyReaderSettings();
      return;
    }

    const segmentButton = event.target.closest('.segmented button');
    if (!segmentButton) return;
    const group = segmentButton.closest('.segmented');
    const key = group?.dataset.setting;
    const value = segmentButton.dataset.value;
    if (!key) return;

    if (key === 'family') state.settings.family = value === 'sans' ? 'sans' : 'serif';
    else if (key === 'leading') state.settings.leading = clamp(Number(value) || DEFAULT_SETTINGS.leading, 1.4, 2.1);
    else if (key === 'theme') {
      setTheme(value);
      return;
    }
    persistSettings();
    applyReaderSettings();
  });

  /* Reader scrolling */
  els.readerScroll.addEventListener('scroll', () => {
    updateReaderProgress();
    window.clearTimeout(state.scrollSaveTimer);
    state.scrollSaveTimer = window.setTimeout(() => {
      if (!state.readerOpen) return;
      saveCurrentPosition();
    }, 180);
  });

  /* Keyboard */
  document.addEventListener('keydown', (event) => {
    if (!state.readerOpen) {
      if (event.key === '/' && !isTypingTarget(event.target)) {
        event.preventDefault();
        els.search.focus();
      }
      return;
    }

    if (event.key === 'Escape') {
      if (!els.readerSettings.hidden) {
        closeReaderSettings();
        return;
      }
      if (els.reader.classList.contains('show-chapters')) {
        els.reader.classList.remove('show-chapters');
        return;
      }
      closeReader();
      return;
    }

    if (!els.readerSettings.hidden || isTypingTarget(event.target)) return;

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      nextChapter();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      prevChapter();
    } else if (event.key === ' ' || event.key === 'PageDown') {
      event.preventDefault();
      els.readerScroll.scrollBy({ top: els.readerScroll.clientHeight * 0.85, behavior: 'smooth' });
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      els.readerScroll.scrollBy({ top: -els.readerScroll.clientHeight * 0.85, behavior: 'smooth' });
    } else if (event.key === 'Home') {
      event.preventDefault();
      els.readerScroll.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (event.key === 'End') {
      event.preventDefault();
      els.readerScroll.scrollTo({ top: els.readerScroll.scrollHeight, behavior: 'smooth' });
    }
  });
}

async function handleRoute() {
  const match = location.hash.match(/^#\/read\/([a-z0-9][a-z0-9-]{0,120})$/i);
  if (match) {
    if (!state.readerOpen || state.book?.id !== match[1]) await openBook(match[1]);
    return;
  }
  if (state.readerOpen) closeReader({ fromRoute: true });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function init() {
  state.settings = loadSettings();
  applyReaderSettings();
  syncThemeUI();
  bindEvents();
  renderLibrary();

  try {
    await refreshLibrary({ animate: true });
  } catch (error) {
    showLibraryError(error);
    return;
  }

  if (location.hash.startsWith('#/read/')) {
    handleRoute();
  }
}

init();
