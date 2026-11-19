#!/usr/bin/env node
/**
 * Usability + data-integrity test suite for the MAELStrOM survey site.
 *
 *   node tools/survey-test.mjs [options]
 *
 * Options
 *   --langs=en,zh,fr       languages to run (default: all three)
 *   --tiers=sweep,e2e,recovery,extra
 *                          tiers to run (default: all four)
 *   --quick                en only, sweep + e2e (fast smoke run)
 *   --keep                 keep the temporary profile/report directory
 *   --timeout=120000       per-session navigation timeout in ms
 *
 * What it does
 *   sweep     Field-level exhaustiveness: every option of every question, all
 *             512 factor subsets, every branch state, every scenario state,
 *             free-text filled and empty — each verified against the saved state.
 *   e2e       Complete runs per language, submission, and Round 2 revision with
 *             Round 1 immutability checks.
 *   recovery  Stop at every page boundary, wipe storage (new device), recover
 *             with the eight-character tag, diff the restored answers.
 *   extra     Language switch mid-survey, randomisation determinism, server
 *             outage, keyboard-only completion, a11y labels, mobile layout,
 *             one tag in two browsers, CSV export.
 *
 * Requires Chrome/Edge (CHROME_PATH overrides autodetection) and Node 20+.
 * Uses no npm dependencies and never writes to the real study data repository:
 * a local mock API stands in for the Cloudflare Worker.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { blockRequiresAnswer } from '../assets/js/survey/schema.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SURVEY_R1 = 'delphi-round-1';
const SURVEY_R2 = 'delphi-round-2';
const TAGS = [];

/* ======================================================================== */
/* CLI                                                                       */
/* ======================================================================== */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const QUICK = flag('quick');
const KEEP = flag('keep');
const LANGS = (QUICK ? 'en' : arg('langs', 'en,zh,fr')).split(',').filter(Boolean);
const TIERS = (QUICK ? 'sweep,e2e' : arg('tiers', 'sweep,e2e,recovery,extra'))
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
const NAV_TIMEOUT = Number(arg('timeout', 120000));

/* ======================================================================== */
/* Reporting                                                                 */
/* ======================================================================== */

const results = { checks: 0, passes: 0, failures: [] };
let scope = '';

const setScope = (name) => {
  scope = name;
};

