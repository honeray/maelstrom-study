#!/usr/bin/env node
/**
 * Local text editor for the MAELStrOM site.
 *
 *   node tools/editor/server.mjs [--port 8090] [--open]
 *   npm run edit
 *
 * Why a server: a page published on GitHub Pages cannot write files. This one
 * binds to 127.0.0.1 only, serves the real site to an iframe, and rewrites the
 * JSON files in your working copy when you save. Nothing is committed or pushed
 * — review the diff and commit as usual.
 *
 * The preview is the actual survey code, and its response API is redirected to
 * a collector in this process, so drafting answers while you edit can never
 * reach the production KV store.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const APP_DIR = path.join(import.meta.dirname, 'app');

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const hit = argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PORT = Number(argValue('port', 8123));
const OPEN = argv.includes('--open');
let actualPort = PORT;

/* ========================================================================== */
/* JSON with character offsets                                                */
/* ========================================================================== */

const escapePointer = (key) => String(key).replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Map every leaf of a JSON document to the [start, end) span of its token in
 * the raw text. This is what lets an edit replace one string literal and leave
 * all surrounding formatting — including the one-line {en, zh, fr} objects —
 * exactly as it was.
 */
export function scanJson(text) {
  let i = 0;
  const leaves = new Map();

  const skip = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };

  const parseString = () => {
    const start = i;
    i += 1;
    while (i < text.length) {
      const char = text[i];
      if (char === '\\') {
        i += 2;
        continue;
      }
      i += 1;
      if (char === '"') return { start, end: i };
    }
    throw new Error('unterminated string');
  };

  const parseValue = (pointer) => {
    skip();
    const char = text[i];
    if (char === '{') {
      i += 1;
      parseObject(pointer);
    } else if (char === '[') {
      i += 1;
      parseArray(pointer);
    } else if (char === '"') {
      leaves.set(pointer, parseString());
    } else {
      const start = i;
      while (i < text.length && !/[,\]}:\s]/.test(text[i])) i += 1;
      leaves.set(pointer, { start, end: i });
    }
  };

  const parseObject = (pointer) => {
    skip();
    if (text[i] === '}') {
      i += 1;
      return;
    }
    for (;;) {
      skip();
      const keySpan = parseString();
      const key = JSON.parse(text.slice(keySpan.start, keySpan.end));
      skip();
      if (text[i] !== ':') throw new Error('expected colon');
      i += 1;
      parseValue(`${pointer}/${escapePointer(key)}`);
      skip();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '}') {
        i += 1;
        return;
      }
      throw new Error('expected , or }');
    }
  };

  const parseArray = (pointer) => {
    skip();
    if (text[i] === ']') {
      i += 1;
      return;
    }
    let index = 0;
    for (;;) {
      parseValue(`${pointer}/${index}`);
      index += 1;
      skip();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === ']') {
        i += 1;
        return;
      }
      throw new Error('expected , or ]');
    }
  };

  parseValue('');
  return leaves;
}

/** Replace exactly one string literal, preserving every other byte. */
export function spliceValue(text, pointer, value) {
  const leaves = scanJson(text);
  const span = leaves.get(pointer);
  if (!span) throw new Error(`No value at ${pointer}`);
  return text.slice(0, span.start) + JSON.stringify(value) + text.slice(span.end);
}

/* ========================================================================== */
/* Catalog                                                                    */
/* ========================================================================== */

const LANGS = ['en', 'zh', 'fr'];
const isLocalised = (value) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  LANGS.every((lang) => typeof value[lang] === 'string');

const FIELD_NAMES = {
  prompt: 'Question text',
  text: 'Body text',
  title: 'Title',
  eyebrow: 'Eyebrow',
  label: 'Label',
  sub: 'Sub-label',
  hint: 'Hint',
  placeholder: 'Placeholder',
  statement: 'Statement',
  note: 'Note',
  a: 'Scenario A',
  b: 'Scenario B',
  why: 'Rationale',
  confirm: 'Confirmation text',
  done: 'Completion text',
  submitLabel: 'Submit button',
  summary: 'Summary',
  description: 'Description',
};

