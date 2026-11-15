/* ==========================================================================
   Site configuration.
   This is the only file you normally need to touch when deploying.
   ========================================================================== */

export const CONFIG = Object.freeze({
  /**
   * Base URL of the Cloudflare Worker that stores responses.
   * Leave empty to run the site in "local only" mode (useful for previewing);
   * responses are then kept in the participant's browser and the site shows a
   * warning strip. Set this before sharing the survey link.
   * Example: 'https://maelstrom-api.your-subdomain.workers.dev'
   */
  apiBase: 'https://workers.project-maelstrom.com',

  /** How often dirty drafts are pushed to the server (the outline asks for 10s). */
  syncIntervalMs: 10_000,

  /** Network timeout for a single API call. */
  requestTimeoutMs: 15_000,

  /** Responses are ALSO kept in localStorage at this cadence, regardless of the network. */
  localSaveDelayMs: 400,

  /** Key prefix for everything this site stores in localStorage. */
  storagePrefix: 'maelstrom',

  /** Supported languages. `label` is deliberately not translated. */
  languages: Object.freeze([
    { code: 'en', label: 'English', short: 'EN' },
    { code: 'zh', label: '中文', short: '中文' },
    { code: 'fr', label: 'Français', short: 'FR' },
  ]),

  defaultLanguage: 'en',

  /** Participant tag: 8 characters, no I/O/0/1 to avoid transcription errors. */
  tagLength: 8,
  tagAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',

  /** Bump when the storage format changes. */
  schemaVersion: 1,
});
