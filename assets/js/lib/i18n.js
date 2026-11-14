/* ==========================================================================
   Three-language UI layer.
   Interface strings live in /i18n/<lang>.json.
   Survey content is localised inline inside each survey JSON ({en, zh, fr}).
   ========================================================================== */

import { CONFIG } from '../config.js';
import { readLanguage, writeLanguage } from './storage.js';
import { el } from './util.js';

const SUPPORTED = CONFIG.languages.map((l) => l.code);
const CACHE = new Map();
let current = CONFIG.defaultLanguage;
let fallback = null;
let ready = false;

// Repository root, derived from this module's own URL so the site works at any
// base path (e.g. https://honeray.github.io/maelstrom-study/).
const basePath = new URL('../../../', import.meta.url);

async function fetchDictionary(code) {
  if (CACHE.has(code)) return CACHE.get(code);
  const target = new URL(`i18n/${code}.json`, basePath);
  const response = await fetch(target, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Missing dictionary for "${code}"`);
  const data = await response.json();
  CACHE.set(code, data);
  return data;
}

function detectInitialLanguage() {
  const stored = readLanguage();
  if (stored && SUPPORTED.includes(stored)) return stored;

  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('lang');
  if (fromQuery && SUPPORTED.includes(fromQuery)) return fromQuery;

  for (const candidate of navigator.languages || [navigator.language]) {
    const base = String(candidate).slice(0, 2).toLowerCase();
    if (SUPPORTED.includes(base)) return base;
  }
  return CONFIG.defaultLanguage;
}

/** Read a dotted path out of a dictionary object. */
function resolve(dictionary, key) {
  if (!dictionary) return undefined;
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), dictionary);
}

function interpolate(text, vars) {
  if (!vars) return text;
  return String(text).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

export function languages() {
  return CONFIG.languages;
}

export function currentLanguage() {
  return current;
}

/**
 * Load dictionaries and set the initial language.
 * english is always loaded as the fallback so a missing translation degrades
 * to English rather than showing raw keys.
 */
export async function initI18n(preferred) {
  const target = preferred && SUPPORTED.includes(preferred) ? preferred : detectInitialLanguage();
  const [fallbackDict, activeDict] = await Promise.all([
    fetchDictionary('en'),
    target === 'en' ? Promise.resolve(null) : fetchDictionary(target).catch(() => null),
  ]);
  fallback = fallbackDict;
  CACHE.set('en', fallbackDict);
  if (activeDict) CACHE.set(target, activeDict);
  current = activeDict ? target : 'en';
  ready = true;
  document.documentElement.lang = current;
  return current;
}

export function isI18nReady() {
  return ready;
}

/** Translate a UI string. */
export function t(key, vars) {
  const value =
    resolve(CACHE.get(current), key) ?? resolve(fallback, key) ?? resolve(CACHE.get('en'), key);
  if (value === undefined || value === null) {
    if (typeof console !== 'undefined') console.warn(`[i18n] missing key: ${key}`);
    return key;
  }
  return interpolate(value, vars);
}

/**
 * Localise an inline content value.
 * Accepts `{en, zh, fr}` objects as well as plain strings.
 */
export function loc(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => loc(item)).join('\n');
  if (typeof value === 'object') {
    const order = [current, 'en', ...SUPPORTED];
    for (const code of order) {
      const candidate = value[code];
      if (typeof candidate === 'string' && candidate.trim()) return candidate;
    }
    const first = Object.values(value).find((item) => typeof item === 'string' && item.trim());
    return first || '';
  }
  return String(value);
}

export function hasTranslation(value, code = current) {
  return Boolean(value && typeof value === 'object' && typeof value[code] === 'string' && value[code].trim());
}

/**
 * Switch language, persist it and notify the rest of the page.
 * Components listen for the `languagechange` event on document.
 */
export async function setLanguage(code) {
  if (!SUPPORTED.includes(code) || code === current) return current;
  try {
    await fetchDictionary(code);
  } catch {
    return current;
  }
  current = code;
  document.documentElement.lang = code;
  writeLanguage(code);
  applyStaticI18n(document);
  document.dispatchEvent(new CustomEvent('languagechange', { detail: { lang: code } }));
  return current;
}

/** Fill elements that declare `data-i18n*` attributes. */
export function applyStaticI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.getAttribute('data-i18n');
    node.textContent = t(key);
  });

  root.querySelectorAll('[data-i18n-attr]').forEach((node) => {
    // format: "placeholder:key|aria-label:other.key"
    node
      .getAttribute('data-i18n-attr')
      .split('|')
      .filter(Boolean)
      .forEach((pair) => {
        const [attribute, key] = pair.split(':').map((part) => part.trim());
        if (attribute && key) node.setAttribute(attribute, t(key));
      });
  });
}

/**
 * Render a language <select> into a container.
 * @param {HTMLElement} container
 * @param {{dark?: boolean}} [options]
 */
export function mountLanguageSelect(container, { dark = false } = {}) {
  const select = el(
    'select',
    {
      'aria-label': t('common.language'),
      onchange: (event) => setLanguage(event.target.value),
    },
    ...CONFIG.languages.map((language) =>
      el('option', { value: language.code, selected: language.code === current }, language.label)
    )
  );

  const wrapper = el(
    'div.lang' + (dark ? '.lang--dark' : ''),
    {},
    el('span.lang__label', { 'data-i18n': 'common.languageShort' }, t('common.languageShort')),
    select
  );

  container.textContent = '';
  container.appendChild(wrapper);

  const sync = () => {
    select.value = current;
    wrapper.querySelector('.lang__label').textContent = t('common.languageShort');
    select.setAttribute('aria-label', t('common.language'));
  };
  document.addEventListener('languagechange', sync);
  return wrapper;
}
