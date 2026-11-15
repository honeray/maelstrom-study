/* ==========================================================================
   Survey document loading.
   A survey is a single JSON file. Round 2 reuses Round 1's pages through an
   `include` directive so the questions only ever exist in one place.
   ========================================================================== */

import { hashString, seededShuffle } from '../lib/util.js';

/** Block types that count as a numbered question. */
export const QUESTION_TYPES = new Set([
  'shortText',
  'longText',
  'singleChoice',
  'multiChoice',
  'branchScale',
  'scenarioPair',
]);

/** Blocks that are presentational rather than answered. */
export const STATIC_TYPES = new Set(['prose', 'callout', 'contact', 'resumePrompt']);

export function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function questionBlocks(page) {
  return (page.blocks || []).filter((block) => QUESTION_TYPES.has(block.type));
}

/**
 * Does this question gate the page?
 *
 * Mirrors SurveyState.isAnswered: a block is required only when the survey JSON
 * says `"required": true` (the default is optional), and a multi-choice
 * `minSelections` floor counts even when `required` is false. The renderer marks
 * questions from this same predicate, so the "Required" / "Optional" label
 * cannot drift from what actually blocks Continue.
 */
export function blockRequiresAnswer(block) {
  if (!block || !QUESTION_TYPES.has(block.type)) return false;
  if (block.type === 'multiChoice') {
    const minimum = block.minSelections ?? (block.required ? 1 : 0);
    return minimum > 0;
  }
  return block.required === true;
}

export function countQuestions(survey) {
  return (survey.pages || []).reduce((total, page) => total + questionBlocks(page).length, 0);
}

/** Fetch + include resolution, memoised per page load. */
export class SurveyLoader {
  constructor() {
    this.jsonCache = new Map();
    this.docCache = new Map();
    this.index = null;
  }

  async getIndex() {
    if (this.index) return this.index;
    const response = await fetch('data/surveys.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('Could not load data/surveys.json');
    this.index = await response.json();
    return this.index;
  }

  async getEntry(id) {
    const index = await this.getIndex();
    return (index.surveys || []).find((entry) => entry.id === id) || null;
  }

  async getRaw(id) {
    if (this.jsonCache.has(id)) return this.jsonCache.get(id);
    const entry = await this.getEntry(id);
    if (!entry) throw new Error(`Unknown survey "${id}"`);
    const response = await fetch(entry.file, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Could not load ${entry.file} (${response.status})`);
    const raw = await response.json();
    raw.pages = await this.expandPages(raw.pages || [], new Set([id]));

    // Provenance: remember where each page and block came from so the editor can
    // map a click back to the exact JSON value. Included pages keep the ref of
    // the survey they were copied from, which is where the text really lives.
    raw.pages.forEach((page, pageIndex) => {
      if (!page._ref) page._ref = `${entry.file}#/pages/${pageIndex}`;
      (page.blocks || []).forEach((block, blockIndex) => {
        if (!block._ref) block._ref = `${page._ref}/blocks/${blockIndex}`;
      });
    });

    this.jsonCache.set(id, raw);
    return raw;
  }

  async get(id) {
    if (this.docCache.has(id)) return this.docCache.get(id);
    const raw = await this.getRaw(id);
    const entry = await this.getEntry(id);
    const document = { ...raw, entry };
    this.docCache.set(id, document);
    return document;
  }

  /**
   * Replace `include` pages with copies of pages from another survey.
   * `with` is merged over each included page, which lets Round 2 retitle a
   * page without duplicating its questions.
   */
  async expandPages(pages, guard, depth = 0) {
    if (depth > 4) throw new Error('Survey include nesting is too deep');
    const out = [];
    for (const page of pages) {
      if (!page || typeof page !== 'object') continue;
      if (!page.include) {
        out.push(clone(page));
        continue;
      }

      const from = page.include.from;
      if (guard.has(from) && depth > 0) throw new Error(`Circular survey include: ${from}`);
      const source = await this.getRaw(from);
      const wanted = page.include.pages || [];
      const byId = new Map((source.pages || []).map((candidate) => [candidate.id, candidate]));
      for (const pageId of wanted) {
        const sourcePage = byId.get(pageId);
        if (!sourcePage) throw new Error(`Page "${pageId}" not found in "${from}"`);
        const merged = { ...clone(sourcePage), ...(page.with || {}) };
        merged.includedFrom = from;
        // A retitled page no longer owns its title in the source file, so the
        // editor must not offer to edit the source title for it.
        if (page.with && page.with.title) merged._titleOverridden = true;
        out.push(merged);
      }
    }
    return out;
  }
}

/**
 * Deterministic presentation for randomised pages.
 * The seed is the participant tag so a participant always sees the same order
 * in every session, and Round 2 can reproduce Round 1 exactly.
 */
export function buildPresentation(page, seed) {
  const blocks = page.blocks || [];
  const scenarioBlocks = blocks.filter((block) => block.type === 'scenarioPair');
  const baseSeed = hashString(`${seed}::${page.id}`);

  const order = seededShuffle(
    scenarioBlocks.map((block) => block.id),
    baseSeed
  );

  const swapped = {};
  scenarioBlocks.forEach((block, index) => {
    // One extra deterministic coin flip per pair.
    const coin = hashString(`${seed}::${page.id}::${block.id}`) % 2 === 0;
    swapped[block.id] = coin;
    void index;
  });

  return { order, swapped };
}

/** Apply a presentation record to a page (blocks reordered, pairs swapped). */
export function applyPresentation(page, presentation) {
  if (!presentation) return page;
  const blocks = page.blocks || [];

  if (page.randomize === 'blocks' && Array.isArray(presentation.order) && presentation.order.length) {
    // Only the randomised question blocks move; any prose or newly added block
    // keeps its authored position so the authored structure is never disturbed.
    const slots = [];
    blocks.forEach((block, index) => {
      if (block.type === 'scenarioPair') slots.push(index);
    });

    const byId = new Map(blocks.map((block) => [block.id, block]));
    const shuffled = presentation.order.map((id) => byId.get(id)).filter(Boolean);
    const randomised = new Set(shuffled);
    const leftover = slots
      .map((index) => blocks[index])
      .filter((block) => !randomised.has(block));

    const ordered = blocks.slice();
    const pool = shuffled.concat(leftover);
    slots.forEach((slot, index) => {
      if (pool[index]) ordered[slot] = pool[index];
    });
    page.blocks = ordered;
  }

  for (const block of page.blocks || []) {
    if (block.type === 'scenarioPair') {
      block._swapped = Boolean(presentation.swapped?.[block.id]);
      // Keep the display order map for the renderer.
      block._display = block._swapped ? ['b', 'a'] : ['a', 'b'];
    }
  }
  return page;
}

/** Collect the presentation records a survey needs, creating missing ones. */
export function ensurePresentations(survey, seed, existing = {}) {
  const presentation = { ...existing };
  for (const page of survey.pages) {
    if (page.randomize !== 'blocks') continue;
    const current = presentation[page.id];
    const valid =
      current && Array.isArray(current.order) && current.order.length && current.swapped;
    if (!valid) presentation[page.id] = buildPresentation(page, seed);
  }
  return presentation;
}
