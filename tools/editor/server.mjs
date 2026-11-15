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

const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function applyEdit({ file, pointer, lang, value }) {
  const [result] = await applyBatch([{ file, pointer, lang, value }], uid('edit'));
  const { relative, absolute } = safePath(result.file);
  const text = await readFile(absolute, 'utf8');
  return {
    file: result.file,
    pointer: result.pointer,
    previous: result.previous,
    diff: lineDiff(result.before, text),
  };
}

/** `i18n` entries live in one file per language; everything else uses a lang key. */
function targetFor(file, lang) {
  if (!LANGS.includes(lang)) throw new Error('bad language');
  return file === 'i18n'
    ? { jsonFile: `i18n/${lang}.json`, valuePointer: (pointer) => pointer }
    : { jsonFile: file, valuePointer: (pointer) => `${pointer}/${lang}` };
}

/** Apply several edits at once, writing each file only once. */
async function applyBatch(changes, batch) {
  if (!changes.length) return [];

  const groups = new Map();
  for (const change of changes) {
    if (typeof change.value !== 'string') throw new Error('value must be a string');
    if (change.value.length > 20000) throw new Error('value too long');
    const { jsonFile, valuePointer } = targetFor(change.file, change.lang);
    const pointer = valuePointer(change.pointer);
    if (!groups.has(jsonFile)) groups.set(jsonFile, { jsonFile, edits: [] });
    groups.get(jsonFile).edits.push({ pointer, value: change.value, source: change });
  }

  const results = [];
  for (const group of groups.values()) {
    const { relative, absolute } = safePath(group.jsonFile);
    const text = await readFile(absolute, 'utf8');
    const spans = scanJson(text);

    const edits = group.edits
      .map((edit) => ({ ...edit, span: spans.get(edit.pointer) }))
      .filter((edit) => edit.span);

    if (edits.length !== group.edits.length) {
      const missing = group.edits.filter((edit) => !spans.has(edit.pointer)).map((edit) => edit.pointer);
      throw new Error(`No value at ${missing[0]}`);
    }

    // Splice from the end so earlier offsets stay valid.
    let updated = text;
    for (const edit of edits.slice().sort((a, b) => b.span.start - a.span.start)) {
      updated = updated.slice(0, edit.span.start) + JSON.stringify(edit.value) + updated.slice(edit.span.end);
    }
    JSON.parse(updated); // refuse to write invalid JSON
    await writeFile(absolute, updated, 'utf8');

    for (const edit of edits) {
      const previous = JSON.parse(text.slice(edit.span.start, edit.span.end));
      results.push({ file: relative, pointer: edit.pointer, previous, before: text });
      undoStack.push({ file: relative, pointer: edit.pointer, previous, batch, at: Date.now() });
    }
  }

  while (undoStack.length > 5000) undoStack.shift();
  return results;
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
/* CSV round-trip                                                             */
/* ========================================================================== */

const CSV_COLUMNS = ['id', 'group', 'context', 'file', 'pointer', 'page', 'en', 'zh', 'fr', 'shared'];

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
  // A BOM makes Excel read the file as UTF-8 instead of the local codepage.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Excel saves with the locale's separator, so do not assume a comma. */
function detectDelimiter(text) {
  const firstLine = text.split('\n')[0] || '';
  for (const delimiter of [',', ';', '\t']) {
    const cells = firstLine.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, '').toLowerCase());
    if (cells.includes('id') && LANGS.some((lang) => cells.includes(lang))) return delimiter;
  }
  return ',';
}