function describeField(pointer, parentType) {
  const parts = pointer.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  const optionsAt = parts.lastIndexOf('options');
  if (optionsAt >= 0 && parts[optionsAt + 2]) {
    const index = Number(parts[optionsAt + 1]);
    const field = parts[optionsAt + 2];
    return `Option ${index + 1}${field === 'sub' ? ' sub-label' : field === 'label' ? ' label' : ` ${field}`}`;
  }
  if (parentType === 'scenarioPair' && (last === 'a' || last === 'b')) {
    return last === 'a' ? 'Scenario A text' : 'Scenario B text';
  }
  return FIELD_NAMES[last] || last;
}

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(ROOT, relative), 'utf8'));
}

/**
 * Which surveys include each page, keyed `file#pageId`. Text on a page that is
 * included elsewhere changes in every round that shows it, so the editor warns.
 */
function sharedWith(index, surveysById) {
  const fileById = new Map((index.surveys || []).map((entry) => [entry.id, entry.file]));
  const result = new Map();
  for (const entry of index.surveys || []) {
    const doc = surveysById.get(entry.id);
    if (!doc) continue;
    for (const page of doc.pages || []) {
      if (!page.include || !page.include.from) continue;
      const sourceFile = fileById.get(page.include.from);
      if (!sourceFile) continue;
      for (const pageId of page.include.pages || []) {
        const key = `${sourceFile}#${pageId}`;
        const list = result.get(key) || [];
        if (!list.includes(entry.title?.['en'] || entry.id)) list.push(entry.title?.['en'] || entry.id);
        result.set(key, list);
      }
    }
  }
  return result;
}

async function buildCatalog() {
  const index = await readJson('data/surveys.json');
  const surveysById = new Map();
  for (const entry of index.surveys || []) {
    try {
      surveysById.set(entry.id, await readJson(entry.file));
    } catch {
      /* a broken survey should not break the editor */
    }
  }
  const shared = sharedWith(index, surveysById);
  const entries = [];

  /* --- survey prose ---------------------------------------------------- */
  for (const entry of index.surveys || []) {
    const doc = surveysById.get(entry.id);
    if (!doc) continue;
    const surveyTitle = doc.title?.['en'] || entry.title?.['en'] || entry.id;

    const push = (pointer, value, context, pageId, sharedList = []) => {
      entries.push({
        id: `${entry.file}#${pointer}`,
        kind: 'survey',
        file: entry.file,
        pointer,
        group: `${surveyTitle}`,
        context,
        page: pageId || null,
        values: { en: value.en, zh: value.zh, fr: value.fr },
        shared: sharedList,
      });
    };

    const walkPage = (page, pageIndex) => {
      const pageLabel = page.title?.['en'] || page.id || `Page ${pageIndex + 1}`;
      const pagePointer = `/pages/${pageIndex}`;
      const pageId = page.id || null;
      const pageShared = shared.get(`${entry.file}#${pageId}`) || [];
      const onPage = (pointer, value, context) => push(pointer, value, context, pageId, pageShared);
      if (isLocalised(page.title)) onPage(`${pagePointer}/title`, page.title, `${pageLabel} · Page title`);
      if (isLocalised(page.eyebrow)) onPage(`${pagePointer}/eyebrow`, page.eyebrow, `${pageLabel} · Eyebrow`);

      (page.blocks || []).forEach((block, blockIndex) => {
        if (!block || typeof block !== 'object') return;
        const base = `${pagePointer}/blocks/${blockIndex}`;
        const contextPrefix = `${pageLabel}${block.id ? ` · ${block.id}` : ''}`;

        if (isLocalised(block)) {
          onPage(base, block, contextPrefix);
          return;
        }

        const visit = (value, pointer, hint) => {
          if (isLocalised(value)) {
            onPage(pointer, value, `${contextPrefix} · ${describeField(pointer, block.type) || hint}`);
            return;
          }
          if (Array.isArray(value)) {
            value.forEach((item, itemIndex) => {
              const itemPointer = `${pointer}/${itemIndex}`;
              if (isLocalised(item)) onPage(itemPointer, item, `${contextPrefix} · Item ${itemIndex + 1}`);
              else if (item && typeof item === 'object') visit(item, itemPointer, hint);
            });
            return;
          }
          if (value && typeof value === 'object') {
            for (const [key, child] of Object.entries(value)) {
              if (key === '_ref' || key === 'id' || key === 'type') continue;
              visit(child, `${pointer}/${key}`, hint);
            }
          }
        };

        for (const [key, child] of Object.entries(block)) {
          if (key === '_ref' || key === 'id' || key === 'type') continue;
          visit(child, `${base}/${key}`, key);
        }
      });
    };

    (doc.pages || []).forEach(walkPage);

    // Top-level survey strings (title, description) are not inside a page.
    if (isLocalised(doc.title)) {
      entries.push({
        id: `${entry.file}#/title`,
        kind: 'survey',
        file: entry.file,
        pointer: '/title',
        group: surveyTitle,
        context: 'Survey title (homepage banner)',
        values: { en: doc.title.en, zh: doc.title.zh, fr: doc.title.fr },
        shared: [],
      });
    }
  }

  /* --- interface strings ------------------------------------------------ */
  const i18n = {};
  for (const lang of LANGS) i18n[lang] = await readJson(`i18n/${lang}.json`);

  const walkKey = (value, pointer, trail) => {
    if (typeof value === 'string') {
      entries.push({
        id: `i18n${pointer}`,
        kind: 'i18n',
        file: 'i18n',
        pointer,
        group: `Interface · ${trail[0] || 'general'}`,
        context: trail.slice(1).join(' › ') || trail[0] || pointer,
        values: {
          en: read(i18n.en, trail) ?? '',
          zh: read(i18n.zh, trail) ?? '',
          fr: read(i18n.fr, trail) ?? '',
        },
        shared: [],
      });
      return;
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) walkKey(value[key], `${pointer}/${escapePointer(key)}`, [...trail, key]);
    }
  };
  walkKey(i18n.en, '', []);

  /* --- site text (contact block, notices) -------------------------------- */
  try {
    const site = await readJson('data/site.json');
    const walkSite = (value, pointer, trail) => {
      if (isLocalised(value)) {
        entries.push({
          id: `data/site.json#${pointer}`,
          kind: 'survey',
          file: 'data/site.json',
          pointer,
          group: 'Homepage · Contact and notices',
          context: trail.join(' › ') || 'text',
          values: value,
          shared: [],
        });
        return;
      }
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) walkSite(child, `${pointer}/${escapePointer(key)}`, [...trail, key]);
      }
    };
    walkSite(site, '', []);
  } catch {
    /* optional */
  }

  return {
    entries,
    surveys: (index.surveys || []).map((entry) => ({
      id: entry.id,
      title: entry.title?.['en'] || entry.id,
      file: entry.file,
    })),
    generatedAt: new Date().toISOString(),
  };
}