const record = (ok, message, detail) => {
  results.checks += 1;
  if (ok) {
    results.passes += 1;
    return true;
  }
  results.failures.push({ scope, message, detail });
  console.log(`   \u001b[31m\u2717\u001b[0m ${message}${detail === undefined ? '' : ` \u001b[2m${detail}\u001b[0m`}`);
  return false;
};

const ok = (message, detail) => record(true, message, detail);
const check = (condition, message, detail) => record(Boolean(condition), message, detail);

const isTrue = (value, message) => check(value === true, message, `got ${JSON.stringify(value)}`);

/** Key-order-independent serialisation, so answer dicts compare by content. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const same = (actual, expected, message) => {
  const a = stable(actual);
  const e = stable(expected);
  return record(a === e, message, a === e ? undefined : `expected ${e.slice(0, 240)} got ${a.slice(0, 240)}`);
};

const head = (title) => console.log(`\n\u001b[1m${title}\u001b[0m`);

/* ======================================================================== */
/* Data under test                                                           */
/* ======================================================================== */

const surveyR1 = JSON.parse(await readFile(path.join(ROOT, 'data/surveys/delphi-round-1.json'), 'utf8'));
const surveysIndex = JSON.parse(await readFile(path.join(ROOT, 'data/surveys.json'), 'utf8'));
const siteConfig = JSON.parse(await readFile(path.join(ROOT, 'data/site.json'), 'utf8'));

const PAGE = Object.fromEntries(surveyR1.pages.map((p) => [p.id, p]));
const blockById = {};
for (const page of surveyR1.pages) {
  for (const block of page.blocks || []) if (block.id) blockById[block.id] = block;
}
const questionsOn = (pageId) => (PAGE[pageId].blocks || []).filter((b) => b.id && b.type !== 'prose');

/* ======================================================================== */
/* Mock API — same contract as worker/src/index.js, in memory               */
/* ======================================================================== */

const mock = {
  records: new Map(),
  live: new Map(),
  offline: false,
  saves: 0,
  server: null,
  port: 0,

  url() {
    return `http://127.0.0.1:${this.port}`;
  },

  get(surveyId, tag) {
    return this.records.get(`${surveyId}:${tag}`) || null;
  },

  reset() {
    this.records.clear();
    this.live.clear();
    this.saves = 0;
    this.offline = false;
  },

  async start() {
    this.server = createServer(async (req, res) => {
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'cache-control': 'no-store',
      };
      const send = (status, payload) => {
        const body = JSON.stringify(payload);
        res.writeHead(status, { ...cors, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      };

      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }

      const url = new URL(req.url, 'http://localhost');

      // Test control surface
      if (url.pathname === '/__offline') {
        this.offline = url.searchParams.get('on') === '1';
        return send(200, { ok: true, offline: this.offline });
      }
      if (url.pathname === '/__reset') {
        this.reset();
        return send(200, { ok: true });
      }

      if (url.pathname === '/v1/health') return send(200, { ok: true, service: 'mock' });

      if (this.offline && url.pathname !== '/v1/health') {
        return send(503, { ok: false, error: 'offline' });
      }

      if (url.pathname === '/v1/load' && req.method === 'GET') {
        const surveyId = url.searchParams.get('survey') || '';
        const tag = (url.searchParams.get('tag') || '').toUpperCase();
        return send(200, { ok: true, record: this.get(surveyId, tag) });
      }

      if (url.pathname === '/v1/status' && req.method === 'GET') {
        const tag = (url.searchParams.get('tag') || '').toUpperCase();
        return send(200, { ok: true, surveys: this.live.get(tag) || {} });
      }

      if (url.pathname === '/v1/save' && req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(400, { ok: false, error: 'body_invalid' });
        }
        const surveyId = String(body.surveyId || '');
        const tag = String(body.tag || '').toUpperCase();
        if (!/^[A-Z0-9]{8}$/.test(tag)) return send(400, { ok: false, error: 'tag_invalid' });

        const key = `${surveyId}:${tag}`;
        const previous = this.records.get(key);
        const now = new Date(Date.now() + this.saves).toISOString();
        this.saves += 1;
        const record = {
          surveyId,
          tag,
          final: Boolean(body.final) || Boolean(previous?.final),
          pageId: body.pageId,
          firstSeenAt: previous?.firstSeenAt || now,
          updatedAt: now,
          submittedAt: Boolean(body.final) ? previous?.submittedAt || now : null,
          answers: body.answers || {},
          presentation: body.presentation || {},
          baseline: body.baseline || null,
          meta: body.meta || {},
        };
        this.records.set(key, record);
        const live = this.live.get(tag) || {};
        live[surveyId] = { final: record.final, updatedAt: now, pageId: record.pageId };
        this.live.set(tag, live);
        return send(200, { ok: true, updatedAt: now, committed: true });
      }

      return send(404, { ok: false, error: 'not_found' });
    });

    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
  },

  async stop() {
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  },
};

/* ======================================================================== */
/* Static server (rewrites config.js so the page talks to the mock)          */
/* ======================================================================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function startStatic() {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.join(ROOT, relative);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    try {
      let body = await readFile(file);
      if (relative === 'assets/js/config.js') {
        // Point the page at the mock; the committed value is the production URL.
        body = Buffer.from(
          body.toString('utf8').replace(/apiBase:\s*'[^']*'/, `apiBase: '${mock.url()}'`)
        );
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

/* ======================================================================== */
/* Chrome + CDP                                                              */
/* ======================================================================== */

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error('No Chrome/Edge found. Set CHROME_PATH to the executable.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Session {
  constructor(ws, chrome, profileDir) {
    this.ws = ws;
    this.chrome = chrome;
    this.profileDir = profileDir;
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.consoleErrors = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.consoleErrors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });
  }

  static async open({ viewport = { width: 1440, height: 1000 } } = {}) {
    const executable = findChrome();
    const profileDir = await mkdtemp(path.join(os.tmpdir(), 'maelstrom-test-'));
    const chrome = spawn(
      executable,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        'about:blank',
      ],
      { stdio: 'ignore', detached: false }
    );

    const portFile = path.join(profileDir, 'DevToolsActivePort');
    let port = null;
    for (let i = 0; i < 120 && !port; i += 1) {
      await sleep(100);
      try {
        port = Number((await readFile(portFile, 'utf8')).split('\n')[0]);
      } catch {
        /* not yet */
      }
    }
    if (!port) throw new Error('Chrome did not expose a debugging port');

    let target = null;
    for (let i = 0; i < 60 && !target; i += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch {
        /* not yet */
      }
      if (!target) await sleep(200);
    }
    if (!target) throw new Error('Chrome exposed no page target');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    const session = new Session(ws, chrome, profileDir);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.width < 700,
    });
    return session;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  async softEval(expression) {
    try {
      return { ok: true, value: await this.eval(expression) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async goto(url, waitMs = 2500) {
    await this.send('Page.navigate', { url });
    await sleep(waitMs);
  }

  async reload(waitMs = 2500) {
    await this.send('Page.reload', {});
    await sleep(waitMs);
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 700,
    });
    await sleep(300);
  }

  /** Real keyboard events, so focus handling is exercised for real. */
  async press(key) {
    const map = {
      Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
      Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
    };
    const keyDef = map[key];
    if (!keyDef) throw new Error(`unsupported key ${key}`);
    await this.send('Input.dispatchKeyEvent', {
      type: keyDef.text ? 'keyDown' : 'rawKeyDown',
      ...keyDef,
      nativeVirtualKeyCode: keyDef.windowsVirtualKeyCode,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode,
      nativeVirtualKeyCode: keyDef.windowsVirtualKeyCode,
    });
    await sleep(80);
  }

  async waitFor(expression, { timeout = 8000, interval = 100, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.eval(expression).catch(() => false)) return true;
      await sleep(interval);
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  async screenshot(file) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(file, Buffer.from(shot.data, 'base64'));
  }

  async close() {
    // Push any pending answers to the server before tearing the page down,
    // otherwise a test that closes quickly would lose the debounced save.
    try {
      await Promise.race([
        this.eval('window.__maelstrom ? window.__maelstrom.flush() : null'),
        sleep(2500),
      ]);
      await sleep(250);
    } catch {
      /* the page may already be navigating */
    }
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    try {
      this.chrome.kill();
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 20; i += 1) {
      try {
        await rm(this.profileDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(250);
      }
    }
  }
}

/* ======================================================================== */
/* Survey driver                                                             */
/* ======================================================================== */

let BASE = '';

const url = (pathname) => `${BASE}${pathname}`;

const surveyUrl = (id, lang) => url(`/survey.html?s=${id}&lang=${lang || 'en'}`);

async function openR1(s, lang) {
  await s.goto(surveyUrl(SURVEY_R1, lang), 3200);
  await s.waitFor("Boolean(document.querySelector('#q-consent_start'))", { label: 'survey page 1' });
}

const snapshot = (s) => s.eval('window.__maelstrom.snapshot()');
const answers = async (s) => (await snapshot(s)).answers;
const currentPage = async (s) => (await snapshot(s)).pageId;

async function nextButton(s) {
  return s.eval(`(()=>{
    const b=document.querySelector('.nav-bar__actions .btn:last-child');
    return b ? { text: b.textContent.trim(), blocked: b.getAttribute('aria-disabled') === 'true', disabled: b.disabled } : null;
  })()`);
}

/** True while the page is not ready — the button stays clickable, but muted. */
const nextDisabled = async (s) => (await nextButton(s))?.blocked;

async function clickNext(s) {
  const result = await s.eval(
    `(()=>{const b=document.querySelector('.nav-bar__actions .btn:last-child');if(!b)return 'no-button';b.click();return 'ok';})()`
  );
  await sleep(450);
  return result;
}

async function clickSelector(s, selector) {
  return s.eval(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return 'missing';e.click();return 'ok';})()`
  );
}

async function chooseOption(s, questionId, value) {
  const result = await s.eval(`(()=>{
    const q=document.querySelector('#q-${questionId}');
    if(!q) return 'no-question';
    const label=[...q.querySelectorAll('.opt')].find((l)=>{const i=l.querySelector('input');return i && i.value===${JSON.stringify(value)};});
    if(!label) return 'no-option';
    label.click();
    return 'ok';
  })()`);
  await sleep(60);
  return result;
}

async function chooseExtent(s, questionId, value) {
  const result = await s.eval(`(()=>{
    const input=document.querySelector('#q-${questionId} .branch input[value=${JSON.stringify(value)}]');
    if(!input) return 'no-extent';
    input.click();
    return 'ok';
  })()`);
  await sleep(60);
  return result;
}

async function typeInto(s, selector, text) {
  const result = await s.eval(`(()=>{
    const el=document.querySelector(${JSON.stringify(selector)});
    if(!el) return 'missing';
    el.focus();
    el.value=${JSON.stringify(text)};
    el.dispatchEvent(new Event('input',{bubbles:true}));
    return 'ok';
  })()`);
  await sleep(60);
  return result;
}

/** Reveals whether the "Other" free-text field is actually visible. */
async function extraVisible(s, questionId) {
  return s.eval(`(()=>{
    const q=document.querySelector('#q-${questionId}');
    const extra=q && q.querySelector('.opt__extra');
    if(!extra) return false;
    const style=getComputedStyle(extra);
    const input=extra.querySelector('input');
    return style.display!=='none' && extra.offsetHeight>0 && input && input.offsetWidth>10;
  })()`);
}

async function generateTag(s) {
  await s.eval("document.querySelector('#q-tag .tag-card__actions .btn').click()");
  await s.waitFor("Boolean(document.querySelector('#q-tag .tag-card__value'))");
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const value = await s.eval("document.querySelector('#q-tag .tag-card__value').textContent.trim()");
    if (/^[A-Z0-9]{8}$/.test(value)) return value;
    await sleep(100);
  }
  throw new Error('tag was not generated');
}

async function waitForPage(s, pageId, timeout = NAV_TIMEOUT) {
  return s.waitFor(`window.__maelstrom && window.__maelstrom.snapshot().pageId === ${JSON.stringify(pageId)}`, {
    timeout,
    label: `page ${pageId}`,
  });
}

async function waitForServer(surveyId, tag, predicate = () => true, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const record = mock.get(surveyId, tag);
    if (record && predicate(record)) return record;
    await sleep(120);
  }
  return null;
}

/** Answer page 1 + page 2; returns the generated tag. */
async function passIntro(s, tag) {
  await clickSelector(s, '#q-consent_start input');
  await clickNext(s);
  await waitForPage(s, 'tag');
  const generated = tag || (await generateTag(s));
  await clickSelector(s, '#q-consent_tag_saved input');
  await clickNext(s);
  await waitForPage(s, 'demographics');
  return generated;
}

async function fillDemographics(s, pick = (options) => options[0].id) {
  for (const block of questionsOn('demographics')) {
    if (block.type === 'singleChoice') {
      const choice = pick(block.options);
      await chooseOption(s, block.id, choice);
      if (block.options.find((o) => o.id === choice)?.allowText) {
        await typeInto(s, `#q-${block.id} .opt__extra input`, `other ${block.id}`);
      }
    } else if (block.type === 'shortText' || block.type === 'longText') {
      await typeInto(s, `#input-${block.id}`, `text ${block.id}`);
    }
  }
}

