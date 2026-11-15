/* ==========================================================================
   Renders one survey page into DOM and keeps its controls in sync with state.
   Blocks are rendered by type; every control writes straight back into
   SurveyState, so switching language or page can re-render without losing work.
   ========================================================================== */

import { t, loc } from '../lib/i18n.js';
import { el } from '../lib/util.js';
import { renderRich, renderContact, toast, inlineMarkdown } from '../lib/ui.js';
import { CONFIG } from '../config.js';
import { QUESTION_TYPES, blockRequiresAnswer } from './schema.js';
import { otherKey } from './state.js';
import { EDIT_MODE, annotateBlock } from './provenance.js';

/* --- Shell ------------------------------------------------------------- */

/**
 * @param {{page: object, state: import('./state.js').SurveyState, site: object,
 *          actions: Record<string, Function>, onChange: Function}} ctx
 */
export function renderPage(ctx) {
  const { page } = ctx;
  const container = el('div.page__blocks');
  const counter = { value: 0 };

  for (const block of page.blocks || []) {
    const isQuestion = QUESTION_TYPES.has(block.type);
    const index = isQuestion ? (counter.value += 1) : null;
    const node = renderBlock(block, ctx, index);
    if (node) {
      if (EDIT_MODE) annotateBlock(node, block);
      container.appendChild(node);
    }
  }

  return container;
}

function renderBlock(block, ctx, index) {
  switch (block.type) {
    case 'prose':
      return renderProse(block);
    case 'callout':
      return renderCallout(block);
    case 'contact':
      return renderContactBlock(block, ctx);
    case 'linkBanner':
      return renderLinkBanner(block);
    case 'consent':
      return renderConsent(block, ctx);
    case 'tagGenerate':
      return renderTagGenerate(block, ctx);
    case 'tagLookup':
      return renderTagLookup(block, ctx);
    case 'tagDisplay':
      return renderTagDisplay(block, ctx);
    case 'resumePrompt':
      return renderResumePrompt(block, ctx);
    case 'shortText':
    case 'longText':
      return renderText(block, ctx, index);
    case 'singleChoice':
      return renderSingleChoice(block, ctx, index);
    case 'multiChoice':
      return renderMultiChoice(block, ctx, index);
    case 'branchScale':
      return renderBranchScale(block, ctx, index);
    case 'scenarioPair':
      return renderScenarioPair(block, ctx, index);
    default:
      console.warn('[survey] unknown block type', block.type);
      return null;
  }
}

/* --- Presentational blocks --------------------------------------------- */

function renderProse(block) {
  return el(
    'div.prose' + (block.variant === 'muted' ? '.prose--muted' : ''),
    {},
    renderRich(block.text)
  );
}

function renderCallout(block) {
  const tone = block.tone || 'info';
  const icon = tone === 'warn' ? '!' : tone === 'danger' ? '✕' : 'i';
  return el(
    'div.callout' + (tone !== 'info' ? `.callout--${tone}` : '.callout--info'),
    {},
    el('span.callout__icon', { 'aria-hidden': 'true' }, icon),
    el(
      'div',
      {},
      block.title ? el('p', { html: `<strong>${inlineMarkdown(loc(block.title))}</strong>` }) : null,
      renderRich(block.text)
    )
  );
}

function renderContactBlock(block, ctx) {
  const contact = ctx.site?.contact;
  if (!contact) return null;
  return renderContact(contact, { heading: block.heading ? loc(block.heading) : undefined });
}

/**
 * A banner that links out to something the participant should read in a
 * separate tab — typically the previous round's summary report.
 */
const linkProbeCache = new Map();

function targetExists(href) {
  if (!linkProbeCache.has(href)) {
    linkProbeCache.set(
      href,
      fetch(href, { method: 'HEAD', cache: 'no-store' })
        .then((response) => response.ok)
        .catch(() => false)
    );
  }
  return linkProbeCache.get(href);
}

