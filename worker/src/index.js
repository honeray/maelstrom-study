/**
 * MAELStrOM response collector
 * ---------------------------------------------------------------------------
 * A deliberately small API that sits between the static GitHub Pages site and
 * a PRIVATE GitHub repository that stores the responses.
 *
 * The browser never holds a GitHub token. It only talks to this worker, which
 *
 *   1. validates the payload (survey id, tag format, size, rate limit),
 *   2. writes it to Workers KV immediately so nothing is ever lost,
 *   3. commits it to the private data repository on a 2-minute cron, and
 *      immediately when a participant submits a final response.
 *
 * Endpoints
 *   GET  /v1/health                       -> { ok, service, time }
 *   POST /v1/save                         -> { ok, updatedAt, committed }
 *   GET  /v1/load?survey=<id>&tag=<tag>   -> { ok, record | null }
 *   GET  /v1/status?tag=<tag>             -> { ok, surveys: { id: {...} } }
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const TAG_RE = /^[A-Z0-9]{8}$/;
const SURVEY_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;
const MAX_ANSWERS = 400;
const MAX_TEXT = 8000;
const MAX_BODY_BYTES = 96 * 1024;

/* --- Helpers ------------------------------------------------------------- */

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const headers = {
    vary: 'Origin',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };

  if (!origin) return headers;
  if (allowed.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
  }
  return headers;
}

function originAllowed(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return true; // same-origin fetches and curl during setup
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Reject prototype-polluting keys before anything is stored. */
function sanitiseKey(key) {
  return key !== '__proto__' && key !== 'prototype' && key !== 'constructor';
}

function sanitiseAnswers(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: 'answers_invalid' };
  const entries = Object.entries(raw);
  if (entries.length > MAX_ANSWERS) return { ok: false, error: 'answers_too_many' };

  const out = {};
  for (const [key, value] of entries) {
    if (!sanitiseKey(key) || key.length > 120) return { ok: false, error: 'answer_key_invalid' };

    if (typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'string') {
      if (value.length > MAX_TEXT) return { ok: false, error: 'answer_too_long' };
      out[key] = value;
    } else if (Array.isArray(value)) {
      if (value.length > 80) return { ok: false, error: 'answer_array_too_long' };
      out[key] = value.map((item) => String(item).slice(0, 200));
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (value === null) {
      continue;
    } else {
      return { ok: false, error: 'answer_type_invalid' };
    }
  }
  return { ok: true, answers: out };
}

function sanitisePresentation(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!sanitiseKey(key) || key.length > 80) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 200);
    else if (isPlainObject(value)) {
      const order = Array.isArray(value.order) ? value.order.slice(0, 80).map(String) : [];
      const swapped = {};
      if (isPlainObject(value.swapped)) {
        for (const [id, flag] of Object.entries(value.swapped)) {
          if (sanitiseKey(id) && id.length <= 80) swapped[id] = Boolean(flag);
        }
      }
      out[key] = { order, swapped };
    }
  }
  return out;
}

function sanitiseBaseline(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    surveyId: typeof raw.surveyId === 'string' ? raw.surveyId.slice(0, 64) : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : null,
    missing: Boolean(raw.missing),
  };
}

function sanitiseMeta(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const key of ['lang', 'tz']) {
    if (typeof raw[key] === 'string') out[key] = raw[key].slice(0, 64);
  }
  return out;
}

function surveyAllowed(surveyId, env) {
  const list = String(env.SURVEYS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return list.length === 0 ? SURVEY_RE.test(surveyId) : list.includes(surveyId);
}

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* --- Rate limiting ------------------------------------------------------- */

async function rateLimited(request, env) {
  const limit = Number(env.RATE_LIMIT_PER_MINUTE || 90);
  if (!limit) return false;

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = Math.floor(Date.now() / 60_000);
  const key = `rl:${ip}:${bucket}`;

  const current = Number((await env.MAELSTROM_KV.get(key)) || '0');
  if (current >= limit) return true;

  await env.MAELSTROM_KV.put(key, String(current + 1), { expirationTtl: 120 });
  return false;
}

/* --- GitHub storage ------------------------------------------------------ */

function githubHeaders(env) {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'maelstrom-response-collector',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  };
}

function dataRepo(env) {
  return String(env.DATA_REPO || '').trim();
}

function dataBranch(env) {
  return String(env.GIT_BRANCH || 'main').trim();
}