/**
 * Fill every free-text block the survey currently marks required. Driving this
 * from the JSON rather than a fixed list keeps the suite working when a
 * previously optional question is made mandatory.
 */
async function fillRequiredTexts(s, pageId, text = 'A test response.') {
  for (const block of questionsOn(pageId)) {
    if (!blockRequiresAnswer(block)) continue;
    if (block.type !== 'shortText' && block.type !== 'longText') continue;
    await typeInto(s, `#input-${block.id}`, text);
  }
}

const QUESTION_BLOCK_TYPES = new Set(['shortText', 'longText', 'singleChoice', 'multiChoice', 'branchScale', 'scenarioPair']);

/**
 * Every rendered question must carry the marker the gating logic implies —
 * `blockRequiresAnswer`, the same predicate the renderer uses. This is the guard
 * that keeps the label honest when a question's required flag changes.
 */
async function checkRequiredMarkers(s, pageId) {
  const expected = (PAGE[pageId].blocks || [])
    .filter((block) => block.id && QUESTION_BLOCK_TYPES.has(block.type))
    .map((block) => ({ id: block.id, required: blockRequiresAnswer(block) }));

  const actual = await s.eval(`(()=>[...document.querySelectorAll('.q[data-block]')].map((node)=>({
    id: node.dataset.block,
    required: node.dataset.required === 'true',
    marker: Boolean(node.querySelector('.q__required')),
    optionalMarker: Boolean(node.querySelector('.q__optional')),
    aria: Boolean(node.querySelector('[aria-required="true"]')),
  })))()`);

  const problems = [];
  for (const expect of expected) {
    const found = actual.find((item) => item.id === expect.id);
    if (!found) {
      problems.push(`${expect.id}: not rendered`);
      continue;
    }
    if (found.required !== expect.required) problems.push(`${expect.id}: data-required is ${found.required}`);
    if (found.marker !== expect.required) problems.push(`${expect.id}: required marker ${found.marker}`);
    if (found.optionalMarker === expect.required) problems.push(`${expect.id}: optional marker ${found.optionalMarker}`);
    if (expect.required && !found.aria) problems.push(`${expect.id}: no aria-required`);
  }

  record(
    problems.length === 0,
    `${pageId}: all ${expected.length} questions are marked required or optional correctly`,
    problems.slice(0, 3).join(' | ')
  );
}

async function fillFactors(s) {
  await chooseOption(s, 'q_factors_sufficient', 'agree');
  await chooseExtent(s, 'q_factors_sufficient', 'somewhat');
  await chooseOption(s, 'q_aural_only', 'agree');
  await chooseExtent(s, 'q_aural_only', 'slightly');
  await fillRequiredTexts(s, 'factors', 'A test response.');
}

async function fillScenarios(s, choice = 'a') {
  for (const block of (PAGE.scenarios.blocks || []).filter((b) => b.type === 'scenarioPair')) {
    await chooseOption(s, block.id, choice);
    if (choice !== 'neutral') await chooseExtent(s, block.id, 'somewhat');
  }
}

/** Fill pages until the requested one is showing. */
async function advanceTo(s, pageId) {
  for (let guard = 0; guard < 8; guard += 1) {
    const page = await currentPage(s);
    if (page === pageId) return;
    if (page === 'demographics') await fillDemographics(s);
    else if (page === 'factors') await fillFactors(s);
    else if (page === 'scenarios') await fillScenarios(s);
    else if (page === 'closing') await typeInto(s, '#input-q_closing', 'advancing');
    await clickNext(s);
    await sleep(350);
  }
  await waitForPage(s, pageId);
}

/* ======================================================================== */
/* Tier 1 — field sweeps                                                     */
/* ======================================================================== */

