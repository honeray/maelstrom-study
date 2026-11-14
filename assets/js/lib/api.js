/* ==========================================================================
   Client for the Cloudflare Worker that persists responses.
   The browser never sees a GitHub token: it only ever talks to this small
   endpoint, which validates the payload and commits it server-side.
   ========================================================================== */

import { CONFIG } from '../config.js';

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'unknown' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** Network failures and 5xx are worth retrying; 4xx are not. */
  get retryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export function apiConfigured() {
  return Boolean(CONFIG.apiBase && /^https?:\/\//i.test(CONFIG.apiBase));
}

function url(path, params) {
  const base = CONFIG.apiBase.replace(/\/+$/, '');
  const target = new URL(`${base}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    }
  }
  return target.toString();
}

async function request(path, { method = 'GET', params, body, timeoutMs = CONFIG.requestTimeoutMs } = {}) {
  if (!apiConfigured()) {
    throw new ApiError('Response server is not configured', { code: 'not_configured' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url(path, params), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error?.name === 'AbortError';
    throw new ApiError(aborted ? 'Request timed out' : 'Network request failed', {
      status: 0,
      code: aborted ? 'timeout' : 'network',
    });
  }
  clearTimeout(timer);

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new ApiError(payload?.message || `Request failed (${response.status})`, {
      status: response.status,
      code: payload?.error || 'http_error',
    });
  }
  if (!payload || payload.ok !== true) {
    throw new ApiError(payload?.message || 'Unexpected response from the server', {
      status: response.status,
      code: payload?.error || 'bad_response',
    });
  }
  return payload;
}

/**
 * Persist a response record.
 * @param {{surveyId:string, tag:string, answers:object, presentation:object,
 *          pageId:string, final:boolean, meta?:object}} payload
 */
export async function saveResponse(payload) {
  return request('/v1/save', { method: 'POST', body: payload });
}

/**
 * Fetch the stored record for a tag.
 * @returns {Promise<object|null>} the record, or null when the tag is unknown
 */
export async function loadResponse(surveyId, tag) {
  const payload = await request('/v1/load', { params: { survey: surveyId, tag } });
  return payload.record ?? null;
}

/** Summarise every survey this tag has touched (used by the homepage resume box). */
export async function fetchStatus(tag) {
  const payload = await request('/v1/status', { params: { tag } });
  return payload.surveys ?? {};
}

let healthCache = null;

/** Cheap reachability probe so the UI can warn before a participant starts. */
export async function checkHealth({ timeoutMs = 6000 } = {}) {
  if (healthCache && Date.now() - healthCache.at < 60_000) return healthCache.ok;
  if (!apiConfigured()) {
    healthCache = { ok: false, at: Date.now() };
    return false;
  }
  try {
    await request('/v1/health', { timeoutMs });
    healthCache = { ok: true, at: Date.now() };
    return true;
  } catch {
    healthCache = { ok: false, at: Date.now() };
    return false;
  }
}

export function resetHealthCache() {
  healthCache = null;
}

/** Retry a call a few times while the error is transient. */
export async function withRetry(task, { attempts = 3, delayMs = 1200 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ApiError ? error.retryable : true;
      if (!retryable || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  throw lastError;
}