/** Create or update one file in the private data repository. */
async function commitFile(env, path, content, message) {
  const repo = dataRepo(env);
  if (!repo || !env.GITHUB_TOKEN) throw new Error('data_repo_not_configured');

  const branch = dataBranch(env);
  const base = `https://api.github.com/repos/${repo}/contents/${path}`;

  let sha;
  const head = await fetch(`${base}?ref=${encodeURIComponent(branch)}`, {
    headers: githubHeaders(env),
  });
  if (head.ok) {
    const existing = await head.json();
    sha = existing.sha;
  } else if (head.status !== 404) {
    throw new Error(`github_lookup_failed_${head.status}`);
  }

  const payload = {
    message,
    content: base64Utf8(content),
    branch,
    committer: {
      name: env.GIT_COMMITTER_NAME || 'MAELStrOM Collector',
      email: env.GIT_COMMITTER_EMAIL || 'collector@users.noreply.github.com',
    },
  };
  if (sha) payload.sha = sha;

  const response = await fetch(base, {
    method: 'PUT',
    headers: githubHeaders(env),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`github_write_failed_${response.status}:${detail.slice(0, 200)}`);
  }
  return response.json();
}

function recordPath(surveyId, tag) {
  return `data/${surveyId}/${tag}.json`;
}

function snapshotPath(surveyId, tag) {
  return `data/${surveyId}/submitted/${tag}.json`;
}

/** Write a record (and its submission snapshot) to the data repository. */
async function persistRecord(env, record) {
  const body = JSON.stringify(record, null, 2);
  await commitFile(
    env,
    recordPath(record.surveyId, record.tag),
    body,
    `response: ${record.surveyId} ${record.tag}${record.final ? ' (final)' : ''}`
  );

  if (record.final) {
    await commitFile(
      env,
      snapshotPath(record.surveyId, record.tag),
      body,
      `submission: ${record.surveyId} ${record.tag}`
    );
  }
}

/** Commit every record that has changed since the last cron run. */
async function flushDirty(env, limit = 25) {
  const repo = dataRepo(env);
  if (!repo || !env.GITHUB_TOKEN) return { flushed: 0 };

  const listed = await env.MAELSTROM_KV.list({ prefix: 'dirty:', limit });
  let flushed = 0;

  for (const key of listed.keys) {
    const [, surveyId, tag] = key.name.split(':');
    if (!surveyId || !tag) continue;

    const raw = await env.MAELSTROM_KV.get(`rec:${surveyId}:${tag}`);
    if (!raw) {
      await env.MAELSTROM_KV.delete(key.name);
      continue;
    }

    try {
      await persistRecord(env, JSON.parse(raw));
      await env.MAELSTROM_KV.delete(key.name);
      flushed += 1;
    } catch (error) {
      console.error('[flush] failed', key.name, error.message);
    }

    // Stay well inside GitHub's secondary rate limits.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return { flushed };
}

/* --- Handlers ------------------------------------------------------------ */

async function handleSave(request, env) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) return json({ ok: false, error: 'body_too_large' }, 413);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body_invalid' }, 400);
  }
  if (!isPlainObject(body)) return json({ ok: false, error: 'body_invalid' }, 400);

  const surveyId = String(body.surveyId || '').trim();
  const tag = String(body.tag || '')
    .trim()
    .toUpperCase();

  if (!SURVEY_RE.test(surveyId) || !surveyAllowed(surveyId, env)) {
    return json({ ok: false, error: 'survey_unknown', message: 'Unknown survey' }, 400);
  }
  if (!TAG_RE.test(tag)) {
    return json({ ok: false, error: 'tag_invalid', message: 'Tags are 8 characters A-Z0-9' }, 400);
  }

  const answers = sanitiseAnswers(body.answers);
  if (!answers.ok) {
    return json({ ok: false, error: answers.error, message: 'Answer payload rejected' }, 400);
  }

  if (await rateLimited(request, env)) {
    return json({ ok: false, error: 'rate_limited', message: 'Too many requests' }, 429);
  }

  const key = `rec:${surveyId}:${tag}`;
  const previousRaw = await env.MAELSTROM_KV.get(key);
  let previous = null;
  try {
    previous = previousRaw ? JSON.parse(previousRaw) : null;
  } catch {
    previous = null;
  }

  const now = new Date().toISOString();
  const final = Boolean(body.final) || Boolean(previous?.final);

  const record = {
    surveyId,
    tag,
    final,
    pageId: typeof body.pageId === 'string' ? body.pageId.slice(0, 64) : null,
    firstSeenAt: previous?.firstSeenAt || now,
    updatedAt: now,
    submittedAt: final ? previous?.submittedAt || now : null,
    answers: answers.answers,
    presentation: sanitisePresentation(body.presentation),
    baseline: sanitiseBaseline(body.baseline),
    meta: sanitiseMeta(body.meta),
    schemaVersion: Number(body.schemaVersion) || 1,
  };

  const serialised = JSON.stringify(record);
  if (serialised.length > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'record_too_large' }, 413);
  }

  // 1. Durable store of record.
  await env.MAELSTROM_KV.put(key, serialised);

  // 2. Per-tag index so the homepage can look up state cheaply.
  const liveKey = `live:${tag}`;
  const liveRaw = await env.MAELSTROM_KV.get(liveKey);
  let live = {};
  try {
    live = liveRaw ? JSON.parse(liveRaw) : {};
  } catch {
    live = {};
  }
  live[surveyId] = {
    final,
    updatedAt: now,
    pageId: record.pageId,
  };
  await env.MAELSTROM_KV.put(liveKey, JSON.stringify(live));

  // 3. Push to git now when it matters, otherwise let the cron batch it.
  let committed = false;
  if (final) {
    try {
      await persistRecord(env, record);
      committed = true;
    } catch (error) {
      console.error('[save] immediate commit failed', error.message);
      await env.MAELSTROM_KV.put(`dirty:${surveyId}:${tag}`, now);
    }
  } else {
    await env.MAELSTROM_KV.put(`dirty:${surveyId}:${tag}`, now);
  }

  return json({ ok: true, updatedAt: now, committed });
}