async function sweepLanguage(lang) {
  setScope(`sweep/${lang}`);
  const s = await Session.open();
  const problems = [];

  try {
    await openR1(s, lang);

    /* --- page 1: consent gate ------------------------------------------ */
    isTrue(await nextDisabled(s), 'page 1: Continue is blocked before consent');
    await clickSelector(s, '#q-consent_start input');
    check((await answers(s)).consent_start === true, 'page 1: consent stored as true');
    check((await nextDisabled(s)) === false, 'page 1: Continue enabled once consent is given');
    await clickNext(s);
    await waitForPage(s, 'tag');

    /* --- page 2: tag generation ---------------------------------------- */
    const tag = await generateTag(s);
    TAGS.push({ tag, lang });
    check(/^[A-Z0-9]{8}$/.test(tag), 'page 2: tag is 8 characters of A-Z/0-9', tag);
    isTrue(await nextDisabled(s), 'page 2: Continue blocked until tag consent');
    await clickSelector(s, '#q-consent_tag_saved input');
    check((await nextDisabled(s)) === false, 'page 2: Continue enabled after tag consent');
    await clickNext(s);
    await waitForPage(s, 'demographics');
    await checkRequiredMarkers(s, 'demographics');

    /* --- page 3: demographics ------------------------------------------ */

    // A blocked Continue must reveal the first unanswered question rather than
    // sit there doing nothing.
    check((await nextDisabled(s)) === true, 'page 3: Continue is blocked while questions are unanswered');
    await clickNext(s);
    const jumped = await s.eval(`(()=>{
      const first = document.querySelector('[id^="q-"].is-invalid');
      if (!first) return null;
      return {
        block: first.dataset.block || first.id,
        error: (first.querySelector('.q__error-text') || {}).textContent || '',
        focused: first.contains(document.activeElement),
        page: window.__maelstrom.snapshot().pageId,
      };
    })()`);
    check(jumped?.block === 'q_language', 'page 3: a blocked Continue jumps to the first unanswered question', JSON.stringify(jumped));
    check(Boolean(jumped?.error), 'page 3: the jumped-to question shows its error message');
    check(jumped?.focused === true, 'page 3: focus lands inside that question');
    check(jumped?.page === 'demographics', 'page 3: a blocked Continue does not navigate');
    for (const block of questionsOn('demographics')) {
      if (block.type === 'singleChoice') {
        for (const option of block.options) {
          await chooseOption(s, block.id, option.id);
          const value = (await answers(s))[block.id];
          if (value !== option.id) problems.push(`${block.id}/${option.id} -> ${value}`);
          if (option.allowText) {
            const visible = await extraVisible(s, block.id);
            if (!visible) problems.push(`${block.id}/${option.id}: text field not visible`);
            const blocked = await nextDisabled(s);
            if (!blocked) problems.push(`${block.id}/${option.id}: Continue not blocked while empty`);
            await typeInto(s, `#q-${block.id} .opt__extra input`, `free text ${option.id}`);
            const other = (await answers(s))[`${block.id}__other`];
            if (other !== `free text ${option.id}`) problems.push(`${block.id}/${option.id}: other text not stored`);
          } else {
            const other = (await answers(s))[`${block.id}__other`];
            if (other !== undefined) problems.push(`${block.id}/${option.id}: stale other text kept`);
          }
        }
      }
      if (block.type === 'shortText' || block.type === 'longText') {
        await typeInto(s, `#input-${block.id}`, `answer for ${block.id}`);
        if ((await answers(s))[block.id] !== `answer for ${block.id}`) problems.push(`${block.id}: text not stored`);
        await typeInto(s, `#input-${block.id}`, '');
        if ((await answers(s))[block.id] !== undefined) problems.push(`${block.id}: cleared text still stored`);
        await typeInto(s, `#input-${block.id}`, `answer for ${block.id}`);
      }
    }

    // Clearing a required text answer must re-block the page. (Radios cannot be
    // unticked by clicking, so a text field is the honest way to test this.)
    await typeInto(s, '#input-q_language', '');
    check((await nextDisabled(s)) === true, 'page 3: clearing a required answer blocks Continue');
    await typeInto(s, '#input-q_language', 'restored');
    check((await nextDisabled(s)) === false, 'page 3: re-answering unblocks Continue');
    const stillInvalid = await s.eval(
      `[...document.querySelectorAll('[id^="q-"].is-invalid')].map((node) => node.id)`
    );
    check(stillInvalid.length === 0, 'page 3: answering a question clears its error marker', stillInvalid.join(', '));

    await clickNext(s);
    await waitForPage(s, 'factors');
    await checkRequiredMarkers(s, 'factors');

    /* --- page 4: factor subsets (all 512) ------------------------------ */
    const factorBlock = blockById.q_factors;
    const factorIds = factorBlock.options.map((o) => o.id);
    let subsetMismatches = 0;
    let previous = 0;
    for (let n = 1; n < 1 << factorIds.length; n += 1) {
      const gray = n ^ (n >> 1);
      const diff = gray ^ previous;
      const bit = Math.round(Math.log2(diff));
      const wanted = Boolean(gray & (1 << bit));
      await s.eval(`(()=>{const q=document.querySelector('#q-q_factors');const i=[...q.querySelectorAll('input')].find(x=>x.value===${JSON.stringify(factorIds[bit])});if(i&&i.checked!==${wanted})i.click();return 'ok';})()`);
      previous = gray;
      const stored = (await answers(s)).q_factors || [];
      const expected = factorIds.filter((_, index) => gray & (1 << index));
      if (JSON.stringify(stored) !== JSON.stringify(expected)) {
        subsetMismatches += 1;
        if (subsetMismatches <= 3) problems.push(`factors subset ${gray.toString(2)}: ${JSON.stringify(stored)}`);
      }
    }
    check(subsetMismatches === 0, `page 4: all 511 factor subsets stored exactly`, `${subsetMismatches} mismatch(es)`);

    // Optional question: with nothing ticked the page must still advance once
    // the required statements are answered.
    await s.eval("(()=>{document.querySelectorAll('#q-q_factors input:checked').forEach(i=>i.click());return 'cleared';})()");
    check((await answers(s)).q_factors === undefined, 'page 4: empty selection stores nothing');

    for (const blockId of ['q_factors_sufficient', 'q_aural_only']) {
      const block = blockById[blockId];
      for (const option of block.options) {
        await chooseOption(s, blockId, option.id);
        if ((await answers(s))[blockId] !== option.id) problems.push(`${blockId}/${option.id} not stored`);
        const needsExtent = block.followUp.when.includes(option.id);
        const blocked = await nextDisabled(s);
        if (needsExtent && !blocked) problems.push(`${blockId}/${option.id}: extent not enforced`);
        if (needsExtent) {
          for (const extent of block.followUp.options) {
            await chooseExtent(s, blockId, extent.id);
            if ((await answers(s))[`${blockId}__extent`] !== extent.id) {
              problems.push(`${blockId}/${option.id}/${extent.id}: extent not stored`);
            }
          }
        }
        await chooseOption(s, blockId, 'neutral');
        if ((await answers(s))[`${blockId}__extent`] !== undefined) problems.push(`${blockId}: neutral kept a stale extent`);
      }
      await chooseOption(s, blockId, 'agree');
      await chooseExtent(s, blockId, 'somewhat');
    }

    // The page also has free-text questions the survey marks required; leaving
    // them empty keeps Continue disabled and the page never advances.
    check((await nextDisabled(s)) === true, 'page 4: the required free-text questions block Continue');
    await fillRequiredTexts(s, 'factors', 'A test response.');
    check((await nextDisabled(s)) === false, 'page 4: answering them unblocks Continue');

    await clickNext(s);
    await waitForPage(s, 'scenarios');
    await checkRequiredMarkers(s, 'scenarios');

    /* --- page 5: scenario states (12 pairs x 7 states) ------------------ */
    const scenarioIds = (PAGE.scenarios.blocks || []).filter((b) => b.type === 'scenarioPair').map((b) => b.id);
    let scenarioChecks = 0;
    let scenarioProblems = 0;
    for (const id of scenarioIds) {
      const block = blockById[id];
      // Compare against the text for the language under test, and drop the
      // screen-reader prefix by measuring it rather than pattern-matching it.
      const expectedTexts = { a: block.a[lang] || block.a.en, b: block.b[lang] || block.b.en };
      const order = await s.eval(`(()=>{
        const expect=${JSON.stringify(expectedTexts)};
        const q=document.querySelector('#q-${id}');
        const cards=[...q.querySelectorAll('.scenario__card')];
        const texts=cards.map((c)=>{
          const p=c.querySelector('.scenario__text');
          const hidden=p.querySelector('.visually-hidden');
          const full=p.textContent;
          return (hidden ? full.slice(hidden.textContent.length) : full).trim();
        });
        const tags=cards.map((c)=>c.querySelector('.scenario__tag').textContent.trim());
        const opts=[...q.querySelectorAll('.opt-list[role=radiogroup] .opt')].map((o)=>({label:o.querySelector('.opt__label').textContent.trim(),value:o.querySelector('input').value}));
        return {tags,texts,opts,expect};
      })()`);
      const leftIsA = order.texts[0] === order.expect.a;
      const leftIsB = order.texts[0] === order.expect.b;
      const leftContent = leftIsA ? 'a' : leftIsB ? 'b' : null;
      if (!leftContent) {
        scenarioProblems += 1;
        problems.push(`${id}: card text does not match either scenario`);
        continue;
      }
      scenarioChecks += 1;
      if (order.tags[0] !== 'A' || order.tags[1] !== 'B') {
        scenarioProblems += 1;
        problems.push(`${id}: letters not positional (${order.tags.join('')})`);
      }
      if (order.opts[0].value !== leftContent) {
        scenarioProblems += 1;
        problems.push(`${id}: A option does not map to the card shown as A`);
      }
      if (order.opts[2].value !== (leftContent === 'a' ? 'b' : 'a')) {
        scenarioProblems += 1;
        problems.push(`${id}: B option does not map to the card shown as B`);
      }

      for (const value of ['a', 'neutral', 'b']) {
        await chooseOption(s, id, value);
        if ((await answers(s))[id] !== value) {
          scenarioProblems += 1;
          problems.push(`${id}: choosing ${value} stored ${JSON.stringify((await answers(s))[id])}`);
        }
        if (value === 'neutral') {
          if ((await answers(s))[`${id}__extent`] !== undefined) {
            scenarioProblems += 1;
            problems.push(`${id}: neutral kept an extent`);
          }
        } else {
          for (const extent of ['slightly', 'somewhat', 'strongly']) {
            await chooseExtent(s, id, extent);
            if ((await answers(s))[`${id}__extent`] !== extent) {
              scenarioProblems += 1;
              problems.push(`${id}/${value}/${extent}: extent not stored`);
            }
          }
        }
      }
      await chooseOption(s, id, 'a');
      await chooseExtent(s, id, 'strongly');
    }
    check(scenarioProblems === 0, `page 5: ${scenarioIds.length} pairs x 7 states stored with correct letter mapping`, `${scenarioProblems} problem(s)`);
    void scenarioChecks;

    await clickNext(s);
    await waitForPage(s, 'closing');
    await checkRequiredMarkers(s, 'closing');

    /* --- page 6: free text, empty and filled --------------------------- */
    await typeInto(s, '#input-q_closing', '');
    check((await nextButton(s))?.disabled === false, 'page 6: submit allowed with empty closing text');
    await typeInto(s, '#input-q_closing', 'closing remarks');
    check((await answers(s)).q_closing === 'closing remarks', 'page 6: closing text stored');
    await typeInto(s, '#input-q_closing', '');

    // Language switch mid-survey (also covered in the extra tier).
    const before = await answers(s);
    await s.eval("(()=>{const sel=document.querySelector('#lang-slot select');sel.value='fr';sel.dispatchEvent(new Event('change',{bubbles:true}));return 'fr';})()");
    await sleep(1200);
    same(await answers(s), before, 'language switch preserves every answer');
    await s.eval("(()=>{const sel=document.querySelector('#lang-slot select');sel.value='en';sel.dispatchEvent(new Event('change',{bubbles:true}));return 'en';})()");
    await sleep(900);

    if (problems.length) {
      problems.slice(0, 12).forEach((p) => record(false, 'sweep detail', p));
      record(false, `sweep found ${problems.length} problem(s)`, problems.slice(0, 3).join(' | '));
    } else {
      ok('no sweep problems');
    }

    check(s.exceptions.length === 0, 'no uncaught exceptions during the sweep', s.exceptions[0]);
    check(s.consoleErrors.filter((e) => !/favicon/i.test(e)).length === 0, 'no console errors during the sweep', s.consoleErrors[0]);
  } catch (error) {
    record(false, `sweep crashed: ${error.message}`);
    await s.screenshot(path.join(REPORT_DIR, `sweep-${lang}-crash.png`)).catch(() => {});
  } finally {
    await s.close();
  }
}

