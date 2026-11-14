#!/usr/bin/env node
/**
 * Repository validator — run before every push (`npm run validate`).
 *
 * It checks the things that are easy to break when adding a survey by hand:
 *   - data/surveys.json points at files that exist
 *   - every survey has valid pages, unique ids and well-formed blocks
 *   - `include` directives resolve, with no cycles
 *   - every option / branch reference exists
 *   - all three languages are present for author-supplied content
 *   - i18n dictionaries share exactly the same keys
 *   - every i18n key used in JS/HTML exists in en.json
 *   - reports/manifest.json only points at files that exist
 *
 * Exit code 0 = clean (warnings allowed), 1 = errors.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LANGS = ['en', 'zh', 'fr'];
const KNOWN_TYPES = new Set([
  'prose',
  'callout',
  'contact',
  'consent',
  'tagGenerate',
  'tagLookup',
  'tagDisplay',
  'resumePrompt',
  'shortText',
  'longText',
  'singleChoice',
  'multiChoice',
  'branchScale',
  'scenarioPair',
]);
const QUESTION_TYPES = new Set([
  'shortText',
  'longText',
  'singleChoice',
  'multiChoice',
  'branchScale',
  'scenarioPair',
]);
const BLOCK_ID_TYPES = new Set([
  'consent',
  'tagGenerate',
  'tagLookup',
  'shortText',
  'longText',
  'singleChoice',
  'multiChoice',
  'branchScale',
  'scenarioPair',
]);

const errors = [];
const warnings = [];

const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');
const error = (scope, message) => errors.push(`${scope}: ${message}`);
const warn = (scope, message) => warnings.push(`${scope}: ${message}`);

async function readJSON(file) {
  const raw = await readFile(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (cause) {
    error(rel(file), `invalid JSON — ${cause.message}`);
    return null;
  }
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/* --- Localised content --------------------------------------------------- */

function checkLocalised(scope, field, value, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) error(scope, `missing "${field}"`);
    return;
  }
  if (typeof value === 'string') {
    if (!value.trim() && required) error(scope, `"${field}" is empty`);
    return;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    error(scope, `"${field}" must be a string or a {en,zh,fr} object`);
    return;
  }
  for (const lang of LANGS) {
    const text = value[lang];
    if (typeof text !== 'string' || !text.trim()) {
      if (required) error(scope, `"${field}" is missing the "${lang}" translation`);
    }
  }
  const extra = Object.keys(value).filter((key) => !LANGS.includes(key));
  if (extra.length) warn(scope, `"${field}" has unexpected language keys: ${extra.join(', ')}`);
}

/* --- Survey documents ---------------------------------------------------- */

async function loadSurveys() {
  const indexFile = path.join(ROOT, 'data/surveys.json');
  const index = await readJSON(indexFile);
  if (!index) return { index: null, docs: new Map() };

  const docs = new Map();
  for (const entry of index.surveys || []) {
    const scope = `data/surveys.json[${entry.id}]`;
    for (const field of ['id', 'file', 'code']) {
      if (!entry[field]) error(scope, `missing "${field}"`);
    }
    if (!['open', 'closed', 'scheduled'].includes(entry.status)) {
      error(scope, `status must be open | closed | scheduled (got "${entry.status}")`);
    }
    if (!(await exists(path.join(ROOT, entry.file)))) {
      error(scope, `file not found: ${entry.file}`);
      continue;
    }
    const doc = await readJSON(path.join(ROOT, entry.file));
    if (doc) docs.set(entry.id, { entry, doc, file: entry.file });
  }

  const ids = (index.surveys || []).map((entry) => entry.id);
  const duplicates = ids.filter((id, position) => ids.indexOf(id) !== position);
  if (duplicates.length) error('data/surveys.json', `duplicate survey ids: ${duplicates.join(', ')}`);

  return { index, docs };
}