function renderLinkBanner(block) {
  const href = String(block.href || '').trim();
  if (!href) return null;

  const newTab = block.newTab !== false;
  const arrow = el('span.link-banner__arrow', { 'aria-hidden': 'true' }, '\u2197');

  const link = el(
    'a.link-banner',
    {
      href,
      target: newTab ? '_blank' : null,
      rel: newTab ? 'noopener noreferrer' : null,
    },
    el('span.link-banner__badge', { 'aria-hidden': 'true' }, block.format || 'PDF'),
    el(
      'span.link-banner__body',
      {},
      el('span.link-banner__label', {}, loc(block.label)),
      block.note ? el('span.link-banner__note', {}, loc(block.note)) : null
    ),
    arrow
  );

  // A relative target may not be published yet (reports are uploaded later).
  // Probe it so the page never offers a dead link; absolute URLs are left alone.
  if (!/^https?:/i.test(href)) {
    targetExists(href).then((exists) => {
      if (exists || !link.isConnected) return;
      link.removeAttribute('href');
      link.removeAttribute('target');
      link.removeAttribute('rel');
      link.classList.add('is-unavailable');
      link.setAttribute('aria-disabled', 'true');
      arrow.classList.add('link-banner__chip');
      arrow.removeAttribute('aria-hidden');
      arrow.textContent = t('survey.report.unavailable');
      // "Opens in a new tab" would be a promise the inert banner cannot keep.
      const note = link.querySelector('.link-banner__note');
      if (note) note.hidden = true;
    });
  }

  return link;
}

/* --- Question shell ----------------------------------------------------- */

/**
 * @param {object} block
 * @param {number|null} index
 * @param {{body: Node, hint?: Array, prompt: string|Node}} parts
 *
 * Whether the question is required comes from `blockRequiresAnswer`, the same
 * predicate the gating logic follows, so every question type — including any
 * added later — is labelled exactly as it behaves.
 */
function questionShell(block, index, { body, hint, prompt }) {
  const labelId = `label-${block.id}`;
  const numberText = index ? String(index).padStart(2, '0') : null;
  const required = blockRequiresAnswer(block);

  const promptNode = el('h3.q__prompt', { id: labelId });
  if (prompt instanceof Node) {
    promptNode.appendChild(prompt);
  } else {
    promptNode.appendChild(document.createTextNode(String(prompt ?? '')));
  }
  promptNode.appendChild(
    el(
      'span',
      { class: required ? 'q__required' : 'q__optional' },
      t(required ? 'common.required' : 'common.optional')
    )
  );

  const shell = el(
    'section.q' + (required ? '.q--required' : ''),
    { id: `q-${block.id}`, 'data-block': block.id, 'data-required': required ? 'true' : 'false' },
    el(
      'div.q__head',
      {},
      numberText ? el('span.q__num', { 'aria-hidden': 'true' }, numberText) : el('span.q__num'),
      el(
        'div',
        { style: { flex: '1', minWidth: '0' } },
        promptNode,
        hint ? el('p.q__hint', {}, ...hint) : null
      )
    ),
    el('div.q__body', {}, body),
    el(
      'p.q__error',
      { 'aria-live': 'polite' },
      el('span', { 'aria-hidden': 'true' }, '⚠'),
      el('span.q__error-text', {})
    )
  );

  // Screen-reader semantics to match the visible marker. Only the question's own
  // control is marked: the conditional follow-up inside .branch is required only
  // once an option that opens it is chosen.
  if (required) {
    const primaryGroup = shell.querySelector('.q__body .opt-list[role]');
    if (primaryGroup) primaryGroup.setAttribute('aria-required', 'true');
    const ownInput = shell.querySelector(`#input-${CSS.escape(block.id)}`);
    if (ownInput) ownInput.setAttribute('aria-required', 'true');
  }

  return shell;
}

/** Mark a block invalid and surface the message. */
export function showBlockError(blockId, message) {
  const shell = document.getElementById(`q-${blockId}`);
  if (!shell) return;
  shell.classList.add('is-invalid');
  const text = shell.querySelector('.q__error-text');
  if (text) text.textContent = message;
  shell.querySelectorAll('input, textarea').forEach((node) => node.setAttribute('aria-invalid', 'true'));
}

