/* ==========================================================================
   localStorage wrapper — the participant's own safety net.
   Every write is defensive: private browsing, quota errors and corrupt
   values must never break the survey.
   ========================================================================== */

import { CONFIG } from '../config.js';

const P = CONFIG.storagePrefix;

export const KEYS = Object.freeze({
  language: `${P}.language`,
  profile: `${P}.profile`,
  draft: (surveyId) => `${P}.draft.${surveyId}`,
  outbox: (surveyId) => `${P}.outbox.${surveyId}`,
});

function backend() {
  try {
    const probe = `${P}.__probe__`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

const store = backend();

export const storageAvailable = Boolean(store);

export function readJSON(key, fallback = null) {
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJSON(key, value) {
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* --- Language ---------------------------------------------------------- */

export function readLanguage() {
  if (!store) return null;
  try {
    return store.getItem(KEYS.language);
  } catch {
    return null;
  }
}

export function writeLanguage(code) {
  if (!store) return;
  try {
    store.setItem(KEYS.language, code);
  } catch {
    /* ignore */
  }
}

/* --- Participant profile ------------------------------------------------ */

/**
 * @typedef {object} Profile
 * @property {string|null} tag
 * @property {Record<string, {at: string}>} completed  surveyId -> completion stamp
 * @property {string|null} lastSurvey
 */

/** @returns {Profile} */
export function readProfile() {
  const value = readJSON(KEYS.profile, null);
  if (!value || typeof value !== 'object') return { tag: null, completed: {}, lastSurvey: null };
  return {
    tag: typeof value.tag === 'string' ? value.tag : null,
    completed: value.completed && typeof value.completed === 'object' ? value.completed : {},
    lastSurvey: typeof value.lastSurvey === 'string' ? value.lastSurvey : null,
  };
}

export function writeProfile(patch) {
  const next = { ...readProfile(), ...patch };
  writeJSON(KEYS.profile, next);
  return next;
}

export function markCompleted(surveyId) {
  const profile = readProfile();
  writeProfile({ completed: { ...profile.completed, [surveyId]: { at: new Date().toISOString() } } });
}

export function isCompletedLocally(surveyId) {
  return Boolean(readProfile().completed?.[surveyId]);
}

/* --- Drafts ------------------------------------------------------------- */

/**
 * @typedef {object} Draft
 * @property {number} schemaVersion
 * @property {string} surveyId
 * @property {string|null} tag
 * @property {string} updatedAt
 * @property {string} pageId
 * @property {boolean} final
 * @property {boolean} synced
 * @property {Record<string, unknown>} answers
 * @property {Record<string, unknown>} presentation
 */

export function readDraft(surveyId) {
  const value = readJSON(KEYS.draft(surveyId), null);
  if (!value || typeof value !== 'object' || value.surveyId !== surveyId) return null;
  return value;
}

export function writeDraft(draft) {
  return writeJSON(KEYS.draft(draft.surveyId), draft);
}

export function clearDraft(surveyId) {
  remove(KEYS.draft(surveyId));
}
