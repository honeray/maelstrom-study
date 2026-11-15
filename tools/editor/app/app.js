/* MAELStrOM text editor.
   Talks to tools/editor/server.mjs, which owns the files. The preview is the
   real site in an iframe opened with ?edit=1, where every rendered string is
   tagged with the JSON location it came from. */

const LANGS = ['en', 'zh', 'fr'];
const LANG_LABEL = { en: 'EN', zh: '中文', fr: 'FR' };

const $ = (id) => document.getElementById(id);
const frame = $('preview');

const state = {
  lang: 'en',
  view: 'home',
  entries: [],
  byId: new Map(),
  surveys: [],
  current: null,
  element: null,
  editMode: true,
  loading: false,
};

/* ------------------------------------------------------------------ utils */

const escapeHtml = (value) =>
  String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

let toastTimer = null;
function toast(message, isError = false) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('is-error', isError);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

async function api(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

const post = (path, body) =>
  api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/* ------------------------------------------------------------------- boot */

async function boot() {
  try {
    await api('/api/health');
  } catch {
    document.body.innerHTML =
      '<div class="empty" style="margin:40px auto;max-width:560px">' +
      '<h2>This editor needs its local server</h2>' +
      '<p>Run <code>npm run edit</code> in the project folder and open the address it prints.</p>' +
      '</div>';
    return;
  }

  await refreshCatalog();
  bindControls();
  loadPreview();

  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('id')) {
    const entry = state.byId.get(hash.get('id'));
    if (entry) openEntry(entry, null);
  }
}

async function refreshCatalog() {
  const catalog = await api('/api/catalog');
  state.entries = catalog.entries || [];
  state.surveys = catalog.surveys || [];
  state.byId = new Map(state.entries.map((entry) => [entry.id, entry]));

  const surveySelect = $('survey');
  surveySelect.innerHTML =
    '<option value="home">Homepage</option>' +
    state.surveys
      .map((survey) => `<option value="${escapeHtml(survey.id)}">${escapeHtml(survey.title || survey.id)}</option>`)
      .join('');
  surveySelect.value = state.view;

  renderList();
}

/* ------------------------------------------------------------------- list */

function matches(entry, needle) {
  if (!needle) return true;
  const haystack = `${entry.group} ${entry.context} ${LANGS.map((lang) => entry.values[lang] || '').join(' ')}`.toLowerCase();
  return haystack.includes(needle);
}

