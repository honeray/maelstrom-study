/* ==========================================================================
   Homepage: survey banners, study documents, tag-based resume.
   ========================================================================== */

import { CONFIG } from '../config.js';
import { initI18n, t, loc, mountLanguageSelect, applyStaticI18n } from '../lib/i18n.js';
import { $, el, formatBytes, formatDate } from '../lib/util.js';
import { loadJSON } from '../lib/net.js';
import { apiConfigured, fetchStatus } from '../lib/api.js';
import * as storage from '../lib/storage.js';
import { renderContact } from '../lib/ui.js';

const model = {
  site: {},
  entries: [],
  details: new Map(),
  remoteStatus: {},
  profile: storage.readProfile(),
  docs: [],
};

/* --- Boot ---------------------------------------------------------------- */

async function boot() {
  await initI18n();
  applyStaticI18n(document);
  mountLanguageSelect($('#lang-slot'));

  document.addEventListener('languagechange', () => {
    applyStaticI18n(document);
    renderAll();
  });

  const [site, index] = await Promise.all([
    loadJSON('data/site.json', {}),
    loadJSON('data/surveys.json', { surveys: [] }),
  ]);

  model.site = site || {};
  model.entries = (index?.surveys || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  renderFooter();

  if (!apiConfigured()) {
    const strip = $('#offline-strip');
    if (strip) strip.hidden = false;
  }

  await loadDetails();
  await loadRemoteStatus();

  renderAll();
  wireResumeForm();
}

async function loadDetails() {
  await Promise.all(
    model.entries.map(async (entry) => {
      try {
        const response = await fetch(entry.file, { cache: 'no-cache' });
        if (!response.ok) return;
        const survey = await response.json();
        model.details.set(entry.id, {
          title: survey.title,
          shortTitle: survey.shortTitle,
          summary: survey.summary,
          estimateMinutes: survey.estimateMinutes,
        });
      } catch {
        /* A broken survey file must not take the homepage down. */
      }
    })
  );
}

async function loadRemoteStatus() {
  if (!model.profile.tag || !apiConfigured()) return;
  try {
    model.remoteStatus = await fetchStatus(model.profile.tag);
  } catch {
    model.remoteStatus = {};
  }
}

/* --- Rendering ----------------------------------------------------------- */

function renderAll() {
  renderSurveys();
  renderDocs();
  renderHeroCta();
}

function surveyState(entry) {
  if (entry.status === 'scheduled') return 'scheduled';
  if (storage.isCompletedLocally(entry.id) || model.remoteStatus?.[entry.id]?.final) return 'done';
  if (entry.status === 'closed') return 'closed';
  return 'open';
}

function renderSurveys() {
  const list = $('#surveys-list');
  if (!list) return;
  list.textContent = '';

  const openCount = model.entries.filter((entry) => surveyState(entry) === 'open').length;
  const count = $('#surveys-count');
  if (count) {
    count.textContent = openCount
      ? t('home.surveys.count', { open: openCount, total: model.entries.length })
      : t('home.surveys.countNone', { total: model.entries.length });
  }

  for (const entry of model.entries) {
    const detail = model.details.get(entry.id) || {};
    const state = surveyState(entry);
    const title = loc(detail.title) || entry.id;
    const meta = [];
    const code = el('span.banner__code', { 'aria-hidden': 'true' }, entry.code || entry.id.slice(0, 2).toUpperCase());

    if (state === 'open') {
      meta.push(el('span.chip.chip--open', {}, t('home.status.open')));
    } else if (state === 'done') {
      meta.push(el('span.chip.chip--done', {}, t('home.status.done')));
      const stamp = model.remoteStatus?.[entry.id]?.updatedAt || storage.readProfile().completed?.[entry.id]?.at;
      if (stamp) meta.push(el('span', {}, formatDate(stamp, document.documentElement.lang)));
    } else if (state === 'closed') {
      meta.push(el('span.chip.chip--closed', {}, t('home.status.closed')));
    } else {
      meta.push(el('span.chip.chip--scheduled', {}, t('home.status.scheduled')));
    }

    if (detail.estimateMinutes) {
      meta.push(el('span.dot', { 'aria-hidden': 'true' }));
      meta.push(el('span', {}, t('home.meta.minutes', { minutes: detail.estimateMinutes })));
    }

    const body = el(
      'div.banner__body',
      {},
      el('h3.banner__title', {}, title),
      el('div.banner__meta', {}, ...meta)
    );

    let node;
    if (state === 'open') {
      node = el(
        'a.banner.banner--link',
        { href: `survey.html?s=${encodeURIComponent(entry.id)}` },
        code,
        body,
        el(
          'span.banner__cta',
          {},
          t('home.status.enter'),
          iconArrow()
        )
      );
    } else {
      const label =
        state === 'done'
          ? t('home.status.doneLabel')
          : state === 'closed'
            ? t('home.status.closedLabel')
            : t('home.status.scheduledLabel');
      node = el(
        'div.banner' + `.banner--${state === 'done' ? 'done' : state === 'closed' ? 'closed' : 'scheduled'}`,
        { 'aria-disabled': 'true' },
        code,
        body,
        el('span.banner__cta.banner__cta--muted', {}, iconLock(state), label)
      );
    }

    list.appendChild(el('li', {}, node));
  }
}

function iconArrow() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path fill="currentColor" d="M6.3 3.3 4.9 4.7 8.2 8l-3.3 3.3 1.4 1.4L11 8z"/>';
  return svg;
}