function resolvePages(scope, surveyId, pages, docs, depth = 0) {
  if (depth > 4) {
    error(scope, 'include nesting is too deep (possible cycle)');
    return [];
  }
  const out = [];
  for (const page of pages || []) {
    if (page.include) {
      const source = docs.get(page.include.from);
      if (!source) {
        error(scope, `include references unknown survey "${page.include.from}"`);
        continue;
      }
      for (const wanted of page.include.pages || []) {
        const found = (source.doc.pages || []).find((candidate) => candidate.id === wanted);
        if (!found) {
          error(scope, `include references unknown page "${wanted}" in "${page.include.from}"`);
          continue;
        }
        out.push(resolveCopy(found));
      }
    } else {
      out.push({ ...page });
    }
  }
  return out;

  function resolveCopy(page) {
    // Includes inside included pages are followed lazily; page bodies do not nest here.
    void surveyId;
    return JSON.parse(JSON.stringify(page));
  }
}

function validateBlock(scope, surveyId, block, seenIds, pageId) {
  if (!block || typeof block !== 'object') {
    error(scope, 'block is not an object');
    return;
  }
  if (!KNOWN_TYPES.has(block.type)) {
    error(scope, `unknown block type "${block.type}"`);
    return;
  }

  if (BLOCK_ID_TYPES.has(block.type)) {
    if (!block.id) {
      error(scope, `${block.type} block is missing an id`);
    } else {
      if (!/^[a-zA-Z0-9_]+$/.test(block.id)) {
        warn(scope, `block id "${block.id}" uses unusual characters`);
      }
      if (seenIds.has(block.id)) {
        error(scope, `duplicate block id "${block.id}" in survey "${surveyId}"`);
      }
      seenIds.add(block.id);
    }
  }

  if (QUESTION_TYPES.has(block.type) || block.type === 'consent') {
    const promptField = block.type === 'consent' ? 'label' : 'prompt';
    if (block.type !== 'scenarioPair') {
      checkLocalised(scope, promptField, block[promptField]);
    } else if (block.prompt) {
      checkLocalised(scope, 'prompt', block.prompt, { required: false });
    }
  }

  if (['prose', 'callout'].includes(block.type)) {
    checkLocalised(scope, 'text', block.text);
  }

  if (block.type === 'longText' || block.type === 'shortText') {
    if (block.placeholder) checkLocalised(scope, 'placeholder', block.placeholder, { required: false });
  }

  if (['singleChoice', 'multiChoice'].includes(block.type)) {
    if (!Array.isArray(block.options) || block.options.length < 2) {
      error(scope, `${block.type} needs at least two options`);
    } else {
      const optionIds = new Set();
      for (const option of block.options) {
        if (!option.id) error(scope, 'option without an id');
        else if (optionIds.has(option.id)) error(scope, `duplicate option id "${option.id}"`);
        else optionIds.add(option.id);
        checkLocalised(scope, `option(${option.id}).label`, option.label);
        if (option.sub) checkLocalised(scope, `option(${option.id}).sub`, option.sub, { required: false });
        // A missing placeholder is fine: the renderer falls back to common.pleaseSpecify.
      }
    }
    if (block.type === 'multiChoice' && block.minSelections !== undefined) {
      if (!Number.isInteger(block.minSelections) || block.minSelections < 0) {
        error(scope, 'minSelections must be a non-negative integer');
      }
    }
  }

  if (block.type === 'branchScale') {
    const ids = new Set((block.options || []).map((option) => option.id));
    if (ids.size < 2) error(scope, 'branchScale needs at least two options');
    if (!block.followUp) {
      error(scope, 'branchScale needs a followUp block');
    } else {
      checkLocalised(scope, 'followUp.prompt', block.followUp.prompt);
      for (const when of block.followUp.when || []) {
        if (!ids.has(when)) error(scope, `followUp.when references unknown option "${when}"`);
      }
      if (!Array.isArray(block.followUp.options) || block.followUp.options.length < 2) {
        error(scope, 'branchScale followUp needs at least two options');
      }
    }
    if (block.statement) checkLocalised(scope, 'statement', block.statement);
  }

  if (block.type === 'scenarioPair') {
    checkLocalised(scope, 'a', block.a);
    checkLocalised(scope, 'b', block.b);
    if (!block.followUp) error(scope, 'scenarioPair needs a followUp block');
    else if (!Array.isArray(block.followUp.options) || block.followUp.options.length < 2) {
      error(scope, 'scenarioPair followUp needs at least two options');
    }
  }

  if (block.type === 'tagLookup' && block.allowSkip === undefined) {
    warn(scope, 'tagLookup has no allowSkip flag; participants who lost a tag will be stuck');
  }

  void pageId;
}