function read(object, trail) {
  let cursor = object;
  for (const key of trail) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/* ========================================================================== */
/* Writing                                                                    */
/* ========================================================================== */

const ALLOWED = [/^data\/.*\.json$/, /^i18n\/[a-z]{2}\.json$/];
const undoStack = [];

function safePath(relative) {
  const normalised = path.posix.normalize(String(relative || ''));
  if (normalised.startsWith('..') || path.isAbsolute(normalised)) throw new Error('bad path');
  if (!ALLOWED.some((pattern) => pattern.test(normalised))) throw new Error('path not editable');
  const absolute = path.join(ROOT, normalised);
  if (!absolute.startsWith(ROOT)) throw new Error('bad path');
  return { relative: normalised, absolute };
}

async function applyEdit({ file, pointer, lang, value }) {
  if (!LANGS.includes(lang)) throw new Error('bad language');
  if (typeof value !== 'string') throw new Error('value must be a string');
  if (value.length > 20000) throw new Error('value too long');

  const target = file === 'i18n' ? `i18n/${lang}.json` : file;
  const { relative, absolute } = safePath(target);
  const text = await readFile(absolute, 'utf8');
  const valuePointer = file === 'i18n' ? pointer : `${pointer}/${lang}`;

  const previous = readToken(text, valuePointer);
  const updated = spliceValue(text, valuePointer, value);
  JSON.parse(updated); // refuse to write invalid JSON

  await writeFile(absolute, updated, 'utf8');

  undoStack.push({ file: relative, pointer: valuePointer, previous, at: Date.now() });
  if (undoStack.length > 200) undoStack.shift();

  return { file: relative, pointer: valuePointer, previous, diff: lineDiff(text, updated) };
}

function readToken(text, pointer) {
  const span = scanJson(text).get(pointer);
  if (!span) throw new Error(`No value at ${pointer}`);
  return JSON.parse(text.slice(span.start, span.end));
}

/** A tiny context diff: the changed line, before and after. */
function lineDiff(before, after) {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld > start && endNew > start && oldLines[endOld] === newLines[endNew]) {
    endOld -= 1;
    endNew -= 1;
  }
  return {
    line: start + 1,
    before: oldLines.slice(start, endOld + 1).join('\n').slice(0, 400),
    after: newLines.slice(start, endNew + 1).join('\n').slice(0, 400),
  };
}