function iconLock(state) {
  const span = el('span', { 'aria-hidden': 'true' });
  span.textContent = state === 'done' ? '✓' : state === 'closed' ? '🔒' : '◷';
  return span;
}

function renderDocs() {
  const list = $('#docs-list');
  const empty = $('#docs-empty');
  if (!list) return;
  list.textContent = '';

  const files = model.docs || [];
  if (!files.length) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  for (const file of files) {
    const ext = (file.ext || file.name?.split('.').pop() || 'file').toUpperCase();
    const metas = [];
    if (file.size) metas.push(formatBytes(file.size));
    if (file.updated) metas.push(formatDate(file.updated, document.documentElement.lang));

    list.appendChild(
      el(
        'li',
        {},
        el(
          'a.doc',
          { href: file.path, target: '_blank', rel: 'noopener' },
          el('span.doc__icon', { 'aria-hidden': 'true' }, ext),
          el(
            'div',
            { style: { minWidth: '0' } },
            el('p.doc__title', {}, file.title || file.name),
            el('p.doc__meta', {}, metas.join(' · '))
          ),
          el('span.doc__arrow', { 'aria-hidden': 'true' }, '↗')
        )
      )
    );
  }
}

function renderHeroCta() {
  const cta = $('#hero-cta');
  if (!cta) return;
  const firstOpen = model.entries.find((entry) => surveyState(entry) === 'open');
  if (firstOpen) {
    cta.href = `survey.html?s=${encodeURIComponent(firstOpen.id)}`;
    cta.textContent = t('home.hero.cta');
  } else {
    cta.href = '#surveys';
    cta.textContent = t('home.hero.ctaNone');
  }
}

function renderFooter() {
  const slot = $('#contact-slot');
  if (slot) {
    slot.textContent = '';
    const contact = renderContact(model.site?.contact);
    if (contact) slot.appendChild(contact);
  }
  const year = $('#footer-year');
  if (year) year.textContent = String(new Date().getFullYear());
}

/* --- Resume -------------------------------------------------------------- */

function wireResumeForm() {
  const form = $('#resume-form');
  const input = $('#resume-input');
  const message = $('#resume-message');
  if (!form || !input) return;

  if (model.profile.tag) input.value = model.profile.tag;

  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CONFIG.tagLength);
    if (message) message.textContent = '';
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const tag = input.value.trim().toUpperCase();
    if (tag.length !== CONFIG.tagLength) {
      if (message) {
        message.dataset.tone = 'error';
        message.textContent = t('home.resume.invalid');
      }
      input.focus();
      return;
    }

    storage.writeProfile({ tag });
    model.profile = storage.readProfile();
    if (message) {
      message.dataset.tone = '';
      message.textContent = t('common.loading');
    }

    let statuses = {};
    if (apiConfigured()) {
      statuses = await fetchStatus(tag).catch(() => ({}));
      model.remoteStatus = statuses;
    }

    const open = model.entries.filter((entry) => entry.status === 'open');
    const unfinished = open
      .filter((entry) => statuses?.[entry.id] && !statuses[entry.id].final)
      .sort((a, b) => String(statuses[b.id]?.updatedAt).localeCompare(String(statuses[a.id]?.updatedAt)));

    let target = unfinished[0];

    if (!target) {
      target = open.find((entry) => {
        const draft = storage.readDraft(entry.id);
        return draft && draft.tag === tag && !draft.final;
      });
    }

    if (!target) {
      target = open.find((entry) => !statuses?.[entry.id]?.final);
    }

    if (target) {
      window.location.href = `survey.html?s=${encodeURIComponent(target.id)}`;
      return;
    }

    renderSurveys();
    if (message) {
      message.dataset.tone = 'ok';
      message.textContent =
        open.length === 0 ? t('home.resume.noneOpen') : t('home.resume.none');
    }
  });
}

boot().catch((error) => {
  console.error(error);
  const list = $('#surveys-list');
  if (list) {
    list.textContent = '';
    list.appendChild(el('li.doc-empty', {}, t('home.error.load')));
  }
});