/* ======================================================================== */
/* Tier 2 — end-to-end runs                                                  */
/* ======================================================================== */

const E2E_PROFILES = [
  {
    // Required text fields must still be answered, but every *optional*
    // free-response box is left empty — that is the "no response" case.
    name: 'first options, optional free text left empty',
    pick: (options) => options[0].id,
    text: (block) => (blockRequiresAnswer(block) ? `required ${block.id}` : ''),
    pickExtent: (options) => options[0].id,
  },
  {
    name: 'last options with Other text, all free text filled',
    pick: (options) => options[options.length - 1].id,
    text: (block) => `text for ${block.id}`,
    pickExtent: (options) => options[options.length - 1].id,
  },
];

async function e2eRun(lang, profile) {
  setScope(`e2e/${lang}/${profile.name}`);
  const s = await Session.open();
  const expected = {};

  try {
    await openR1(s, lang);
    await clickSelector(s, '#q-consent_start input');
    expected.consent_start = true;
    await clickNext(s);
    await waitForPage(s, 'tag');

    const tag = await generateTag(s);
    TAGS.push({ tag, lang });
    expected.consent_tag_saved = true;
    await clickSelector(s, '#q-consent_tag_saved input');
    await clickNext(s);
    await waitForPage(s, 'demographics');

    for (const block of questionsOn('demographics')) {
      if (block.type === 'singleChoice') {
        const choice = profile.pick(block.options);
        await chooseOption(s, block.id, choice);
        expected[block.id] = choice;
        const option = block.options.find((o) => o.id === choice);
        if (option.allowText) {
          const text = `other ${block.id}`;
          await typeInto(s, `#q-${block.id} .opt__extra input`, text);
          expected[`${block.id}__other`] = text;
        }
      } else if (block.type === 'shortText' || block.type === 'longText') {
        const text = profile.text(block);
        if (text) {
          await typeInto(s, `#input-${block.id}`, text);
          expected[block.id] = text;
        }
      }
    }

    check((await nextDisabled(s)) === false, 'demographics complete unlocks Continue');
    await clickNext(s);
    await waitForPage(s, 'factors');

    // Leave the optional factor question untouched in one run to prove it is optional.
    if (profile.name.startsWith('last')) {
      const subset = ['vocal', 'melody', 'mixing'];
      for (const id of subset) await chooseOption(s, 'q_factors', id);
      expected.q_factors = subset;
    }
    for (const blockId of ['q_factors_sufficient', 'q_aural_only']) {
      const block = blockById[blockId];
      const choice = profile.pick(block.options);
      await chooseOption(s, blockId, choice);
      expected[blockId] = choice;
      if (block.followUp.when.includes(choice)) {
        const extent = profile.pickExtent(block.followUp.options);
        await chooseExtent(s, blockId, extent);
        expected[`${blockId}__extent`] = extent;
      }
    }

    // Free-text questions on this page the survey marks required.
    for (const block of questionsOn('factors')) {
      if (!blockRequiresAnswer(block)) continue;
      if (block.type !== 'shortText' && block.type !== 'longText') continue;
      const text = profile.text(block) || 'A test response.';
      await typeInto(s, `#input-${block.id}`, text);
      expected[block.id] = text;
    }
    await clickNext(s);
    await waitForPage(s, 'scenarios');

    for (const block of (PAGE.scenarios.blocks || []).filter((b) => b.type === 'scenarioPair')) {
      const choice = profile.pick([
        { id: 'a' },
        { id: 'neutral' },
        { id: 'b' },
      ]);
      await chooseOption(s, block.id, choice);
      expected[block.id] = choice;
      if (choice !== 'neutral') {
        const extent = profile.pickExtent([{ id: 'slightly' }, { id: 'somewhat' }, { id: 'strongly' }]);
        await chooseExtent(s, block.id, extent);
        expected[`${block.id}__extent`] = extent;
      }
    }
    await clickNext(s);
    await waitForPage(s, 'closing');

    if (profile.name.startsWith('last')) {
      const text = 'closing remarks';
      await typeInto(s, '#input-q_closing', text);
      expected.q_closing = text;
    }

    const beforeSubmit = await answers(s);
    same(beforeSubmit, expected, 'sweep: in-page answers equal what was entered');

    await clickNext(s);
    await waitForPage(s, 'done');
    check((await snapshot(s)).final === true, 'submit locks the response');
    check(await s.eval("document.querySelector('#nav').hidden === true"), 'action bar hidden on the thank-you page');
    const shownTag = await s.eval("document.querySelector('.tag-card__value').textContent.trim()");
    same(shownTag, tag, 'thank-you page shows the same tag');

    const stored = await waitForServer(SURVEY_R1, tag, (r) => r.final === true, 20000);
    check(Boolean(stored), 'server received the final record');
    if (stored) {
      same(stored.answers, expected, 'server record matches the entered answers');
      same(stored.tag, tag, 'server record carries the right tag');
      // The final save is issued from the submit page before the thank-you page
      // renders, so either page id is correct for a final record.
      check(['closing', 'done'].includes(stored.pageId), 'server record marks the response final', stored.pageId);
    }

    /* --- Round 2: prefill, revision, Round 1 immutability -------------- */
    const round1Snapshot = mock.get(SURVEY_R1, tag);
    await s.goto(surveyUrl(SURVEY_R2, lang), 2600);
    await s.waitFor("Boolean(document.querySelector('#q-tag_lookup'))", { label: 'round 2 lookup' });
    await typeInto(s, '#q-tag_lookup input', tag);
    await s.eval("document.querySelector('#q-tag_lookup form').requestSubmit()");

    // The report-read checkpoint sits between the tag lookup and the welcome page.
    await s.waitFor("window.__maelstrom && window.__maelstrom.snapshot().pageId === 'report_read'", {
      timeout: 12000,
      label: 'round 2 report checkpoint',
    });
    same(await answers(s), expected, 'round 2 loads the round 1 answers before the checkpoint');

    const banner = await s.eval(`(()=>{
      const node=document.querySelector('.link-banner');
      if(!node) return null;
      return {
        tag: node.tagName,
        href: node.getAttribute('href'),
        target: node.getAttribute('target'),
        rel: node.getAttribute('rel'),
        unavailable: node.classList.contains('is-unavailable'),
      };
    })()`);
    check(Boolean(banner), 'round 2: the report banner is rendered');
    if (banner && banner.href) {
      check(banner.target === '_blank', 'round 2: the report opens in a new tab', banner.target);
      check(/noopener/.test(banner.rel || ''), 'round 2: the new tab gets no opener', banner.rel);
    } else {
      // The report is uploaded after the round closes; until then the banner
      // must be inert rather than a dead link.
      check(Boolean(banner && banner.unavailable), 'round 2: an unpublished report gives an inert banner');
    }

    // The checkpoint itself only asks for confirmation; the two questions about
    // the report live on the page after it.
    const onCheckpoint = await s.eval(
      `(()=>['q_report_valid','q_report_invalid'].map((id)=>Boolean(document.getElementById('q-'+id))))()`
    );
    check(onCheckpoint.every((present) => !present), 'round 2: the confirmation page does not carry the viewpoint questions');

    check((await nextDisabled(s)) === true, 'round 2: the report checkbox blocks Continue');
    await clickSelector(s, '#q-consent_report_read input');
    check((await nextDisabled(s)) === false, 'round 2: confirming the report unblocks Continue');
    await clickNext(s);

    await waitForPage(s, 'welcome', 12000);
    const prefilled = await answers(s);
    same(prefilled, { ...expected, consent_report_read: true }, 'round 2 pre-fills the round 1 answers');

    const reportQuestions = await s.eval(`(()=>(['q_report_valid','q_report_invalid']).map((id)=>{
      const node=document.getElementById('q-'+id);
      return node ? { id, required: node.dataset.required === 'true', optional: Boolean(node.querySelector('.q__optional')) } : null;
    }))()`);
    check(reportQuestions.filter(Boolean).length === 2, 'round 2: the page after the confirmation asks about valid and invalid viewpoints');
    check(
      reportQuestions.every((question) => question && question.required === false && question.optional),
      'round 2: those two questions are optional',
      JSON.stringify(reportQuestions)
    );

    const reportComment = 'The point about live performance.';
    await typeInto(s, '#input-q_report_valid', reportComment);
    check((await answers(s)).q_report_valid === reportComment, 'round 2: a report comment is stored');
    check((await nextDisabled(s)) === false, 'round 2: the optional report questions do not block Continue');

    await clickNext(s); // welcome -> demographics
    await waitForPage(s, 'demographics');

    // Change exactly one answer, then submit unchanged otherwise.
    const changed = await s.eval(`(()=>{
      const q=document.querySelector('#q-q_age');
      const inputs=[...q.querySelectorAll('input')];
      const target=inputs[inputs.length-1];
      target.click();
      return target.value;
    })()`);
    const revised = { ...expected, q_age: changed, consent_report_read: true, q_report_valid: reportComment };

    await clickNext(s); // demographics -> factors
    await waitForPage(s, 'factors');
    await clickNext(s);
    await waitForPage(s, 'scenarios');
    await clickNext(s);
    await waitForPage(s, 'closing');
    await clickNext(s);
    await waitForPage(s, 'done');

    const round2Record = await waitForServer(SURVEY_R2, tag, (r) => r.final === true, 20000);
    check(Boolean(round2Record), 'round 2 final record stored');
    if (round2Record) same(round2Record.answers, revised, 'round 2 record holds the revised answers');

    const round1After = mock.get(SURVEY_R1, tag);
    same(round1After.answers, round1Snapshot.answers, 'round 1 answers untouched by the revision');
    same(round1After.final, true, 'round 1 still marked final');

    check(s.exceptions.length === 0, 'no uncaught exceptions during the run', s.exceptions[0]);
  } catch (error) {
    record(false, `e2e crashed: ${error.message}`);
    await s.screenshot(path.join(REPORT_DIR, `e2e-${lang}-crash.png`)).catch(() => {});
  } finally {
    await s.close();
  }
}