function parseCsv(text, delimiter = ',') {
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
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\r') {
      /* newlines are normalised in the imported value */
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

async function buildCsv() {
  const { entries } = await buildCatalog();
  return toCsv(
    entries.map((entry) => ({
      id: entry.id,
      group: entry.group,
      context: entry.context,
      file: entry.file,
      pointer: entry.pointer,
      page: entry.page || '',
      en: entry.values.en,
      zh: entry.values.zh,
      fr: entry.values.fr,
      shared: (entry.shared || []).join('; '),
    }))
  );
}

/**
 * Apply every changed cell of an uploaded sheet. Unchanged cells are skipped,
 * unknown ids are reported rather than written, and everything applied shares
 * one batch so it can be reverted in a single step.
 */
async function importCsv(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const rows = parseCsv(clean, detectDelimiter(clean));
  if (rows.length < 1) throw new Error('the file is empty');

  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const idIndex = header.indexOf('id');
  if (idIndex < 0) throw new Error('the CSV needs an "id" column (export it from the editor first)');
  const langIndex = Object.fromEntries(LANGS.map((lang) => [lang, header.indexOf(lang)]));
  if (LANGS.every((lang) => langIndex[lang] < 0)) {
    throw new Error('the CSV needs at least one of the en / zh / fr columns');
  }

  const { entries } = await buildCatalog();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const changes = [];
  const errors = [];
  const warnings = [];
  let unchanged = 0;

  rows.slice(1).forEach((row, offset) => {
    const line = offset + 2;
    const id = (row[idIndex] ?? '').trim();
    if (!id) return; // blank row, e.g. the trailing one

    const entry = byId.get(id);
    if (!entry) {
      errors.push({ line, message: `unknown id: ${id}` });
      return;
    }

    for (const lang of LANGS) {
      const index = langIndex[lang];
      if (index < 0 || index >= row.length) continue;
      const next = row[index].replace(/\r\n/g, '\n');
      if (next === entry.values[lang]) {
        unchanged += 1;
        continue;
      }
      if (!next.trim()) warnings.push({ line, message: `${lang} would become empty for ${id}` });
      changes.push({ file: entry.file, pointer: entry.pointer, lang, value: next, id });
    }
  });

  if (!changes.length) return { updated: 0, unchanged, errors, warnings, batch: null };

  const batch = uid('import');
  await applyBatch(changes, batch);
  return {
    updated: changes.length,
    unchanged,
    errors,
    warnings,
    batch,
    files: [...new Set(changes.map((change) => change.file))],
  };
}

async function undoBatch(batch) {
  const target = batch || undoStack[undoStack.length - 1]?.batch;
  if (!target) return { reverted: 0, batch: null };

  const entries = undoStack.filter((entry) => entry.batch === target);
  for (const entry of entries) {
    const index = undoStack.indexOf(entry);
    if (index >= 0) undoStack.splice(index, 1);
  }

  for (const entry of entries.slice().reverse()) {
    const { absolute } = safePath(entry.file);
    const text = await readFile(absolute, 'utf8');
    await writeFile(absolute, spliceValue(text, entry.pointer, entry.previous), 'utf8');
  }
  return { reverted: entries.length, batch: target };
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

const readText = async (req, limit = 1_000_000) => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error('body too large');
  }
  return raw;
};

const readBody = async (req) => {
  const raw = await readText(req);
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
      const result = await undoBatch(null);
      if (!result.reverted) return json(res, 409, { ok: false, error: 'nothing to undo' });
      return json(res, 200, { ok: true, ...result });
    }

    if (pathname === '/api/undo-batch' && req.method === 'POST') {
      if (!originAllowed(req)) return json(res, 403, { ok: false, error: 'origin not allowed' });
      const body = await readBody(req);
      const result = await undoBatch(body.batch);
      if (!result.reverted) return json(res, 409, { ok: false, error: 'nothing to undo' });
      return json(res, 200, { ok: true, ...result });
    }

    if (pathname === '/api/export.csv' && req.method === 'GET') {
      const csv = await buildCsv();
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="maelstrom-text.csv"',
        'cache-control': 'no-store',
      });
      return res.end(csv);
    }

    if (pathname === '/api/import' && req.method === 'POST') {
      if (!originAllowed(req)) return json(res, 403, { ok: false, error: 'origin not allowed' });
      const text = await readText(req, 8_000_000);
      const report = await importCsv(text);
      return json(res, 200, { ok: true, ...report });
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