export function clearBlockError(blockId) {
  const shell = document.getElementById(`q-${blockId}`);
  if (!shell) return;
  shell.classList.remove('is-invalid');
  shell
    .querySelectorAll('[aria-invalid="true"]')
    .forEach((node) => node.removeAttribute('aria-invalid'));
}

export function clearAllErrors(root = document) {
  root.querySelectorAll('.q.is-invalid').forEach((shell) => shell.classList.remove('is-invalid'));
}

/* --- Option groups ------------------------------------------------------ */

/**
 * Build a radio/checkbox group bound to state.
 * @returns {{node: HTMLElement, refresh: Function}}
 */
function optionGroup(block, ctx, { multiple = false, labelId, name, inline = false }) {
  const group = el('div.opt-list' + (inline ? '.opt-list--inline' : ''), {
    role: multiple ? 'group' : 'radiogroup',
    'aria-labelledby': labelId,
  });

  const rows = [];

  for (const option of block.options || []) {
    const input = el('input', {
      type: multiple ? 'checkbox' : 'radio',
      name: multiple ? `${name}-${option.id}` : name,
      value: option.id,
    });

    const control = el('span.opt__control', { 'aria-hidden': 'true' });
    const labelText = el(
      'span.opt__label',
      {},
      loc(option.label),
      option.sub ? el('span.opt__sub', {}, loc(option.sub)) : null
    );

    const extra = option.allowText
      ? el(
          'span.opt__extra',
          {},
          el('input.input.input--inline', {
            type: 'text',
            placeholder: loc(option.placeholder) || t('common.pleaseSpecify'),
            'aria-label': loc(option.placeholder) || t('common.pleaseSpecify'),
            oninput: (event) => {
              ctx.state.setAnswer(otherKey(block.id), event.target.value);
              ctx.onChange(block.id);
            },
            onclick: (event) => event.stopPropagation(),
          })
        )
      : null;

    const label = el(
      'label.opt' + (multiple ? '.opt--multi' : ''),
      {},
      input,
      control,
      labelText,
      extra
    );

    input.addEventListener('change', () => {
      if (multiple) {
        ctx.state.toggleMulti(block, option.id, input.checked);
      } else {
        ctx.state.setBlockValue(block, option.id);
      }
      refresh();
      if (option.allowText && input.checked) {
        const field = extra?.querySelector('input');
        if (field) field.focus();
      }
      ctx.onChange(block.id);
    });

    rows.push({ option, input, label, extra });
    group.appendChild(label);
  }

  function refresh() {
    const value = ctx.state.getAnswer(block.id);
    for (const row of rows) {
      const checked = multiple
        ? Array.isArray(value) && value.includes(row.option.id)
        : value === row.option.id;

      row.input.checked = checked;
      row.label.classList.toggle('is-checked', checked);

      if (row.extra) {
        const field = row.extra.querySelector('input');
        if (field) field.value = ctx.state.getAnswer(otherKey(block.id)) || '';
      }
    }
  }

  refresh();
  return { node: group, refresh };
}

/* --- Text questions ----------------------------------------------------- */

function renderText(block, ctx, index) {
  const labelId = `label-${block.id}`;
  const long = block.type === 'longText';
  const value = ctx.state.getAnswer(block.id) || '';

  const input = el(long ? 'textarea' : 'input', {
    id: `input-${block.id}`,
    class: long ? `textarea${block.tall ? ' textarea--tall' : ''}` : 'input',
    type: long ? undefined : 'text',
    placeholder: loc(block.placeholder) || '',
    maxlength: block.maxLength || undefined,
    'aria-labelledby': labelId,
  });
  input.value = value;

  const counter = block.maxLength
    ? el('span.char-count', {}, `${String(value).length}/${block.maxLength}`)
    : null;

  input.addEventListener('input', () => {
    ctx.state.setAnswer(block.id, input.value);
    if (counter) counter.textContent = `${input.value.length}/${block.maxLength}`;
    ctx.onChange(block.id);
  });

  return questionShell(block, index, {
    body: el('div', {}, input, counter),
    prompt: loc(block.prompt),
    hint: block.hint ? [loc(block.hint)] : null,
  });
}

/* --- Choice questions --------------------------------------------------- */