function renderList() {
  const needle = $('search').value.trim().toLowerCase();
  const visible = state.entries.filter((entry) => matches(entry, needle));
  $('count').textContent = needle
    ? `${visible.length} of ${state.entries.length} strings`
    : `${state.entries.length} strings`;

  const groups = new Map();
  for (const entry of visible) {
    const key = entry.group || 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const container = $('list');
  container.innerHTML = '';
  for (const [group, items] of groups) {
    const heading = document.createElement('div');
    heading.className = 'group';
    heading.textContent = group;
    container.appendChild(heading);

    for (const entry of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'row';
      row.dataset.id = entry.id;
      if (state.current && state.current.id === entry.id) row.classList.add('is-active');
      const text = entry.values[state.lang] || entry.values.en || '(empty)';
      row.innerHTML =
        `<span class="row__text">${escapeHtml(text)}</span>` +
        `<span class="row__context">${escapeHtml(entry.context || '')}</span>` +
        (entry.shared && entry.shared.length ? '<span class="row__shared">also used in Round 2</span>' : '');
      row.addEventListener('click', () => openEntry(entry, null));
      container.appendChild(row);
    }
  }
}

/* ---------------------------------------------------------------- preview */

function previewUrl() {
  const lang = state.lang;
  return state.view === 'home'
    ? `/?lang=${lang}&edit=1`
    : `/survey.html?s=${encodeURIComponent(state.view)}&lang=${lang}&edit=1`;
}

const PREVIEW_CSS = `
  [data-loc], [data-i18n] { cursor: text; }
  [data-loc]:hover, [data-i18n]:hover { outline: 2px dashed #1668c9; outline-offset: 2px; }
`;

function loadPreview() {
  frame.src = previewUrl();
  frame.onload = () => {
    attachPreview();
    // The survey runner fetches its JSON after the load event, so the editor
    // hook appears a little later. Poll briefly for it.
    if (state.view === 'home') {
      syncPages();
      return;
    }
    let attempts = 0;
    const wait = () => {
      const hook = frame.contentWindow && frame.contentWindow.__maelstromEdit;
      if (hook || attempts > 30) {
        syncPages();
        return;
      }
      attempts += 1;
      setTimeout(wait, 150);
    };
    wait();
  };
}

function attachPreview() {
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.addEventListener('click', onPreviewClick, true);
  if (!doc.getElementById('editor-style')) {
    const style = doc.createElement('style');
    style.id = 'editor-style';
    style.textContent = PREVIEW_CSS;
    doc.head.appendChild(style);
  }
}

function onPreviewClick(event) {
  if (!state.editMode && !event.altKey) return;
  const target = event.target;
  // Elements come from the iframe's realm, so `instanceof Element` would be
  // false here; duck-type instead.
  if (!target || typeof target.closest !== 'function') return;

  const locElement = target.closest('[data-loc]');
  const i18nElement = target.closest('[data-i18n]');

  let entry = null;
  let element = null;

  if (locElement) {
    entry = entryForLoc(locElement.getAttribute('data-loc'));
    element = locElement;
  } else if (i18nElement && !i18nElement.closest('button, a')) {
    entry = entryForI18n(i18nElement.getAttribute('data-i18n'));
    element = i18nElement;
  }

  if (!entry) return; // not an editable string: let the site behave normally

  event.preventDefault();
  event.stopPropagation();
  openEntry(entry, element);
}

function entryForLoc(value) {
  if (!value) return null;
  const hash = value.indexOf('#');
  if (hash < 0) return null;
  return state.byId.get(`${value.slice(0, hash)}#${value.slice(hash + 1)}`) || null;
}

function entryForI18n(key) {
  if (!key) return null;
  return state.byId.get(`i18n/${key.split('.').join('/')}`) || null;
}

function syncPages() {
  const select = $('page');
  const hook = frame.contentWindow && frame.contentWindow.__maelstromEdit;
  if (!hook) {
    select.innerHTML = '<option>—</option>';
    select.disabled = true;
    return;
  }
  const pages = hook.pages();
  select.innerHTML = pages
    .map((page) => `<option value="${escapeHtml(page.id)}">${escapeHtml(page.title || page.id)}</option>`)
    .join('');
  select.value = hook.current() || '';
  select.disabled = false;
}

function goToPage(pageId) {
  const hook = frame.contentWindow && frame.contentWindow.__maelstromEdit;
  if (!hook || !pageId) return;
  hook.goToPage(pageId);
  const select = $('page');
  if (select) select.value = pageId;
}

/* ----------------------------------------------------------------- editor */

function openEntry(entry, element) {
  state.current = entry;
  state.element = element || null;

  $('empty').hidden = true;
  $('editor').hidden = false;

  $('crumb').textContent = `${entry.group} › ${entry.context}`;

  const shared = $('shared');
  if (entry.shared && entry.shared.length) {
    shared.hidden = false;
    shared.textContent = `Shared text: these pages are included by ${entry.shared.join(', ')}, so this edit changes both rounds.`;
  } else {
    shared.hidden = true;
  }

  const textarea = $('value');
  textarea.value = entry.values[state.lang] ?? '';
  textarea.dataset.baseline = textarea.value;
  $('meta').textContent = `${entry.file}  ·  ${entry.pointer}/${state.lang}`;

  for (const lang of LANGS) {
    const node = document.querySelector(`[data-other="${lang}"]`);
    if (node) node.textContent = entry.values[lang] ?? '';
  }

  $('save').disabled = true;
  $('revert').disabled = true;
  $('diff').hidden = true;

  for (const row of document.querySelectorAll('.row')) {
    const active = row.dataset.id === entry.id;
    row.classList.toggle('is-active', active);
    if (active) row.scrollIntoView({ block: 'nearest' });
  }

  if (entry.page && state.view !== 'home') goToPage(entry.page);

  history.replaceState(null, '', `#id=${encodeURIComponent(entry.id)}`);
  textarea.focus();
}

function isDirty() {
  return $('value').value !== $('value').dataset.baseline;
}

function onInput() {
  const dirty = isDirty();
  $('save').disabled = !dirty;
  $('revert').disabled = !dirty;
}

async function save() {
  const entry = state.current;
  if (!entry || state.loading) return;
  const value = $('value').value;
  if (value === entry.values[state.lang]) return;

  state.loading = true;
  $('save').disabled = true;
  try {
    const result = await post('/api/text', {
      file: entry.file,
      pointer: entry.pointer,
      lang: state.lang,
      value,
    });

    entry.values[state.lang] = value;
    $('value').dataset.baseline = value;
    $('save').disabled = true;
    $('revert').disabled = false;
    $('undo').disabled = false;

    const otherNode = document.querySelector(`[data-other="${state.lang}"]`);
    if (otherNode) otherNode.textContent = value;

    if (state.element && state.element.isConnected) {
      state.element.textContent = value;
    }
    updateListRow(entry);

    const diff = result.diff;
    if (diff) {
      $('diff').hidden = false;
      $('diffHead').textContent = `${result.file} · line ${diff.line}`;
      $('diffBefore').textContent = diff.before;
      $('diffAfter').textContent = diff.after;
    }

    toast(`Saved ${entry.file} — remember to commit`);
    if (/\*\*|\n/.test(value)) reloadSoon();
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.loading = false;
  }
}

function updateListRow(entry) {
  const row = document.querySelector(`.row[data-id="${CSS.escape(entry.id)}"]`);
  if (!row) return;
  const text = entry.values[state.lang] || entry.values.en || '(empty)';
  const node = row.querySelector('.row__text');
  if (node) node.textContent = text;
}

function revert() {
  if (!state.current) return;
  $('value').value = $('value').dataset.baseline;
  onInput();
}

let reloadTimer = null;
function reloadSoon() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const page = state.current && state.current.page;
    loadPreview();
    frame.addEventListener('load', () => page && goToPage(page), { once: true });
  }, 250);
}

