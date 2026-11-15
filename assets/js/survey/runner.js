/* ==========================================================================
   Survey runner: page flow, autosave, tag handling, submission.
   ========================================================================== */

import { CONFIG } from '../config.js';
import { initI18n, t, loc, mountLanguageSelect } from '../lib/i18n.js';
import { el, $, copyText, debounce, clamp } from '../lib/util.js';
import { toast, scrollToTop, focusHeading, renderRich } from '../lib/ui.js';
import { loadJSON } from '../lib/net.js';
import { apiConfigured, loadResponse, saveResponse, withRetry } from '../lib/api.js';
import * as storage from '../lib/storage.js';
import { SurveyLoader, ensurePresentations, applyPresentation } from './schema.js';
import { SurveyState } from './state.js';
import { renderPage, showBlockError, clearAllErrors } from './render.js';

const TAG_LENGTH = CONFIG.tagLength;

function randomTag() {
  const bytes = new Uint8Array(TAG_LENGTH);
  crypto.getRandomValues(bytes);
  // The alphabet length (32) divides 256 evenly, so this stays unbiased.
  return Array.from(bytes, (byte) => CONFIG.tagAlphabet[byte % CONFIG.tagAlphabet.length]).join('');
}

function randomSeed() {
  return `seed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SurveyRunner {
  constructor({ survey, entry, site }) {
    this.survey = survey;
    this.entry = entry;
    this.site = site;
    this.pages = survey.pages || [];
    this.pageIndex = 0;
    this.state = null;
    this.syncInFlight = false;
    this.lastSyncAt = 0;
    this.pendingSync = false;
    this.syncFailed = false;
    this.timer = null;
  }

  /* --- Boot ------------------------------------------------------------ */

  async start() {
    const flow = this.survey.flow || {};
    this.baselineId = flow.baselineSurvey || null;

    if (this.entry.status === 'scheduled') return this.showBlocked('scheduled');
    if (this.entry.status === 'closed' && !storage.readDraft(this.survey.id)) {
      return this.showBlocked('closed');
    }

    const draft = storage.readDraft(this.survey.id);
    const profile = storage.readProfile();

    if (draft && draft.tag) {
      this.state = new SurveyState({
        survey: this.survey,
        tag: draft.tag,
        answers: draft.answers,
        presentation: draft.presentation,
        pageId: draft.pageId,
        final: draft.final,
      });
      this.state.tagVerified = true;
      this.resumed = true;
    } else {
      this.state = new SurveyState({ survey: this.survey });
      if (profile.tag) {
        const restored = await this.resumeFromCloud(profile.tag).catch(() => false);
        if (restored) this.resumed = true;
      }
    }

    this.mountChrome();
    this.initPresentation();
    this.restorePagePosition();

    if (this.state.final) {
      const doneIndex = this.pages.findIndex((page) => page.kind === 'completion');
      if (doneIndex >= 0) this.pageIndex = doneIndex;
    } else if (
      this.baselineId &&
      this.state.tagVerified &&
      this.state.pageId === this.pages[0]?.id &&
      Object.keys(this.state.answers).length > 0
    ) {
      // Returning Round 2 participant: the tag has already been verified.
      this.pageIndex = Math.min(1, this.pages.length - 1);
    }

    this.setSaveState('local');
    this.render();
    this.persistLocal();
    this.startAutosave();

    // Test hooks for the automated suite (tools/survey-test.mjs): a read-only
    // snapshot of the participant's own answers plus a way to force the pending
    // save, so a test does not have to wait out the autosave debounce.
    window.__maelstrom = {
      surveyId: this.survey.id,
      snapshot: () => this.state.toRecord(),
      flush: () => this.syncCloud({ force: true, final: this.state.final }),
    };

    if (this.resumed && !this.state.final) {
      toast(t('survey.resume.restored'), { tone: 'ok' });
    }

    document.addEventListener('languagechange', () => {
      this.updateChromeText();
      this.render();
    });

    if (this.state.final && !this.state.synced && apiConfigured()) {
      this.syncCloud({ force: true, final: true });
    }
  }

  /* --- Presentation ---------------------------------------------------- */

  initPresentation() {
    const seed = this.state.tag || this.state.presentation.__seed || randomSeed();
    const presentations = ensurePresentations(this.survey, seed, this.state.presentation);
    presentations.__seed = seed;
    this.state.presentation = presentations;
    this.applyAllPresentations();
  }

  rebuildPresentation(seed) {
    const presentations = ensurePresentations(this.survey, seed, {});
    presentations.__seed = seed;
    this.state.presentation = presentations;
    this.applyAllPresentations();
  }

  applyAllPresentations() {
    for (const page of this.pages) {
      if (page.randomize === 'blocks') applyPresentation(page, this.state.presentation[page.id]);
    }
  }

  /* --- Chrome ---------------------------------------------------------- */

  mountChrome() {
    mountLanguageSelect($('#lang-slot'));
    this.updateChromeText();

    if (this.site?.notice) {
      const strip = $('#site-notice');
      if (strip && !strip.dataset.filled) {
        strip.hidden = false;
        strip.dataset.filled = 'true';
        strip.appendChild(el('span.notice-strip__icon', { 'aria-hidden': 'true' }, '!'));
        const text = el('span');
        text.appendChild(renderRich(this.site.notice));
        strip.appendChild(text);
      }
      if (strip) strip.hidden = false;
    }
  }

  updateChromeText() {
    $('#survey-code').textContent = loc(this.survey.code) || this.survey.id.toUpperCase();
    $('#survey-name').textContent = loc(this.survey.shortTitle || this.survey.title);
    document.title = `${loc(this.survey.title)} · MAELStrOM`;
  }

  restorePagePosition() {
    if (!this.state.pageId) {
      this.pageIndex = 0;
      return;
    }
    const index = this.pages.findIndex((page) => page.id === this.state.pageId);
    this.pageIndex = index >= 0 ? index : 0;
  }

  /* --- Rendering ------------------------------------------------------- */

  render() {
    const page = this.pages[this.pageIndex];
    if (!page) return;

    const card = $('#card');
    card.textContent = '';

    const progressBar = $('#progress');
    if (progressBar) progressBar.hidden = false;

    if (page.kind === 'completion') {
      card.appendChild(this.renderCompletion(page));
      this.setNavVisible(false);
      this.updateProgress();
      return;
    }

    card.appendChild(
      el(
        'header.page__head',
        {},
        page.eyebrow ? el('p.page__eyebrow', {}, loc(page.eyebrow)) : null,
        el('h1.page__title', { id: 'page-title', tabindex: '-1' }, loc(page.title))
      )
    );

    if (!apiConfigured()) card.appendChild(this.offlineNotice());
    if (this.syncFailed) card.appendChild(this.syncProblemNotice());

    card.appendChild(
      renderPage({
        page,
        state: this.state,
        site: this.site,
        actions: this.actions(),
        onChange: () => this.onChange(),
      })
    );

    this.setNavVisible(true);
    this.updateProgress();
    this.renderNav(page);
    this.updateNavState();
  }

  offlineNotice() {
    return el(
      'div.callout.callout--warn',
      { style: { marginBottom: '1.25rem' } },
      el('span.callout__icon', { 'aria-hidden': 'true' }, '!'),
      el('div', {}, el('p', {}, t('survey.offline.body')))
    );
  }

  renderCompletion(page) {
    const wrapper = el('div.done');
    wrapper.appendChild(el('div.done__icon', { 'aria-hidden': 'true' }, '✓'));
    wrapper.appendChild(el('h1.done__title', { id: 'page-title', tabindex: '-1' }, loc(page.title)));

    wrapper.appendChild(
      el(
        'div.done__body',
        {},
        renderPage({
          page,
          state: this.state,
          site: this.site,
          actions: this.actions(),
          onChange: () => {},
        })
      )
    );

    if (this.syncFailed) wrapper.appendChild(this.syncProblemNotice(true));

    const actions = el(
      'div.done__actions',
      {},
      el('a.btn', { href: 'index.html' }, t('survey.nav.home'))
    );
    if (this.state.tag) {
      actions.appendChild(
        el(
          'button.btn.btn--ghost',
          {
            type: 'button',
            onclick: async () => {
              const copied = await copyText(this.state.tag);
              toast(copied ? t('survey.tag.copied') : t('survey.tag.copyManually'), {
                tone: copied ? 'ok' : 'warn',
              });
            },
          },
          t('survey.tag.copy')
        )
      );
    }
    wrapper.appendChild(actions);

    return wrapper;
  }

  syncProblemNotice(inline = false) {
    return el(
      'div.callout.callout--warn',
      { style: { marginBottom: inline ? '1.25rem' : '1rem' } },
      el('span.callout__icon', { 'aria-hidden': 'true' }, '!'),
      el(
        'div',
        {},
        el('p', {}, t('survey.sync.failed')),
        el(
          'button.btn.btn--ghost',
          {
            type: 'button',
            style: { marginTop: '0.6rem' },
            onclick: async (event) => {
              event.currentTarget.disabled = true;
              const ok = await this.syncCloud({ force: true, final: this.state.final });
              if (ok) {
                this.syncFailed = false;
                this.render();
              } else {
                event.currentTarget.disabled = false;
              }
            },
          },
          t('survey.sync.retry')
        )
      )
    );
  }

  /* --- Navigation ------------------------------------------------------ */

  mountNav() {
    const nav = $('#nav');
    nav.textContent = '';

    this.backButton = el(
      'button.btn.btn--quiet',
      { type: 'button', onclick: () => this.goTo(this.pageIndex - 1) },
      '← ',
      t('survey.nav.back')
    );

    this.hintNode = el('p.nav-bar__hint');

    this.nextButton = el('button.btn', { type: 'button', onclick: () => this.next() }, t('survey.nav.next'));

    nav.appendChild(
      el(
        'div.wrap.nav-bar__inner',
        {},
        this.hintNode,
        el('div.nav-bar__actions', {}, this.backButton, this.nextButton)
      )
    );
  }

  setNavVisible(visible) {
    const nav = $('#nav');
    if (!nav) return;
    nav.hidden = !visible;
    document.body.classList.toggle('has-nav', visible);
  }

  renderNav(page) {
    if (!this.nextButton) this.mountNav();
    this.backButton.hidden = this.pageIndex === 0 || this.state.final;
    this.nextButton.textContent = page.submit
      ? loc(page.submitLabel) || t('survey.nav.submit')
      : loc(page.nextLabel) || t('survey.nav.next');
  }

  updateNavState() {
    if (!this.nextButton) return;
    const page = this.pages[this.pageIndex];
    if (!page) return;
    const complete = this.pageComplete(page);
    this.nextButton.disabled = !complete;
    if (this.hintNode) {
      if (!complete) this.hintNode.textContent = t('survey.nav.incomplete');
      else if (page.submit) this.hintNode.textContent = t('survey.nav.readyToSubmit');
      else this.hintNode.textContent = '';
    }
  }

  pageComplete(page) {
    return this.state.validatePage(page).ok;
  }

  next() {
    const page = this.pages[this.pageIndex];
    if (!page || page.kind === 'completion') return;

    if (!page.submit) {
      const result = this.state.validatePage(page);
      if (!result.ok) {
        clearAllErrors();
        result.errors.forEach((error) => showBlockError(error.blockId, error.message));
        const first = document.querySelector('.q.is-invalid');
        if (first) {
          first.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const focusable = first.querySelector('input, textarea, button');
          if (focusable) focusable.focus({ preventScroll: true });
        }
        toast(t('survey.error.fix'), { tone: 'warn' });
        return;
      }
      this.goTo(this.pageIndex + 1);
      return;
    }

    this.submit();
  }

  goTo(index) {
    const target = clamp(index, 0, this.pages.length - 1);
    if (target === this.pageIndex) return;
    this.pageIndex = target;
    this.state.pageId = this.pages[target].id;
    this.render();
    scrollToTop();
    const heading = document.getElementById('page-title');
    if (heading) focusHeading(heading);
    this.persistLocal();
    this.syncCloud();
  }

  /* --- Answers --------------------------------------------------------- */

  onChange() {
    this.state.dirty = true;
    this.scheduleLocalSave();
    this.updateNavState();
    this.setSaveState(apiConfigured() && this.state.tag ? 'saving' : 'local');
    this.scheduleCloudSync();
  }

  actions() {
    return {
      generateTag: () => this.generateTag(),
      copyTag: async (tag) => copyText(tag),
      lookupTag: (tag) => this.lookupTag(tag),
      resumeWithTag: (tag) => this.resumeWithTag(tag),
      skipLookup: () => this.skipLookup(),
    };
  }

  async generateTag() {
    const hasWork = Object.keys(this.state.answers).length > 1;
    if (this.state.tag && hasWork) {
      const confirmed = window.confirm(t('survey.tag.confirmRegenerate'));
      if (!confirmed) return null;
    }

    let tag = randomTag();
    if (apiConfigured()) {
      // Opportunistic collision check, bounded by a hard deadline. A slow or
      // unreachable response server must never leave the participant staring at
      // a spinning button (the worst case would otherwise be the full 15 s
      // request timeout). A collision is a ~1-in-10^12 event, so giving up
      // after a second and keeping the tag is the right trade.
      const existing = await Promise.race([
        loadResponse(this.survey.id, tag).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 1200)),
      ]);
      if (existing) tag = randomTag();
    }

    this.state.tag = tag;
    this.state.tagVerified = true;
    storage.writeProfile({ tag, lastSurvey: this.survey.id });

    if (this.state.presentation.__seed !== tag) this.rebuildPresentation(tag);

    storage.writeDraft(this.state.toDraft());
    this.updateNavState();
    this.syncCloud({ force: true });
    return tag;
  }

  /** Round 2: verify a tag against the baseline round. */
  async lookupTag(tag) {
    if (!apiConfigured()) return { ok: false, message: t('survey.error.lookupOffline') };

    let baseline = null;
    try {
      baseline = await loadResponse(this.baselineId || this.survey.id, tag);
    } catch {
      return { ok: false, message: t('survey.error.network') };
    }

    if (!baseline) {
      return { ok: false, message: t('survey.tag.notFound'), allowBlank: true };
    }

    let own = null;
    try {
      own = await loadResponse(this.survey.id, tag);
    } catch {
      own = null;
    }

    this.state.tag = tag;
    this.state.tagVerified = true;
    storage.writeProfile({ tag, lastSurvey: this.survey.id });

    if (own?.final) {
      this.state.hydrate(own);
      this.state.baseline = baseline;
      const doneIndex = this.pages.findIndex((page) => page.kind === 'completion');
      if (doneIndex >= 0) this.pageIndex = doneIndex;
      this.applyAllPresentations();
      this.render();
      return { ok: true, advance: false };
    }

    if (own) {
      this.state.hydrate(own);
      this.applyAllPresentations();
    } else {
      this.state.answers = { ...(baseline.answers || {}) };
      this.state.presentation = { ...(baseline.presentation || {}) };
      this.state.presentation.__seed = tag;
      this.state.pageId = this.pages[this.pageIndex].id;
      this.applyAllPresentations();
    }
    this.state.baseline = baseline;

    storage.writeDraft(this.state.toDraft());
    this.updateNavState();

    setTimeout(() => {
      if (this.pageIndex < this.pages.length - 1) this.goTo(this.pageIndex + 1);
    }, 650);

    return { ok: true, advance: true };
  }

  /** Round 2: no earlier record, but the participant wants to continue anyway. */
  async skipLookup() {
    const tag = randomTag();
    this.state.tag = tag;
    this.state.tagVerified = true;
    this.state.baseline = { surveyId: this.baselineId, missing: true, updatedAt: null };
    storage.writeProfile({ tag, lastSurvey: this.survey.id });
    this.rebuildPresentation(tag);
    this.render();
    storage.writeDraft(this.state.toDraft());
    this.syncCloud({ force: true });
    toast(t('survey.tag.blankStarted'), { tone: 'warn', duration: 6000 });
  }

  /** Round 1: restore this survey's own record from the server. */
  async resumeWithTag(tag) {
    if (!apiConfigured()) {
      toast(t('survey.error.lookupOffline'), { tone: 'warn' });
      return;
    }
    toast(t('common.loading'));
    try {
      const record = await loadResponse(this.survey.id, tag);
      if (!record) {
        toast(t('survey.tag.notFound'), { tone: 'warn' });
        return;
      }
      this.state.hydrate(record);
      this.state.tag = tag;
      this.state.tagVerified = true;
      storage.writeProfile({ tag, lastSurvey: this.survey.id });
      this.applyAllPresentations();
      this.restorePagePosition();
      this.render();
      storage.writeDraft(this.state.toDraft());
      toast(t('survey.resume.restored'), { tone: 'ok' });
    } catch {
      toast(t('survey.error.network'), { tone: 'warn' });
    }
  }

  async resumeFromCloud(tag) {
    if (!apiConfigured()) return false;
    let own = null;
    try {
      own = await loadResponse(this.survey.id, tag);
    } catch {
      return false;
    }
    if (!own) return false;
    this.state.hydrate(own);
    this.state.tag = tag;
    this.state.tagVerified = true;
    return true;
  }

  /* --- Progress -------------------------------------------------------- */

  updateProgress() {
    const total = this.pages.length;
    const progress = total <= 1 ? 1 : this.pageIndex / (total - 1);

    const step = $('#progress-step');
    const label = $('#progress-label');
    if (step) step.textContent = t('survey.progress.step', { current: this.pageIndex + 1, total });
    if (label) label.textContent = loc(this.pages[this.pageIndex]?.title);

    requestAnimationFrame(() => {
      const path = document.getElementById('progress-path');
      const thumb = document.getElementById('progress-thumb');
      const clip = document.getElementById('progress-clip-rect');
      if (!path || !thumb) return;

      clip?.setAttribute('width', String(Math.max(0, progress * 1000)));

      const length = path.getTotalLength();
      const point = path.getPointAtLength(length * progress);
      const box = path.ownerSVGElement.getBoundingClientRect();
      // The thumb is positioned against the padded track, not the SVG box, so
      // it can never be clipped at the ends of the wave.
      const track = thumb.parentElement.getBoundingClientRect();
      const x = box.left - track.left + (point.x / 1000) * box.width;
      const y = box.top - track.top + (point.y / 44) * box.height;
      thumb.style.left = `${x}px`;
      thumb.style.top = `${y}px`;
    });
  }

  /* --- Saving ---------------------------------------------------------- */

  scheduleLocalSave() {
    if (!this.localSaveDebounced) {
      this.localSaveDebounced = debounce(() => this.persistLocal(), CONFIG.localSaveDelayMs);
    }
    this.localSaveDebounced();
  }

  persistLocal() {
    if (!this.state) return;
    try {
      storage.writeDraft(this.state.toDraft());
      if (apiConfigured() && this.state.tag && !this.state.synced) this.setSaveState('local');
    } catch {
      this.setSaveState('error');
    }
  }

  scheduleCloudSync() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncCloud(), CONFIG.syncIntervalMs * 0.4);
  }

  startAutosave() {
    this.stopAutosave();
    this.autosaveInterval = setInterval(() => {
      if (this.state?.dirty) this.syncCloud({ force: true });
    }, CONFIG.syncIntervalMs);

    window.addEventListener('pagehide', () => this.persistLocal());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.persistLocal();
        if (this.state?.dirty) this.syncCloud({ force: true });
      }
    });
  }

  stopAutosave() {
    clearInterval(this.autosaveInterval);
    clearTimeout(this.timer);
  }

  /**
   * Push the current draft to the worker.
   * @returns {Promise<boolean>} whether the server confirmed the save
   */
  async syncCloud({ force = false, final = false } = {}) {
    if (!apiConfigured() || !this.state?.tag) {
      this.setSaveState('local');
      return false;
    }

    if (this.syncInFlight) {
      this.pendingSync = true;
      return false;
    }

    const now = Date.now();
    if (!force && now - this.lastSyncAt < CONFIG.syncIntervalMs * 0.5) {
      this.pendingSync = true;
      return false;
    }

    this.syncInFlight = true;
    this.setSaveState('saving');
    try {
      await withRetry(
        () =>
          saveResponse({
            ...this.state.toRecord({
              meta: {
                lang: document.documentElement.lang,
                tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
                userAgent: navigator.userAgent.slice(0, 180),
              },
            }),
            final: final || this.state.final,
          }),
        { attempts: 2, delayMs: 900 }
      );
      this.state.dirty = false;
      this.state.synced = true;
      this.lastSyncAt = Date.now();
      this.syncFailed = false;
      this.setSaveState('saved');
      storage.writeDraft(this.state.toDraft());
      return true;
    } catch (error) {
      this.syncFailed = true;
      this.setSaveState('error');
      console.warn('[survey] sync failed', error);
      return false;
    } finally {
      this.syncInFlight = false;
      if (this.pendingSync) {
        this.pendingSync = false;
        setTimeout(() => this.syncCloud({ force: true }), 1500);
      }
    }
  }

  setSaveState(kind) {
    const node = $('#save-state');
    if (!node) return;
    node.dataset.state = kind;
    const text = node.querySelector('.save-state__text');
    const key =
      kind === 'saved'
        ? 'survey.save.saved'
        : kind === 'saving'
          ? 'survey.save.saving'
          : kind === 'error'
            ? 'survey.save.error'
            : 'survey.save.local';
    if (text) text.textContent = t(key);
  }

  /* --- Submit ---------------------------------------------------------- */

  async submit() {
    const page = this.pages[this.pageIndex];
    if (!page.submit) return;

    this.state.final = true;
    this.persistLocal();
    storage.markCompleted(this.survey.id);
    if (this.state.tag) storage.writeProfile({ tag: this.state.tag, lastSurvey: this.survey.id });

    // Start the final save immediately, but do not block the thank-you page on
    // it: on a poor connection the request can take many seconds, and a frozen
    // submit button looks like a broken site. The local draft is already marked
    // final, and the next visit retries anything that did not reach the server.
    const pendingSave = this.syncCloud({ force: true, final: true });

    const doneIndex = this.pages.findIndex((candidate) => candidate.kind === 'completion');
    this.goTo(doneIndex >= 0 ? doneIndex : this.pages.length - 1);

    const ok = await pendingSave;
    if (!ok && apiConfigured()) {
      this.syncFailed = true;
      this.render();
      toast(t('survey.sync.failed'), { tone: 'warn', duration: 8000 });
    }
  }

  /* --- Blocked states -------------------------------------------------- */

  showBlocked(kind) {
    const card = $('#card');
    if (!card) return;
    const titles = {
      scheduled: 'survey.blocked.scheduled.title',
      closed: 'survey.blocked.closed.title',
      submitted: 'survey.blocked.submitted.title',
      notFound: 'survey.error.notFound.title',
    };
    const texts = {
      scheduled: 'survey.blocked.scheduled.text',
      closed: 'survey.blocked.closed.text',
      submitted: 'survey.blocked.submitted.text',
      notFound: 'survey.error.notFound.text',
    };

    card.textContent = '';
    card.appendChild(
      el(
        'div.blocked',
        {},
        el('h1.blocked__title', {}, t(titles[kind] || 'survey.error.notFound.title')),
        el('p.blocked__text', {}, t(texts[kind] || 'survey.error.notFound.text')),
        el('a.btn', { href: 'index.html' }, t('survey.nav.home'))
      )
    );
    this.setNavVisible(false);
    const progress = $('#progress');
    if (progress) progress.hidden = true;
  }
}

/* --- Entry point --------------------------------------------------------- */

async function boot() {
  const params = new URLSearchParams(window.location.search);
  await initI18n(params.get('lang') || undefined);

  const site = await loadJSON('data/site.json', {});
  const loader = new SurveyLoader();

  let index;
  try {
    index = await loader.getIndex();
  } catch (error) {
    console.error(error);
    fatal(t('survey.error.loadFailed'));
    return;
  }

  let surveyId = params.get('s');
  if (!surveyId) {
    const firstOpen = (index.surveys || []).find((entry) => entry.status === 'open');
    surveyId = firstOpen?.id;
  }

  const entry = (index.surveys || []).find((candidate) => candidate.id === surveyId);
  if (!entry) {
    fatal(t('survey.error.notFound.text'));
    return;
  }

  let survey;
  try {
    survey = await loader.get(entry.id);
  } catch (error) {
    console.error(error);
    fatal(t('survey.error.loadFailed'));
    return;
  }

  const runner = new SurveyRunner({ survey, entry, site });
  await runner.start();
}

function fatal(message) {
  const card = $('#card');
  if (!card) return;
  card.textContent = '';
  card.appendChild(
    el(
      'div.blocked',
      {},
      el('h1.blocked__title', {}, t('survey.error.notFound.title')),
      el('p.blocked__text', {}, message),
      el('a.btn', { href: 'index.html' }, t('survey.nav.home'))
    )
  );
}

boot().catch((error) => {
  console.error(error);
  fatal(t('survey.error.loadFailed'));
});