async function handleLoad(request, env) {
  const url = new URL(request.url);
  const surveyId = String(url.searchParams.get('survey') || '').trim();
  const tag = String(url.searchParams.get('tag') || '')
    .trim()
    .toUpperCase();

  if (!SURVEY_RE.test(surveyId) || !surveyAllowed(surveyId, env)) {
    return json({ ok: false, error: 'survey_unknown' }, 400);
  }
  if (!TAG_RE.test(tag)) return json({ ok: false, error: 'tag_invalid' }, 400);

  if (await rateLimited(request, env)) {
    return json({ ok: false, error: 'rate_limited' }, 429);
  }

  const raw = await env.MAELSTROM_KV.get(`rec:${surveyId}:${tag}`);
  if (!raw) return json({ ok: true, record: null });
  return json({ ok: true, record: JSON.parse(raw) });
}

async function handleStatus(request, env) {
  const url = new URL(request.url);
  const tag = String(url.searchParams.get('tag') || '')
    .trim()
    .toUpperCase();
  if (!TAG_RE.test(tag)) return json({ ok: false, error: 'tag_invalid' }, 400);

  if (await rateLimited(request, env)) {
    return json({ ok: false, error: 'rate_limited' }, 429);
  }

  const raw = await env.MAELSTROM_KV.get(`live:${tag}`);
  if (!raw) return json({ ok: true, surveys: {} });
  return json({ ok: true, surveys: JSON.parse(raw) });
}

/* --- Entry point --------------------------------------------------------- */

export default {
  async fetch(request, env, ctx) {
    const headers = corsHeaders(request, env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (!originAllowed(request, env)) {
      return json({ ok: false, error: 'origin_not_allowed' }, 403, headers);
    }

    try {
      if (url.pathname === '/v1/health' && request.method === 'GET') {
        return json(
          { ok: true, service: 'maelstrom-collector', time: new Date().toISOString() },
          200,
          headers
        );
      }

      if (url.pathname === '/v1/save' && request.method === 'POST') {
        return withCors(await handleSave(request, env), headers);
      }

      if (url.pathname === '/v1/load' && request.method === 'GET') {
        return withCors(await handleLoad(request, env), headers);
      }

      if (url.pathname === '/v1/status' && request.method === 'GET') {
        return withCors(await handleStatus(request, env), headers);
      }

      // Manual flush for the maintainer: /v1/flush?token=<ADMIN_TOKEN>
      if (url.pathname === '/v1/flush' && request.method === 'GET') {
        const token = url.searchParams.get('token') || '';
        if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
          return json({ ok: false, error: 'forbidden' }, 403, headers);
        }
        const result = await flushDirty(env, 60);
        return json({ ok: true, ...result }, 200, headers);
      }

      return json({ ok: false, error: 'not_found' }, 404, headers);
    } catch (error) {
      console.error('[worker]', error.stack || error.message);
      return json({ ok: false, error: 'server_error' }, 500, headers);
    }
  },

  async scheduled(controller, env, ctx) {
    const task = flushDirty(env).catch((error) => {
      console.error('[cron]', error.stack || error.message);
    });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
    else await task;
  },
};

function withCors(response, headers) {
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(response.body, { status: response.status, headers: merged });
}
