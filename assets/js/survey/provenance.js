/* ==========================================================================
   Editing provenance.
   In edit mode every rendered string is tagged with the exact JSON location it
   came from, so the local editor (tools/editor) can turn a click into a precise
   value rather than a fuzzy text match. Nothing here runs unless the page was
   opened with ?edit=1, which only the editor does.
   ========================================================================== */

export const EDIT_MODE = (() => {
  try {
    return new URLSearchParams(window.location.search).has('edit');
  } catch {
    return false;
  }
})();

/** Build a `file#/pointer` reference from a block/page ref and a field path. */
export const refOf = (base, path) => (base && path ? `${base}/${path}` : null);

function mark(element, ref) {
  if (element && ref) element.setAttribute('data-loc', ref);
}

/** Options inside a `.branch` belong to the follow-up, not the first question. */
function optionLists(node) {
  const lists = Array.from(node.querySelectorAll('.opt-list'));
  return {
    main: lists.find((list) => !list.closest('.branch')) || null,
    follow: lists.find((list) => Boolean(list.closest('.branch'))) || null,
  };
}

function markOptions(list, ref, pathFor) {
  if (!list) return;
  Array.from(list.querySelectorAll('.opt')).forEach((option, index) => {
    mark(option.querySelector('.opt__label'), refOf(ref, pathFor(index, 'label')));
    const sub = option.querySelector('.opt__sub');
    if (sub) mark(sub, refOf(ref, pathFor(index, 'sub')));
  });
}

/**
 * Tag the elements of one rendered block with their source location.
 * @param {HTMLElement} node the element returned by the block renderer
 * @param {object} block the block definition (carries `_ref`)
 */
export function annotateBlock(node, block) {
  const ref = block && block._ref;
  if (!ref || !node || node.nodeType !== 1) return;

  switch (block.type) {
    case 'prose':
    case 'callout': {
      node.querySelectorAll('p, li').forEach((el) => mark(el, refOf(ref, 'text')));
      break;
    }
    case 'consent': {
      mark(node.querySelector('.consent__text'), refOf(ref, 'label'));
      break;
    }
    case 'linkBanner': {
      mark(node.querySelector('.link-banner__label'), refOf(ref, 'label'));
      mark(node.querySelector('.link-banner__note'), refOf(ref, 'note'));
      break;
    }
    case 'shortText':
    case 'longText': {
      mark(node.querySelector('.q__prompt'), refOf(ref, 'prompt'));
      mark(node.querySelector('.q__hint'), refOf(ref, 'hint'));
      break;
    }
    case 'singleChoice':
    case 'multiChoice': {
      mark(node.querySelector('.q__prompt'), refOf(ref, 'prompt'));
      mark(node.querySelector('.q__hint'), refOf(ref, 'hint'));
      const { main } = optionLists(node);
      markOptions(main, ref, (index, field) => `options/${index}/${field}`);
      break;
    }
    case 'branchScale': {
      mark(node.querySelector('.q__prompt'), refOf(ref, 'prompt'));
      mark(node.querySelector('.q__quote'), refOf(ref, 'statement'));
      const { main, follow } = optionLists(node);
      markOptions(main, ref, (index, field) => `options/${index}/${field}`);
      markOptions(follow, ref, (index, field) => `followUp/options/${index}/${field}`);
      mark(node.querySelector('.branch__prompt'), refOf(ref, 'followUp/prompt'));
      break;
    }
    case 'scenarioPair': {
      mark(node.querySelector('.scenario__card'), refOf(ref, block._display?.[0] || 'a'));
      mark(
        node.querySelectorAll('.scenario__card')[1],
        refOf(ref, block._display?.[1] || 'b')
      );
      const { follow } = optionLists(node);
      markOptions(follow, ref, (index, field) => `followUp/options/${index}/${field}`);
      mark(node.querySelector('.branch__prompt'), refOf(ref, 'followUp/prompt'));
      break;
    }
    default:
      break;
  }
}

/**
 * On the homepage the banner titles come from each survey file.
 * @param {HTMLElement} element
 * @param {string} file survey file path
 */
export function annotateSurveyTitle(element, file) {
  mark(element, file ? `${file}#/title` : null);
}
