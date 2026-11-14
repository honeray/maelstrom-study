#!/usr/bin/env node
/**
 * Deployment doctor — explains why the published site is or is not reachable.
 *
 *   node tools/doctor.mjs
 *   GITHUB_TOKEN=github_pat_… node tools/doctor.mjs   # to inspect a private repo
 *   node tools/doctor.mjs --repo honeray/maelstrom-study
 *
 * Read-only: it inspects git, the GitHub API and the live URLs. Nothing is changed.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const OFF = '\u001b[0m';

const findings = [];
const ok = (title, detail) => findings.push({ status: 'ok', title, detail });
const warn = (title, detail, fix) => findings.push({ status: 'warn', title, detail, fix });
const fail = (title, detail, fix) => findings.push({ status: 'fail', title, detail, fix });

/* --- git ---------------------------------------------------------------- */

let gitProblem = null;

async function git(args) {
  if (gitProblem) return null;
  try {
    const { stdout } = await exec('git', args, { cwd: ROOT });
    return stdout.trim();
  } catch (error) {
    // ENOENT / EPERM here means git itself could not run, which is different
    // from a git command that legitimately exited non-zero.
    if (!error.stdout && ['ENOENT', 'EPERM', 'EACCES'].includes(error.code)) {
      gitProblem = `git could not be executed (${error.code})`;
    }
    return null;
  }
}

async function probeGit() {
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true' && !gitProblem) gitProblem = 'not a git working tree';
}

function parseGitHubRemote(url) {
  if (!url) return null;
  const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/* --- network ------------------------------------------------------------ */

async function github(pathname, token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'maelstrom-doctor',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com${pathname}`, { headers });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function httpStatus(url) {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    return response.status;
  } catch (error) {
    return `unreachable (${error.message})`;
  }
}

/* ------------------------------------------------------------------------ */

const args = process.argv.slice(2);
const repoFlagIndex = args.indexOf('--repo');
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const ansi = process.stdout.isTTY !== false;

const paint = (code, text) => (ansi ? `${code}${text}${OFF}` : text);

console.log(paint(BOLD, 'MAELStrOM deployment doctor'));
console.log(`${paint(DIM, new Date().toISOString())}\n`);

await probeGit();

/* 1. Remote and branch --------------------------------------------------- */

let target = null;

if (repoFlagIndex >= 0 && args[repoFlagIndex + 1]) {
  const [owner, repo] = args[repoFlagIndex + 1].split('/');
  target = { owner, repo };
  ok('repository (from --repo)', `${owner}/${repo}`);
} else if (gitProblem) {
  warn('git unavailable', gitProblem, 'Run this in a normal terminal, or pass --repo owner/name.');
} else {
  const remoteUrl = await git(['remote', 'get-url', 'origin']);
  if (!remoteUrl) {
    fail(
      'no git remote called "origin"',
      'This checkout has no origin, so it has never been pushed anywhere.',
      'git remote add origin https://github.com/<owner>/maelstrom-study.git'
    );
  } else {
    target = parseGitHubRemote(remoteUrl);
    if (!target) {
      fail('origin is not a GitHub URL', remoteUrl, 'Point it at https://github.com/<owner>/maelstrom-study.git');
    } else {
      ok('remote', `${target.owner}/${target.repo}`);
      console.log(`${paint(DIM, `   ${remoteUrl}`)}\n`);
    }
  }
}

let branch = null;
if (!gitProblem) {
  branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'main') {
    ok('current branch', 'main');
  } else if (branch) {
    warn('current branch is not "main"', `on "${branch}"`, 'git branch -M main');
  }

  if (branch) {
    const upstream = await git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`]);
    if (!upstream) {
      warn(
        'this clone has no record of a successful push',
        `refs/remotes/origin/${branch} does not exist, so nothing was ever pushed from this checkout ` +
          '(or it was pushed from a different copy).',
        [
          'Run the push and read the output carefully:',
          '  git push -u origin main',
          '"remote: Repository not found" means the repository does not exist yet.',
          '"Authentication failed" means the credential helper is not set up.',
        ].join('\n')
      );
    } else {
      ok('pushed at least once', `origin/${branch} exists locally`);
    }
  }
}

/* 2. Repository visibility and Pages ------------------------------------- */

let pagesUrl = null;

