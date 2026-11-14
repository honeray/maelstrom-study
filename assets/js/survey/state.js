/* ==========================================================================
   Answer state + validation rules for one survey response.
   ========================================================================== */

import { QUESTION_TYPES } from './schema.js';
import { t, loc } from '../lib/i18n.js';
import { CONFIG } from '../config.js';

export const otherKey = (id) => `${id}__other`;
export const extentKey = (id) => `${id}__extent`;
export const commentKey = (id) => `${id}__comment`;

export function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export class SurveyState {
  /**
   * @param {{survey: object, tag?: string|null, answers?: object,
   *          presentation?: object, pageId?: string|null, final?: boolean,
   *          baseline?: object|null}} init
   */
  constructor({ survey, tag = null, answers = {}, presentation = {}, pageId = null, final = false, baseline = null }) {
    this.survey = survey;
    this.tag = tag;
    this.answers = { ...answers };
    this.presentation = { ...presentation };
    this.pageId = pageId || survey.pages?.[0]?.id || null;
    this.final = final;
    this.dirty = false;
    this.synced = false;
    this.baseline = baseline;
    this.startedAt = new Date().toISOString();
    this.touched = new Set();
  }

  getAnswer(id) {
    return this.answers[id];
  }

  setAnswer(id, value) {
    if (this.final) return;
    if (value === undefined || value === null || value === '') {
      delete this.answers[id];
    } else {
      this.answers[id] = value;
    }
    this.dirty = true;
  }

  /** Update an answer and clear any now-irrelevant dependent answers. */
  setBlockValue(block, value) {
    if (this.final) return;
    this.setAnswer(block.id, value);
    this.touched.add(block.id);

    if (block.type === 'branchScale') {
      const needsExtent = (block.followUp?.when || []).includes(value);
      if (!needsExtent) this.setAnswer(extentKey(block.id), null);
    } else if (block.type === 'scenarioPair') {
      if (value === 'neutral') this.setAnswer(extentKey(block.id), null);
    } else if (block.type === 'singleChoice') {
      const option = (block.options || []).find((candidate) => candidate.id === value);
      if (!option?.allowText) this.setAnswer(otherKey(block.id), null);
    } else if (block.type === 'multiChoice') {
      const selected = Array.isArray(value) ? value : [];
      const allowsText = selected.some(
        (id) => (block.options || []).find((candidate) => candidate.id === id)?.allowText
      );
      if (!allowsText) this.setAnswer(otherKey(block.id), null);
    }
  }

  toggleMulti(block, optionId, checked) {
    const current = Array.isArray(this.answers[block.id]) ? this.answers[block.id].slice() : [];
    const index = current.indexOf(optionId);
    if (checked && index === -1) current.push(optionId);
    if (!checked && index !== -1) current.splice(index, 1);
    // Preserve the authored option order so exported data is stable.
    const order = (block.options || []).map((option) => option.id);
    current.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    this.setBlockValue(block, current);
  }

  isAnswered(block) {
    switch (block.type) {
      case 'prose':
      case 'callout':
      case 'contact':
      case 'resumePrompt':
        return true;

      case 'consent':
        return this.answers[block.id] === true;

      case 'tagGenerate':
        return typeof this.tag === 'string' && this.tag.length === CONFIG.tagLength;

      case 'tagLookup':
        return this.tagVerified === true;

      case 'shortText':
      case 'longText':
        return !block.required || !isEmptyValue(this.answers[block.id]);

      case 'singleChoice': {
        const value = this.answers[block.id];
        if (isEmptyValue(value)) return !block.required;
        const option = (block.options || []).find((candidate) => candidate.id === value);
        if (option?.allowText) return !isEmptyValue(this.answers[otherKey(block.id)]);
        return true;
      }

      case 'multiChoice': {
        const values = Array.isArray(this.answers[block.id]) ? this.answers[block.id] : [];
        const minimum = block.minSelections ?? (block.required ? 1 : 0);
        if (values.length < minimum) return false;
        const allowsText = values.some(
          (id) => (block.options || []).find((candidate) => candidate.id === id)?.allowText
        );
        if (allowsText && isEmptyValue(this.answers[otherKey(block.id)])) return false;
        return true;
      }

      case 'branchScale': {
        const value = this.answers[block.id];
        if (isEmptyValue(value)) return !block.required;
        const needsExtent = (block.followUp?.when || []).includes(value);
        if (needsExtent && isEmptyValue(this.answers[extentKey(block.id)])) return false;
        return true;
      }

      case 'scenarioPair': {
        const value = this.answers[block.id];
        if (isEmptyValue(value)) return !block.required;
        if (value !== 'neutral' && isEmptyValue(this.answers[extentKey(block.id)])) return false;
        return true;
      }

      default:
        return true;
    }
  }

  /** @returns {{ok: boolean, errors: Array<{blockId: string, message: string}>}} */
  validatePage(page) {
    const errors = [];
    for (const block of page.blocks || []) {
      if (!QUESTION_TYPES.has(block.type) && !['consent', 'tagGenerate', 'tagLookup'].includes(block.type)) {
        continue;
      }
      if (this.isAnswered(block)) continue;
      errors.push({
        blockId: block.id,
        message: block.requiredMessage ? loc(block.requiredMessage) : this.defaultError(block),
      });
    }
    return { ok: errors.length === 0, errors };
  }

  defaultError(block) {
    if (block.type === 'tagGenerate') return t('survey.tag.notGenerated');
    if (block.type === 'tagLookup') return t('survey.tag.notVerified');
    return t('survey.error.required');
  }

  /** Answers in a stable, export-friendly shape. */
  serialiseAnswers() {
    const out = {};
    Object.keys(this.answers)
      .sort()
      .forEach((key) => {
        const value = this.answers[key];
        if (value === undefined || value === null || value === '') return;
        if (Array.isArray(value) && value.length === 0) return;
        out[key] = value;
      });
    return out;
  }

  toDraft() {
    return {
      schemaVersion: CONFIG.schemaVersion,
      surveyId: this.survey.id,
      tag: this.tag,
      pageId: this.pageId,
      final: this.final,
      updatedAt: new Date().toISOString(),
      answers: this.serialiseAnswers(),
      presentation: this.presentation,
    };
  }

  toRecord(extra = {}) {
    return {
      surveyId: this.survey.id,
      tag: this.tag,
      final: this.final,
      pageId: this.pageId,
      updatedAt: new Date().toISOString(),
      answers: this.serialiseAnswers(),
      presentation: this.presentation,
      baseline: this.baseline
        ? {
            surveyId: this.baseline.surveyId || null,
            updatedAt: this.baseline.updatedAt || null,
            missing: Boolean(this.baseline.missing),
          }
        : null,
      meta: extra.meta || {},
    };
  }

  hydrate(record) {
    if (!record) return this;
    this.answers = { ...(record.answers || {}) };
    this.presentation = { ...(record.presentation || {}) };
    this.final = Boolean(record.final);
    if (record.pageId) this.pageId = record.pageId;
    this.dirty = false;
    this.synced = true;
    return this;
  }
}