/* ======================================================================== */
/* Tier 3 — stop and recover                                                 */
/* ======================================================================== */

async function recoveryLanguage(lang) {
  setScope(`recovery/${lang}`);

  // Stop after each page, then recover in a genuinely fresh browser (a new
  // device), which is the only way to exercise the server copy rather than the
  // local draft — clearing localStorage in place would be undone by the
  // pagehide handler that saves the draft.
  const boundaries = ['tag', 'demographics', 'factors', 'scenarios', 'closing'];

  for (const boundary of boundaries) {
    const s = await Session.open();
    let tag = null;
    let captured = null;
    try {
      await openR1(s, lang);
      await clickSelector(s, '#q-consent_start input');
      await clickNext(s);
      await waitForPage(s, 'tag');
      tag = await generateTag(s);
      TAGS.push({ tag, lang });

      if (boundary !== 'tag') {
        await clickSelector(s, '#q-consent_tag_saved input');
        await clickNext(s);
        await waitForPage(s, 'demographics');

        if (boundary !== 'demographics') {
          await fillDemographics(s);
          await clickNext(s);
          await waitForPage(s, 'factors');

          if (boundary !== 'factors') {
            await fillFactors(s);
            await clickNext(s);
            await waitForPage(s, 'scenarios');

            if (boundary !== 'scenarios') {
              await fillScenarios(s, 'b');
              await clickNext(s);
              await waitForPage(s, 'closing');
              await typeInto(s, '#input-q_closing', 'before recovering');
            }
          }
        }
      }

      captured = await snapshot(s);
      check(captured.pageId === boundary, `stop at ${boundary}: stopped on the intended page`, captured.pageId);

      const serverRecord = await waitForServer(
        SURVEY_R1,
        tag,
        (r) => r.pageId === captured.pageId,
        20000
      );
      check(Boolean(serverRecord), `stop at ${boundary}: the answer reached the server before leaving`);
      if (serverRecord) same(serverRecord.answers, captured.answers, `stop at ${boundary}: server copy matches`);
    } catch (error) {
      record(false, `recovery at ${boundary} crashed while answering: ${error.message}`);
      await s.screenshot(path.join(REPORT_DIR, `recovery-${lang}-${boundary}.png`)).catch(() => {});
      await s.close();
      continue;
    }
    await s.close();

    // New browser, no local state at all.
    const r = await Session.open();
    try {
      await r.goto(url('/index.html'), 3200);
      await r.waitFor("Boolean(document.querySelector('#resume-input'))");
      await typeInto(r, '#resume-input', tag);
      await r.eval("document.querySelector('#resume-form').requestSubmit()");
      await r.waitFor("location.pathname.endsWith('survey.html')", { timeout: 20000, label: 'resume redirect' });
      await r.waitFor('Boolean(window.__maelstrom)', { timeout: 20000, label: 'runner boot after resume' });

      const restored = await snapshot(r);
      same(restored.tag, tag, `stop at ${boundary}: recovered under the same tag`);
      same(restored.answers, captured.answers, `stop at ${boundary}: answers restored exactly`);
      same(restored.pageId, captured.pageId, `stop at ${boundary}: returned to the same page`);
      same(restored.presentation, captured.presentation, `stop at ${boundary}: question order preserved`);
    } catch (error) {
      record(false, `recovery at ${boundary} crashed while recovering: ${error.message}`);
      await r.screenshot(path.join(REPORT_DIR, `recovery-${lang}-${boundary}.png`)).catch(() => {});
    } finally {
      await r.close();
    }
  }
}

/* ======================================================================== */
/* Tier 4 — other failure points                                             */
/* ======================================================================== */