function renderSingleChoice(block, ctx, index) {
  const labelId = `label-${block.id}`;
  const group = optionGroup(block, ctx, {
    multiple: false,
    labelId,
    name: `radio-${block.id}`,
    inline: block.layout === 'inline',
  });
  return questionShell(block, index, {
    body: group.node,
    prompt: loc(block.prompt),
    hint: block.hint ? [loc(block.hint)] : null,
  });
}

function renderMultiChoice(block, ctx, index) {
  const labelId = `label-${block.id}`;
  const group = optionGroup(block, ctx, {
    multiple: true,
    labelId,
    name: `check-${block.id}`,
    inline: block.layout === 'inline',
  });
  return questionShell(block, index, {
    body: group.node,
    prompt: loc(block.prompt),
    hint: block.hint ? [loc(block.hint)] : null,
  });
}

/* --- Branching scale ---------------------------------------------------- */

function renderBranchScale(block, ctx, index) {
  const labelId = `label-${block.id}`;
  const statement = block.statement ? el('blockquote.q__quote', {}, renderRich(block.statement)) : null;

  const first = optionGroup(block, ctx, {
    multiple: false,
    labelId,
    name: `scale-${block.id}`,
    inline: block.layout !== 'stack',
  });

  const extentLabelId = `label-${block.id}__extent`;
  const extent = optionGroup(
    { id: `${block.id}__extent`, options: block.followUp?.options || [] },
    ctx,
    { multiple: false, labelId: extentLabelId, name: `extent-${block.id}`, inline: true }
  );

  const branch = el(
    'div.branch',
    { hidden: true },
    el('p.branch__prompt', { id: extentLabelId }, loc(block.followUp?.prompt)),
    extent.node
  );

  function syncBranch() {
    const value = ctx.state.getAnswer(block.id);
    branch.hidden = !(block.followUp?.when || []).includes(value);
  }

  first.node.addEventListener('change', () => {
    // setBlockValue already clears the extent when it stops being relevant;
    // re-sync the control so a stale selection never stays visible.
    syncBranch();
    extent.refresh();
  });
  syncBranch();

  return questionShell(block, index, {
    body: el('div', {}, statement, first.node, branch),
    prompt: loc(block.prompt),
    hint: block.hint ? [loc(block.hint)] : null,
  });
}

/* --- Scenario pairs ----------------------------------------------------- */

function renderScenarioPair(block, ctx, index) {
  const labelId = `label-${block.id}`;
  // The two scenarios are shuffled per participant, but the letters are
  // POSITIONAL: the card on the left is always "A", the one on the right is
  // always "B". Otherwise a swapped pair would show "B" first, which reads as
  // if the pair had been reversed by mistake.
  const display = block._display || ['a', 'b'];
  const letters = ['A', 'B'];

  const pair = el(
    'div.scenario',
    {},
    ...display.map((side, position) =>
      el(
        'div.scenario__card',
        {},
        el('span.scenario__tag', { 'aria-hidden': 'true' }, letters[position]),
        el(
          'p.scenario__text',
          {},
          // Screen readers get the same "Contextual Scenario A: …" framing that
          // the answer options use, so the pairing is never ambiguous.
          el(
            'span.visually-hidden',
            {},
            `${t('survey.scenario.option', { letter: letters[position] })}: `
          ),
          loc(block[side])
        )
      )
    )
  );

  // The stored value is the CONTENT id ("a" / "b"), never the letter, so
  // randomisation can only move text between the A and B slots — it can never
  // change which scenario an answer refers to. `presentation.swapped[id]` records
  // whether the content in slot A is the pair's "a" or its "b".
  const choices = display.map((side, position) => ({
    id: side,
    label: t('survey.scenario.option', { letter: letters[position] }),
  }));
  choices.splice(1, 0, { id: 'neutral', label: t('survey.scenario.neutral') });

  // Carry the block type through: SurveyState.setBlockValue uses it to drop the
  // follow-up extent when the answer becomes "neutral". A bare {id, options}
  // object would silently keep a stale extent in the stored record.
  const group = optionGroup({ ...block, options: choices }, ctx, {
    multiple: false,
    labelId,
    name: `scenario-${block.id}`,
    inline: true,
  });

  const extentLabelId = `label-${block.id}__extent`;
  const extent = optionGroup(
    { id: `${block.id}__extent`, options: block.followUp?.options || [] },
    ctx,
    { multiple: false, labelId: extentLabelId, name: `extent-${block.id}`, inline: true }
  );

  const branch = el(
    'div.branch',
    { hidden: true },
    el('p.branch__prompt', { id: extentLabelId }, loc(block.followUp?.prompt)),
    extent.node
  );

  const commentId = `input-${block.id}__comment`;
  const commentArea = el('textarea.textarea', {
    id: commentId,
    placeholder: loc(block.commentPlaceholder) || t('survey.scenario.commentPlaceholder'),
    oninput: (event) => {
      ctx.state.setAnswer(`${block.id}__comment`, event.target.value);
      ctx.onChange(block.id);
    },
  });
  commentArea.value = ctx.state.getAnswer(`${block.id}__comment`) || '';

  const comment = el(
    'div',
    { style: { marginTop: '0.85rem' } },
    el('label.q__hint', { for: commentId }, t('survey.scenario.commentLabel')),
    commentArea
  );

  function syncBranch() {
    const value = ctx.state.getAnswer(block.id);
    branch.hidden = !value || value === 'neutral';
  }

  group.node.addEventListener('change', () => {
    syncBranch();
    extent.refresh();
  });
  syncBranch();

  return questionShell(block, index, {
    body: el('div', {}, pair, group.node, branch, comment),
    prompt: el('span.visually-hidden', {}, t('survey.scenario.prompt')),
  });
}