async function undo() {
  try {
    const result = await post('/api/undo', {});
    toast(`Reverted ${result.file}`);
    $('undo').disabled = true;
    await refreshCatalog();
    if (state.current) {
      const entry = state.byId.get(state.current.id) || state.current;
      openEntry(entry, null);
    }
    loadPreview();
  } catch (error) {
    toast(error.message, true);
  }
}

/* ---------------------------------------------------------------- controls */

function bindControls() {
  $('lang').addEventListener('change', (event) => {
    state.lang = event.target.value;
    renderList();
    if (state.current) openEntry(state.current, null);
    loadPreview();
  });

  $('survey').addEventListener('change', (event) => {
    state.view = event.target.value;
    loadPreview();
  });

  $('page').addEventListener('change', (event) => goToPage(event.target.value));

  $('editmode').addEventListener('change', (event) => {
    state.editMode = event.target.checked;
    $('hint').textContent = state.editMode
      ? 'Click any highlighted text to edit it. Turn the switch off to answer the survey normally.'
      : 'Interaction mode: clicks behave like the real site. Alt-click still opens text for editing.';
  });

  $('reload').addEventListener('click', () => {
    const page = $('page').value;
    loadPreview();
    frame.addEventListener('load', () => page && goToPage(page), { once: true });
  });

  $('undo').addEventListener('click', undo);
  $('search').addEventListener('input', renderList);
  $('value').addEventListener('input', onInput);
  $('save').addEventListener('click', save);
  $('revert').addEventListener('click', revert);

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!$('save').disabled) save();
    }
  });
}

boot();