async function extraLanguage(lang) {
  setScope(`extra/${lang}`);

  /* --- randomisation determinism -------------------------------------- */
  {
    const s = await Session.open();
    try {
      await openR1(s, lang);
      await passIntro(s);
      await advanceTo(s, 'scenarios');

      const orderA = await s.eval("window.__maelstrom.snapshot().presentation.scenarios.order.join(',')");
      await s.reload(3000);
      await s.waitFor('Boolean(window.__maelstrom)');
      const pageNow = await currentPage(s);
      check(pageNow === 'scenarios', 'reload returns to the page the participant was on', pageNow);
      const orderB = await s.eval("window.__maelstrom.snapshot().presentation.scenarios.order.join(',')");
      same(orderB, orderA, 'same tag keeps the same scenario order across reloads');

      const tag = (await snapshot(s)).tag;
      const other = await Session.open();
      try {
        await openR1(other, lang);
        const tag2 = await passIntro(other);
        check(tag2 !== tag, 'a second participant gets a different tag');
        const orderC = await other.eval("window.__maelstrom.snapshot().presentation.scenarios.order.join(',')");
        check(orderC !== orderA, 'different tags get different scenario orders');
      } finally {
        await other.close();
      }
    } catch (error) {
      record(false, `determinism crashed: ${error.message}`);
    } finally {
      await s.close();
    }
  }

  /* --- server outage --------------------------------------------------- */
  {
    const s = await Session.open();
    try {
      await openR1(s, lang);
      await s.waitFor('Boolean(window.__maelstrom)');
      await passIntro(s);
      // Wait until the first page is safely on the server.
      const tag = (await snapshot(s)).tag;
      await waitForServer(SURVEY_R1, tag, () => true, 12000);

      await fetch(`${mock.url()}/__offline?on=1`);
      await chooseOption(s, 'q_age', '26_30');
      let state = null;
      for (let i = 0; i < 60; i += 1) {
        state = await s.eval("document.querySelector('#save-state').dataset.state");
        if (state === 'error') break;
        await sleep(300);
      }
      check(state === 'error', 'server down: UI reports the save did not reach the server', state);
      check((await answers(s)).q_age === '26_30', 'server down: answer still kept locally');

      await fetch(`${mock.url()}/__offline?on=0`);
      await chooseOption(s, 'q_age', '31_40');
      const recovered = await waitForServer(SURVEY_R1, tag, (r) => r.answers?.q_age === '31_40', 25000);
      check(Boolean(recovered), 'server back: the next save syncs the full record');
      const savedState = await s.eval("document.querySelector('#save-state').dataset.state");
      check(savedState === 'saved', 'server back: the save indicator returns to saved', savedState);
    } catch (error) {
      record(false, `offline test crashed: ${error.message}`);
    } finally {
      await fetch(`${mock.url()}/__offline?on=0`).catch(() => {});
      await s.close();
    }
  }

  /* --- keyboard only + accessibility labels ---------------------------- */
  {
    const s = await Session.open();
    try {
      await openR1(s, lang);
      await sleep(400);
      // Tab from the top of the document until the consent checkbox has focus.
      let reached = false;
      for (let i = 0; i < 30 && !reached; i += 1) {
        await s.press('Tab');
        reached = await s.eval("document.activeElement === document.querySelector('#q-consent_start input')");
      }
      check(reached, 'keyboard: consent checkbox is reachable with Tab');
      await s.press('Space');
      check((await answers(s)).consent_start === true, 'keyboard: Space ticks the consent box');
      let onNext = false;
      for (let i = 0; i < 12 && !onNext; i += 1) {
        await s.press('Tab');
        onNext = await s.eval("document.activeElement === document.querySelector('.nav-bar__actions .btn:last-child')");
      }
      check(onNext, 'keyboard: Continue is reachable with Tab');
      await s.press('Enter');
      await waitForPage(s, 'tag');
      ok('keyboard: Enter advances to the next page');

      // Move to the question-heavy page so the audit covers real controls.
      const tag = await generateTag(s);
      TAGS.push({ tag, lang });
      await clickSelector(s, '#q-consent_tag_saved input');
      await clickNext(s);
      await waitForPage(s, 'demographics');

      const labelReport = await s.eval(`(()=>{
        const groups=[...document.querySelectorAll('.opt-list[role=radiogroup], .opt-list[role=group]')];
        const unnamed=groups.filter((g)=>{
          const id=g.getAttribute('aria-labelledby');
          const el=id && document.getElementById(id);
          return !el || !el.textContent.trim();
        }).length;
        const inputs=[...document.querySelectorAll('input.input[aria-labelledby], textarea[aria-labelledby], input[type=text][aria-labelledby]')];
        const unlabelled=inputs.filter((i)=>{
          const el=document.getElementById(i.getAttribute('aria-labelledby'));
          return !el || !el.textContent.trim();
        }).length;
        return {groups:groups.length,unnamed,inputs:inputs.length,unlabelled};
      })()`);
      check(labelReport.groups > 0, 'a11y: radio groups exist to check', JSON.stringify(labelReport));
      check(labelReport.unnamed === 0, 'a11y: every radio/checkbox group has an accessible name', JSON.stringify(labelReport));
      check(labelReport.inputs > 0, 'a11y: text inputs exist to check', JSON.stringify(labelReport));
      check(labelReport.unlabelled === 0, 'a11y: every text control has an accessible name', JSON.stringify(labelReport));
    } catch (error) {
      record(false, `keyboard/a11y crashed: ${error.message}`);
    } finally {
      await s.close();
    }
  }

  /* --- mobile layout ---------------------------------------------------- */
  {
    const s = await Session.open({ viewport: { width: 390, height: 844 } });
    const measure = () =>
      s.eval(`(()=>{
        const doc=document.documentElement;
        const heights=[...document.querySelectorAll('.opt, .btn, .nav-bar__actions .btn')]
          .map((el)=>el.getBoundingClientRect().height).filter((h)=>h>0);
        return {overflow: doc.scrollWidth - window.innerWidth, minTarget: heights.length?Math.min(...heights):0, page: document.querySelector('#page-title')?.textContent};
      })()`);
    try {
      await openR1(s, lang);
      let metrics = await measure();
      check(metrics.overflow <= 1, 'mobile (intro): no horizontal overflow', `overflow ${metrics.overflow}px`);

      await passIntro(s);
      metrics = await measure();
      check(metrics.overflow <= 1, 'mobile (demographics): no horizontal overflow', `overflow ${metrics.overflow}px`);
      check(metrics.minTarget >= 32, 'mobile (demographics): tap targets large enough', `${metrics.minTarget.toFixed(1)}px`);

      await advanceTo(s, 'factors');
      metrics = await measure();
      check(metrics.overflow <= 1, 'mobile (factors): no horizontal overflow', `overflow ${metrics.overflow}px`);

      await advanceTo(s, 'scenarios');
      metrics = await measure();
      check(metrics.overflow <= 1, 'mobile (scenarios): no horizontal overflow', `overflow ${metrics.overflow}px`);
      check(metrics.minTarget >= 32, 'mobile (scenarios): tap targets large enough', `${metrics.minTarget.toFixed(1)}px`);
    } catch (error) {
      record(false, `mobile crashed: ${error.message}`);
    } finally {
      await s.close();
    }
  }
}

/* --- one tag in two browsers --------------------------------------------- */