/* ========================================================================== */
/* HTTP                                                                       */
/* ========================================================================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
};

const readBody = async (req) => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw.replace(/^\uFEFF/, '')) : {};
};

/** Reject cross-site writes: only pages served from this origin may edit. */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetches may omit it
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

async function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const isEditor = relative.startsWith('editor/');
  const file = isEditor
    ? path.join(APP_DIR, relative.slice('editor/'.length) || 'index.html')
    : path.join(ROOT, relative);
  try {
    let body = await readFile(file);
    if (!isEditor && relative === 'assets/js/config.js') {
      // Point the preview at this process so drafts never reach production.
      body = Buffer.from(
        body.toString('utf8').replace(/apiBase:\s*'[^']*'/, `apiBase: 'http://127.0.0.1:${actualPort}'`)
      );
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname === '/api/health') {
      return json(res, 200, { ok: true, editor: true, root: ROOT });
    }

    if (pathname === '/api/catalog') {
      const catalog = await buildCatalog();
      return json(res, 200, { ok: true, ...catalog });
    }

    if (pathname === '/api/text' && req.method === 'POST') {
      if (!originAllowed(req)) return json(res, 403, { ok: false, error: 'origin not allowed' });
      const body = await readBody(req);
      const result = await applyEdit(body);
      return json(res, 200, { ok: true, ...result });
    }

    if (pathname === '/api/undo' && req.method === 'POST') {
      if (!originAllowed(req)) return json(res, 403, { ok: false, error: 'origin not allowed' });
      const entry = undoStack.pop();
      if (!entry) return json(res, 409, { ok: false, error: 'nothing to undo' });
      const { absolute, relative } = safePath(entry.file);
      const text = await readFile(absolute, 'utf8');
      const updated = spliceValue(text, entry.pointer, entry.previous);
      await writeFile(absolute, updated, 'utf8');
      return json(res, 200, { ok: true, file: relative, pointer: entry.pointer, restored: entry.previous });
    }

    // Collector for the preview's response API: accepts, stores nothing.
    if (pathname.startsWith('/v1/')) {
      if (req.method === 'POST') await readBody(req).catch(() => ({}));
      return json(res, 200, {
        ok: true,
        accepted: true,
        surveys: {},
        record: null,
        updatedAt: new Date().toISOString(),
      });
    }

    return await serveStatic(res, pathname);
  } catch (error) {
    return json(res, 400, { ok: false, error: error.message });
  }
});

function announce() {
  const address = `http://127.0.0.1:${actualPort}/editor/`;
  console.log(`\u001b[1mMAELStrOM text editor\u001b[0m`);
  console.log(`  site    http://127.0.0.1:${actualPort}/`);
  console.log(`  editor  ${address}`);
  console.log(`  root    ${ROOT}`);
  console.log(`\nEdits are written straight to the JSON files. Nothing is committed.`);
  if (OPEN) {
    const opener =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', address]]
        : process.platform === 'darwin'
          ? ['open', [address]]
          : ['xdg-open', [address]];
    try {
      spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
    } catch {
      /* opening a browser is a convenience */
    }
  }
}

/** Try the requested port, then the next few, so a busy port is not fatal. */
function tryListen(port, attempt = 0) {
  actualPort = port;
  server.listen(port, '127.0.0.1', announce);
  server.once('error', (error) => {
    if ((error.code === 'EACCES' || error.code === 'EADDRINUSE') && attempt < 10) {
      console.warn(`port ${port} unavailable (${error.code}), trying ${port + 1}`);
      tryListen(port + 1, attempt + 1);
      return;
    }
    console.error(error.message);
    process.exit(1);
  });
}

tryListen(PORT);