function validateSurvey(id, { doc, file }) {
  const scope = file;
  if (doc.id !== id) error(scope, `survey id "${doc.id}" does not match manifest id "${id}"`);
  checkLocalised(scope, 'title', doc.title);
  checkLocalised(scope, 'shortTitle', doc.shortTitle, { required: false });
  checkLocalised(scope, 'summary', doc.summary, { required: false });

  if (!Array.isArray(doc.pages) || doc.pages.length === 0) {
    error(scope, 'survey has no pages');
    return;
  }

  const resolved = resolvePages(scope, id, doc.pages, docsRef);
  const pageIds = new Set();
  const seenBlockIds = new Set();
  let questionCount = 0;
  let submitCount = 0;

  resolved.forEach((page, index) => {
    const pageScope = `${scope} page[${index}] "${page.id || '?'}"`;
    if (!page.id) error(pageScope, 'page is missing an id');
    else if (pageIds.has(page.id)) error(pageScope, `duplicate page id "${page.id}"`);
    else pageIds.add(page.id);

    checkLocalised(pageScope, 'title', page.title);
    if (page.eyebrow) checkLocalised(pageScope, 'eyebrow', page.eyebrow, { required: false });

    if (page.kind === 'completion') {
      if (!Array.isArray(page.blocks)) warn(pageScope, 'completion page has no blocks');
      return;
    }

    if (!Array.isArray(page.blocks) || page.blocks.length === 0) {
      error(pageScope, 'page has no blocks');
      return;
    }

    for (const block of page.blocks) {
      validateBlock(pageScope, id, block, seenBlockIds, page.id);
      if (QUESTION_TYPES.has(block.type)) questionCount += 1;
    }

    if (page.submit) submitCount += 1;
  });

  if (submitCount !== 1) {
    error(scope, `expected exactly one page with "submit": true, found ${submitCount}`);
  }
  if (!resolved.some((page) => page.kind === 'completion')) {
    error(scope, 'no completion page (kind: "completion")');
  }
  if (questionCount === 0) error(scope, 'survey contains no questions');

  const flow = doc.flow || {};
  if (flow.baselineSurvey && !docsRef.has(flow.baselineSurvey)) {
    error(scope, `flow.baselineSurvey references unknown survey "${flow.baselineSurvey}"`);
  }

  console.log(
    `  ${id}: ${resolved.length} pages, ${questionCount} questions, ${seenBlockIds.size} block ids`
  );
}

/* --- i18n ---------------------------------------------------------------- */

async function loadLocale(lang) {
  const file = path.join(ROOT, `i18n/${lang}.json`);
  const dict = await readJSON(file);
  const flat = new Map();
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node || {})) {
      const full = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object') walk(value, full);
      else if (typeof value === 'string') flat.set(full, value);
    }
  };
  walk(dict, '');
  return flat;
}