/* --- Tag blocks --------------------------------------------------------- */

function renderTagGenerate(block, ctx) {
  const value = el(
    'span.tag-card__value' + (ctx.state.tag ? '' : '.tag-card__value--empty'),
    { 'aria-live': 'polite' },
    ctx.state.tag || '••••••••'
  );

  const note = el('p.tag-card__note', { role: 'status', 'aria-live': 'polite', hidden: true });

  function showNote(copied) {
    note.hidden = false;
    note.textContent = copied ? t('survey.tag.copied') : t('survey.tag.copyManually');
    note.classList.toggle('tag-card__note--ok', copied);
    note.classList.toggle('tag-card__note--warn', !copied);
  }

  const copyButton = el(
    'button.btn.btn--ghost',
    {
      type: 'button',
      hidden: !ctx.state.tag,
      onclick: async () => {
        const copied = await ctx.actions.copyTag(ctx.state.tag);
        showNote(copied);
      },
    },
    t('survey.tag.copy')
  );

  const generateButton = el(
    'button.btn',
    { type: 'button' },
    t(ctx.state.tag ? 'survey.tag.regenerate' : 'survey.tag.generate')
  );

  generateButton.addEventListener('click', async () => {
    generateButton.disabled = true;
    try {
      const tag = await ctx.actions.generateTag();
      if (!tag) return;
      value.textContent = tag;
      value.classList.remove('tag-card__value--empty');
      copyButton.hidden = false;
      generateButton.textContent = t('survey.tag.regenerate');
      const copied = await ctx.actions.copyTag(tag);
      showNote(copied);
      ctx.state.dirty = true;
      ctx.onChange(block.id);
    } finally {
      generateButton.disabled = false;
    }
  });

  return el(
    'div.tag-card',
    { id: `q-${block.id}`, 'data-block': block.id },
    value,
    el('p.tag-card__hint', {}, t('survey.tag.cardHint')),
    note,
    el('div.tag-card__actions', {}, generateButton, copyButton),
    el(
      'p.q__error',
      { 'aria-live': 'polite' },
      el('span', { 'aria-hidden': 'true' }, '⚠'),
      el('span.q__error-text', {})
    )
  );
}