async function concurrencyTest(lang) {
  setScope(`extra/${lang}/concurrency`);
  const a = await Session.open();
  const b = await Session.open();
  try {
    await openR1(a, lang);
    const tag = await passIntro(a);
    await waitForServer(SURVEY_R1, tag, () => true, 12000);

    await openR1(b, lang);
    await clickSelector(b, '#q-consent_start input');
    await clickNext(b);
    await waitForPage(b, 'tag');
    await typeInto(b, '.resume-inline input', tag);
    await b.eval("document.querySelector('.resume-inline form').requestSubmit()");
    await b.waitFor("window.__maelstrom && window.__maelstrom.snapshot().tag === " + JSON.stringify(tag), {
      timeout: 15000,
      label: 'second browser resumed the tag',
    });

    // Both write at once.
    await chooseOption(a, 'q_age', '26_30');
    await chooseOption(b, 'q_age', '41_64');
    await sleep(3000);

    const record = mock.get(SURVEY_R1, tag);
    check(Boolean(record), 'two browsers: a record still exists');
    check(['26_30', '41_64'].includes(record?.answers?.q_age), 'two browsers: last write wins coherently', record?.answers?.q_age);
    check(a.exceptions.length === 0 && b.exceptions.length === 0, 'two browsers: neither session threw');
  } catch (error) {
    record(false, `concurrency crashed: ${error.message}`);
  } finally {
    await a.close();
    await b.close();
  }
}

/* --- CSV export ----------------------------------------------------------- */

/** RFC4180-ish reader: handles quoted cells, embedded commas and newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r') {
      /* ignore */
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function csvExportTest() {
  setScope('extra/csv');
  try {
    const repo = path.join(REPORT_DIR, 'data-repo', 'data');
    await mkdir(path.join(repo, SURVEY_R1), { recursive: true });

    for (const record of mock.records.values()) {
      const dir = path.join(repo, record.surveyId);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${record.tag}.json`), JSON.stringify(record, null, 2), 'utf8');
    }

    // A fixture with one of every value shape, including characters that the
    // CSV writer has to quote, so the exporter is tested rather than the tier.
    const fixture = {
      surveyId: SURVEY_R1,
      tag: 'TESTFIX1',
      final: true,
      pageId: 'done',
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:10:00.000Z',
      submittedAt: '2026-01-01T00:10:00.000Z',
      answers: {
        q_gender: 'other',
        q_gender__other: 'comma, semicolon; and "quotes"',
        q_factors: ['vocal', 'melody', 'mixing'],
        s01: 'b',
        s01__extent: 'somewhat',
        s01__comment: 'multi\nline comment',
        q_language: 'English',
      },
      presentation: {},
      baseline: null,
      meta: { lang: 'en' },
    };
    await writeFile(path.join(repo, SURVEY_R1, `${fixture.tag}.json`), JSON.stringify(fixture, null, 2), 'utf8');

    const outDir = path.join(REPORT_DIR, 'csv');
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'tools/export-csv.mjs'), path.join(REPORT_DIR, 'data-repo'), '--out', outDir],
      { stdio: 'ignore' }
    );
    await new Promise((resolve) => child.on('exit', resolve));

    const csv = await readFile(path.join(outDir, `${SURVEY_R1}.csv`), 'utf8');
    const rows = parseCsv(csv);
    const header = rows[0];
    const round1 = [...mock.records.values()].filter((r) => r.surveyId === SURVEY_R1);

    check(rows.length > 1, 'csv: round 1 rows exported', `${rows.length - 1} rows`);
    check(round1.length > 0, 'csv: real records from the run were exported', `${round1.length} record(s)`);
    for (const column of ['tag', 'surveyId', 'final', 'q_gender', 'q_factors', 's01', 's01__comment']) {
      check(header.includes(column), `csv: column ${column} present`);
    }

    const row = rows.find((cells) => cells[0] === fixture.tag);
    check(Boolean(row), 'csv: the fixture row is present');
    if (row) {
      const valueFor = (key) => row[header.indexOf(key)];
      const asCell = (value) => (Array.isArray(value) ? value.join('; ') : String(value));

      let mismatches = 0;
      for (const [key, value] of Object.entries(fixture.answers)) {
        const actual = valueFor(key);
        if (header.indexOf(key) === -1 || actual !== asCell(value)) {
          mismatches += 1;
          if (mismatches <= 3) record(false, `csv: ${key} did not round-trip`, `${JSON.stringify(actual)} vs ${JSON.stringify(asCell(value))}`);
        }
      }
      check(mismatches === 0, 'csv: every value of the fixture round-trips exactly', `${mismatches} mismatch(es)`);
      check(valueFor('final') === 'yes', 'csv: final submissions are marked yes', valueFor('final'));
      check(valueFor('q_factors') === 'vocal; melody; mixing', 'csv: multi-select values joined with semicolons', valueFor('q_factors'));
    }

    const participants = await readFile(path.join(outDir, 'participants.csv'), 'utf8');
    check(participants.split(/\r?\n/).length > 1, 'csv: participants index exported');
  } catch (error) {
    record(false, `csv export crashed: ${error.message}`);
  }
}

/* ======================================================================== */
/* Main                                                                      */
/* ======================================================================== */

const started = Date.now();
const REPORT_DIR = await mkdtemp(path.join(os.tmpdir(), 'maelstrom-report-'));

console.log('\u001b[1mMAELStrOM survey test suite\u001b[0m');
console.log(`languages: ${LANGS.join(', ')}   tiers: ${TIERS.join(', ')}   chrome: ${findChrome()}`);

await mock.start();
const staticServer = await startStatic();
BASE = `http://127.0.0.1:${staticServer.port}`;
console.log(`site: ${BASE}   mock api: ${mock.url()}\n`);

try {
  for (const lang of LANGS) {
    if (TIERS.includes('sweep')) {
      head(`Sweep — ${lang}`);
      await sweepLanguage(lang);
    }
  }

  if (TIERS.includes('e2e')) {
    for (const lang of LANGS) {
      head(`End-to-end — ${lang}`);
      for (const profile of E2E_PROFILES) await e2eRun(lang, profile);
    }
  }

  if (TIERS.includes('recovery')) {
    for (const lang of LANGS) {
      head(`Stop and recover — ${lang}`);
      await recoveryLanguage(lang);
    }
  }

  if (TIERS.includes('extra')) {
    for (const lang of LANGS) {
      head(`Additional failure points — ${lang}`);
      await extraLanguage(lang);
      await concurrencyTest(lang);
    }
    head('CSV export');
    await csvExportTest();
  }
} finally {
  await staticServer.server.close();
  await mock.stop();
  if (KEEP) console.log(`\nreport directory kept: ${REPORT_DIR}`);
  else await rm(REPORT_DIR, { recursive: true, force: true }).catch(() => {});
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log('\n' + '\u2500'.repeat(70));
if (results.failures.length === 0) {
  console.log(`\u001b[32m\u2713 ${results.passes}/${results.checks} checks passed in ${seconds}s\u001b[0m`);
  console.log('\u001b[32mALL CHECKS PASSED\u001b[0m\n');
  process.exitCode = 0;
} else {
  console.log(`\u001b[31m\u2717 ${results.failures.length} of ${results.checks} checks failed in ${seconds}s\u001b[0m`);
  const byScope = new Map();
  for (const failure of results.failures) {
    if (!byScope.has(failure.scope)) byScope.set(failure.scope, []);
    byScope.get(failure.scope).push(failure);
  }
  for (const [group, items] of byScope) {
    console.log(`\n\u001b[1m${group}\u001b[0m`);
    for (const item of items.slice(0, 12)) {
      console.log(`  \u2717 ${item.message}${item.detail ? `  \u001b[2m${item.detail}\u001b[0m` : ''}`);
    }
    if (items.length > 12) console.log(`  \u001b[2m…and ${items.length - 12} more\u001b[0m`);
  }
  console.log('\n\u001b[31mTESTS FAILED\u001b[0m\n');
  process.exitCode = 1;
}
