/* ==========================================================================
   Shared UI bits: toasts, inline markdown, contact block, busy states.
   ========================================================================== */

import { t, loc } from './i18n.js';
import { el, escapeHtml, safeUrl } from './util.js';

/* --- Toasts ------------------------------------------------------------ */

let host = null;
let sequence = 0;

function ensureHost() {
  if (host && document.body.contains(host)) return host;
  host = el('div.toast-host', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
  document.body.appendChild(host);
  return host;
}

const ICONS = { ok: '✓', warn: '!', error: '✕', info: 'i' };

/**
 * Show a transient message.
 * @param {string} message
 * @param {{tone?: 'info'|'ok'|'warn'|'error', duration?: number}} [options]
 */
export function toast(message, { tone = 'info', duration = 4200 } = {}) {
  const node = el(
    'div.toast' + (tone !== 'info' ? `.toast--${tone}` : ''),
    { 'data-toast': String((sequence += 1)) },
    el('span.toast__icon', { 'aria-hidden': 'true' }, ICONS[tone] || ICONS.info),
    el('span', {}, message)
  );
  ensureHost().appendChild(node);
  requestAnimationFrame(() => node.classList.add('is-visible'));

  const remove = () => {
    node.classList.remove('is-visible');
    setTimeout(() => node.remove(), 260);
  };
  const timer = setTimeout(remove, duration);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
  return remove;
}

/* --- Inline markdown --------------------------------------------------- */

/**
 * Convert a very small subset of markdown to HTML.
 * Input is escaped first, so survey JSON can never inject markup.
 * Supports **bold**, *italic*, `code` and [text](url).
 */
export function inlineMarkdown(input) {
  let html = escapeHtml(input ?? '');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    const url = safeUrl(href);
    if (!url) return label;
    const external = /^https?:/i.test(url);
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${escapeHtml(url)}"${attrs}>${label}</a>`;
  });
  return html;
}

/**
 * Render author content (already localised) into a container as paragraphs,
 * bullet lists and small inline formatting.
 */
export function renderRich(value) {
  const fragment = document.createDocumentFragment();
  const text = loc(value);
  if (!text) return fragment;

  const blocks = String(text).split(/\n{2,}/);
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;

    if (/^[-•]\s+/m.test(block) && block.split('\n').every((line) => /^[-•]\s+/.test(line.trim()) || !line.trim())) {
      const list = el('ul');
      block.split('\n').forEach((line) => {
        const item = line.trim().replace(/^[-•]\s+/, '');
        if (item) list.appendChild(el('li', { html: inlineMarkdown(item) }));
      });
      fragment.appendChild(list);
      continue;
    }

    const lines = block.split('\n');
    if (lines.length > 1) {
      lines.forEach((line) => {
        if (line.trim()) fragment.appendChild(el('p', { html: inlineMarkdown(line.trim()) }));
      });
    } else {
      fragment.appendChild(el('p', { html: inlineMarkdown(block) }));
    }
  }
  return fragment;
}

/* --- Contact block ------------------------------------------------------ */

/**
 * @param {{name?: string, email?: string, phone?: Array<{label?: object, value: string, href?: string}>}} contact
 * @param {{heading?: string}} [options]
 */
export function renderContact(contact, { heading } = {}) {
  if (!contact) return null;
  const items = [];

  if (contact.email) {
    items.push(
      el(
        'li',
        {},
        el('a', { href: `mailto:${contact.email}` }, contact.email)
      )
    );
  }

  for (const phone of contact.phone || []) {
    const label = phone.label ? loc(phone.label) : '';
    const href = phone.href || `tel:${String(phone.value).replace(/[^\d+]/g, '')}`;
    items.push(
      el(
        'li',
        {},
        label ? `${label}: ` : '',
        el('a', { href }, phone.value)
      )
    );
  }

  return el(
    'div.contact',
    {},
    heading ? el('h3.contact__name', {}, heading) : contact.name ? el('p.contact__name', {}, contact.name) : null,
    el('ul.contact__lines', {}, ...items)
  );
}

/* --- Busy state --------------------------------------------------------- */

export function setBusy(button, busy, busyLabel) {
  if (!button) return;
  if (busy) {
    button.dataset.idleLabel = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (busyLabel) button.textContent = busyLabel;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.idleLabel) {
      button.textContent = button.dataset.idleLabel;
      delete button.dataset.idleLabel;
    }
  }
}

/** Move focus to the main heading after a page swap (screen-reader friendly). */
export function focusHeading(node) {
  if (!node) return;
  if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
  node.focus({ preventScroll: true });
}

export function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

export { t, loc };