function renderTagLookup(block, ctx) {
  const input = el('input.tag-input', {
    id: `input-${block.id}`,
    type: 'text',
    autocomplete: 'off',
    spellcheck: false,
    maxlength: CONFIG.tagLength,
    placeholder: '••••••••',
    'aria-label': t('survey.tag.enterLabel'),
    oninput: (event) => {
      event.target.value = event.target.value
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, CONFIG.tagLength);
    },
  });

  const status = el('p.q__hint', { role: 'status', 'aria-live': 'polite' });
  const submit = el('button.btn', { type: 'submit' }, t('survey.tag.lookupButton'));

  const form = el(
    'form',
    {
      class: 'resume-inline__form',
      onsubmit: async (event) => {
        event.preventDefault();
        const tag = input.value.trim().toUpperCase();
        if (tag.length !== CONFIG.tagLength) {
          status.style.color = 'var(--danger)';
          status.textContent = t('survey.tag.invalid');
          input.focus();
          return;
        }
        submit.disabled = true;
        status.style.color = '';
        status.textContent = t('common.loading');
        try {
          const result = await ctx.actions.lookupTag(tag);
          if (result.ok) {
            status.style.color = 'var(--ok)';
            status.textContent = t('survey.tag.found');
            clearBlockError(block.id);
          } else {
            status.style.color = 'var(--danger)';
            status.textContent = result.message || t('survey.tag.notFound');
            if (result.allowBlank && block.allowSkip) blankButton.hidden = false;
          }
        } finally {
          submit.disabled = false;
        }
      },
    },
    input,
    submit
  );

  const blankButton = el(
    'button.btn.btn--ghost',
    {
      type: 'button',
      hidden: true,
      style: { marginTop: '0.6rem' },
      onclick: () => ctx.actions.skipLookup(),
    },
    t('survey.tag.blankOption')
  );

  return el(
    'div',
    { id: `q-${block.id}`, 'data-block': block.id },
    form,
    status,
    block.allowSkip ? blankButton : null,
    el(
      'p.q__error',
      { 'aria-live': 'polite' },
      el('span', { 'aria-hidden': 'true' }, '⚠'),
      el('span.q__error-text', {})
    )
  );
}

function renderTagDisplay(block, ctx) {
  return el(
    'div.tag-card',
    {},
    el('span.tag-card__value', {}, ctx.state.tag || '—'),
    el('p.tag-card__hint', {}, t('survey.tag.keepSafe'))
  );
}

function renderResumePrompt(block, ctx) {
  const input = el('input.tag-input', {
    type: 'text',
    autocomplete: 'off',
    spellcheck: false,
    maxlength: CONFIG.tagLength,
    placeholder: '••••••••',
    'aria-label': t('survey.tag.enterLabel'),
    oninput: (event) => {
      event.target.value = event.target.value
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, CONFIG.tagLength);
    },
  });
  const submit = el('button.btn.btn--ghost', { type: 'submit' }, t('survey.tag.resumeButton'));

  const form = el(
    'form',
    {
      class: 'resume-inline__form',
      onsubmit: (event) => {
        event.preventDefault();
        const tag = input.value.trim().toUpperCase();
        if (tag.length !== CONFIG.tagLength) {
          toast(t('survey.tag.invalid'), { tone: 'warn' });
          return;
        }
        ctx.actions.resumeWithTag(tag);
      },
    },
    input,
    submit
  );

  return el('div.resume-inline', {}, el('p.q__hint', {}, t('survey.tag.haveTag')), form);
}

/* --- Consent ------------------------------------------------------------ */

function renderConsent(block, ctx) {
  const input = el('input', { type: 'checkbox', name: block.id });
  const label = el(
    'label.consent',
    {},
    input,
    el('span.opt__control', { 'aria-hidden': 'true' }),
    el('span.consent__text', {}, loc(block.label))
  );

  function sync() {
    const checked = ctx.state.getAnswer(block.id) === true;
    input.checked = checked;
    label.classList.toggle('is-checked', checked);
  }

  input.addEventListener('change', () => {
    ctx.state.setAnswer(block.id, input.checked);
    sync();
    ctx.onChange(block.id);
  });

  sync();

  return el(
    'div',
    { id: `q-${block.id}`, 'data-block': block.id },
    label,
    el(
      'p.q__error',
      { 'aria-live': 'polite' },
      el('span', { 'aria-hidden': 'true' }, '⚠'),
      el('span.q__error-text', {})
    )
  );
}