function collectUsedKeys(files, htmlFiles) {
  const keys = new Set();
  const keyPattern = /\bt\(\s*['"]([^'"]+)['"]/g;
  const namespacePattern = /['"]((?:common|home|survey)\.[A-Za-z0-9_.]+)['"]/g;
  const dataI18n = /data-i18n="([^"]+)"/g;
  const dataI18nAttr = /data-i18n-attr="([^"]+)"/g;

  for (const { name, text } of files) {
    for (const pattern of [keyPattern, namespacePattern]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) keys.add(match[1]);
    }
    void name;
  }
  for (const { name, text } of htmlFiles) {
    for (const pattern of [dataI18n, dataI18nAttr]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        const raw = match[1];
        if (raw.includes(':')) {
          for (const pair of raw.split('|')) {
            const [, key] = pair.split(':');
            if (key?.trim()) keys.add(key.trim());
          }
        } else {
          keys.add(raw.trim());
        }
      }
    }
    void name;
  }
  return keys;
}

async function walkFiles(dir, filter) {
  const out = [];
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full, filter)));
    else if (filter(full)) out.push(full);
  }
  return out;
}

/* --- Reports ------------------------------------------------------------- */

async function validateReports() {
  const manifestFile = path.join(ROOT, 'reports/manifest.json');
  const manifest = await readJSON(manifestFile);
  if (!manifest) return;
  if (!Array.isArray(manifest.files)) {
    error('reports/manifest.json', 'missing "files" array');
    return;
  }
  for (const file of manifest.files) {
    if (!file.path) {
      error('reports/manifest.json', 'entry without a path');
      continue;
    }
    if (!(await exists(path.join(ROOT, file.path)))) {
      error('reports/manifest.json', `file not found: ${file.path} (run npm run manifest)`);
    }
    if (file.path.includes('..')) error('reports/manifest.json', `unsafe path: ${file.path}`);
  }
}

/* --- Main ---------------------------------------------------------------- */

const docsRef = new Map();

const { index, docs } = await loadSurveys();
for (const [id, value] of docs) docsRef.set(id, value);

if (index) {
  console.log('Surveys:');
  for (const [id, doc] of docs) validateSurvey(id, doc);
}

console.log('\nLocales:');
const locales = {};
for (const lang of LANGS) {
  locales[lang] = await loadLocale(lang);
  console.log(`  ${lang}: ${locales[lang].size} keys`);
}

const reference = locales.en;
for (const lang of LANGS.filter((code) => code !== 'en')) {
  for (const key of reference.keys()) {
    if (!locales[lang].has(key)) error(`i18n/${lang}.json`, `missing key "${key}"`);
  }
  for (const key of locales[lang].keys()) {
    if (!reference.has(key)) error(`i18n/${lang}.json`, `key "${key}" is not in en.json`);
  }
}

const jsFiles = await walkFiles(path.join(ROOT, 'assets/js'), (file) => file.endsWith('.js'));
const htmlFiles = (await walkFiles(ROOT, (file) => file.endsWith('.html'))).filter(
  (file) => !file.includes('node_modules')
);

const used = collectUsedKeys(
  await Promise.all(jsFiles.map(async (file) => ({ name: file, text: await readFile(file, 'utf8') }))),
  await Promise.all(htmlFiles.map(async (file) => ({ name: file, text: await readFile(file, 'utf8') })))
);

const unused = [...reference.keys()].filter((key) => !used.has(key));
for (const key of unused) warn('i18n/en.json', `key "${key}" is never used`);
for (const key of used) {
  if (!reference.has(key)) error('i18n/en.json', `missing key "${key}" used in code`);
}

await validateReports();

/* --- Report -------------------------------------------------------------- */

console.log('');
if (warnings.length) {
  console.log(`Warnings (${warnings.length}):`);
  for (const warning of warnings) console.log(`  ! ${warning}`);
}
if (errors.length) {
  console.error(`\nErrors (${errors.length}):`);
  for (const issue of errors) console.error(`  ✕ ${issue}`);
  process.exit(1);
}
console.log('Validation passed.');