if (target) {
  const { owner, repo } = target;
  const result = await github(`/repos/${owner}/${repo}`, token);

  if (result.status === 404) {
    // GitHub answers 404 both for private repositories and for missing ones, so
    // this single status covers two very different situations.
    fail(
      'repository is not publicly visible',
      'GitHub answers 404. It does not exist under that name, or it is private.',
      [
        'Check in a signed-out browser window:',
        `  https://github.com/${owner}/${repo}`,
        'If that 404s too: create the repository as PUBLIC, or make the existing one public.',
        `  gh repo create ${owner}/${repo} --public --source=. --remote=origin --push`,
        `  gh repo edit ${owner}/${repo} --visibility public --accept-visibility-change-consequences`,
        'A private repository cannot publish Pages on GitHub Free.',
      ].join('\n')
    );
  } else if (result.status === 401 || result.status === 403) {
    warn('token rejected', `GitHub returned ${result.status}`, 'Unset GITHUB_TOKEN and retry, or use a token with read access.');
  } else if (result.status !== 200) {
    warn('could not query the repository', `GitHub returned ${result.status}`, 'Retry in a moment.');
  } else {
    const {
      visibility,
      has_pages: hasPages,
      default_branch: defaultBranch,
      private: isPrivate,
      homepage,
    } = result.body;

    pagesUrl = homepage && /^https?:/.test(homepage) ? homepage : `https://${owner}.github.io/${repo}/`;

    if (isPrivate) {
      fail(
        'repository is PRIVATE',
        `visibility: ${visibility}`,
        [
          'GitHub Free publishes Pages only from public repositories.',
          'The site holds no participant data (that lives in maelstrom-study-data), so public is safe:',
          `  gh repo edit ${owner}/${repo} --visibility public --accept-visibility-change-consequences`,
          'Or use GitHub Pro (free with the Student Developer Pack) / Team.',
        ].join('\n')
      );
    } else {
      ok('repository is public', `visibility: ${visibility}`);
    }

    if (defaultBranch && branch && defaultBranch !== branch) {
      fail(
        'default branch does not match your working branch',
        `repository default: ${defaultBranch}, you are on: ${branch}`,
        `Push ${branch} and change the default branch, or publish from ${defaultBranch}.`
      );
    }

    if (!hasPages) {
      fail(
        'GitHub Pages is not enabled',
        'has_pages: false — a successful git push never publishes a site by itself.',
        [
          `Open https://github.com/${owner}/${repo}/settings/pages`,
          'Source: Deploy from a branch → Branch: main → folder: / (root) → Save.',
          'Then watch the "pages build and deployment" run under the Actions tab.',
        ].join('\n')
      );
    } else {
      ok('GitHub Pages is enabled', 'has_pages: true');
    }
  }
}

/* 3. Does the site answer? ----------------------------------------------- */

if (pagesUrl) {
  const status = await httpStatus(pagesUrl);
  if (status === 200) {
    ok('site responds', `${pagesUrl} → HTTP 200`);
  } else if (status === 404) {
    fail(
      'site URL returns 404',
      `${pagesUrl} → "There isn't a GitHub Pages site here."`,
      'This is the classic symptom of an unenabled or private Pages site. Fix the ✕ items above, then allow 1–2 minutes.'
    );
  } else {
    warn('site URL did not return 200', `${pagesUrl} → HTTP ${status}`, 'Retry shortly; the first deployment can take a couple of minutes.');
  }
}

/* 4. Repository content --------------------------------------------------- */

if (gitProblem) {
  warn('repository content checks skipped', gitProblem, 'Run `npm run doctor` in a normal terminal to include them.');
} else {
  const nojekyll = await git(['ls-files', '--error-unmatch', '.nojekyll']);
  if (nojekyll) ok('.nojekyll is tracked', 'Jekyll will not interfere');
  else fail('.nojekyll is missing from git', 'GitHub may run Jekyll', 'git add .nojekyll && git commit && git push');

  const indexTracked = await git(['ls-files', '--error-unmatch', 'index.html']);
  if (indexTracked) ok('index.html is tracked', 'served from the repository root');
  else fail('index.html is missing from git', 'Pages has no entry point', 'git add index.html && git commit && git push');
}

/* 5. Response server ------------------------------------------------------ */

let apiBase = '';
try {
  const config = await readFile(path.join(ROOT, 'assets/js/config.js'), 'utf8');
  apiBase = (/apiBase:\s*['"]([^'"]*)['"]/.exec(config) || [])[1] || '';
} catch {
  /* ignore */
}

if (!apiBase) {
  warn(
    'response server not configured',
    'apiBase is empty, so answers stay in the participant browser',
    'Set apiBase in assets/js/config.js (docs/DEPLOY.md step 5) before sharing the survey link.'
  );
} else {
  const health = await httpStatus(`${apiBase.replace(/\/+$/, '')}/v1/health`);
  if (health === 200) ok('response server reachable', `${apiBase}/v1/health → HTTP 200`);
  else fail('response server unreachable', `${apiBase}/v1/health → ${health}`, 'Run `npx wrangler tail` in worker/.');
}

/* ------------------------------------------------------------------------ */

console.log('');
for (const finding of findings) {
  const symbol =
    finding.status === 'ok'
      ? paint(GREEN, '✓')
      : finding.status === 'warn'
        ? paint(YELLOW, '!')
        : paint(RED, '✕');
  console.log(`${symbol} ${paint(BOLD, finding.title)}`);
  if (finding.detail) console.log(`   ${paint(DIM, finding.detail)}`);
  if (finding.fix) {
    for (const line of finding.fix.split('\n')) console.log(`   ${line}`);
  }
  console.log('');
}

const failures = findings.filter((finding) => finding.status === 'fail');
const warnings = findings.filter((finding) => finding.status === 'warn');

if (failures.length) {
  console.log(`${paint(RED + BOLD, `${failures.length} blocking problem(s)`)} — start with the first ✕ above.\n`);
  process.exitCode = 1;
} else if (warnings.length) {
  console.log(`${paint(YELLOW + BOLD, `${warnings.length} warning(s)`)} — see above.\n`);
  process.exitCode = 0;
} else {
  console.log(`${paint(GREEN + BOLD, 'Everything checks out.')}\n`);
  process.exitCode = 0;
}
