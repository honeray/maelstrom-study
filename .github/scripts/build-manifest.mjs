#!/usr/bin/env node
/**
 * Rebuilds reports/manifest.json from whatever is in reports/.
 *
 * The homepage reads this manifest, so publishing a new summary report is just:
 *   1. drop the PDF (or DOCX, CSV, ...) into reports/
 *   2. commit and push
 *
 * Titles are taken from reports/catalog.json when present; otherwise they are
 * derived from the filename. The script is a no-op when nothing changed, which
 * keeps the GitHub Action from committing in a loop.
 *
 * Usage: node .github/scripts/build-manifest.mjs [--check]
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const ROOT = process.cwd();
const REPORTS_DIR = path.join(ROOT, 'reports');
const MANIFEST = path.join(REPORTS_DIR, 'manifest.json');
const CATALOG = path.join(REPORTS_DIR, 'catalog.json');
const IGNORED = new Set(['manifest.json', 'catalog.json', '.gitkeep']);

async function walk(dir, base = '') {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walk(path.join(dir, entry.name), rel)));
    } else if (!IGNORED.has(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

async function lastCommitDate(relativePath) {
  try {
    const { stdout } = await exec('git', ['log', '-1', '--format=%cI', '--', `reports/${relativePath}`], {
      cwd: ROOT,
    });
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

function titleFromName(name) {
  const stem = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return stem.replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

async function readCatalog() {
  try {
    const raw = await readFile(CATALOG, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.files) ? parsed.files : [];
  } catch {
    return [];
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const catalog = await readCatalog();
  const byName = new Map(catalog.filter((item) => item?.name).map((item) => [item.name, item]));

  const files = await walk(REPORTS_DIR);
  const entries = [];

  for (const relative of files) {
    const full = path.join(REPORTS_DIR, relative);
    const info = await stat(full);
    const name = path.basename(relative);
    const ext = path.extname(name).slice(1).toLowerCase();
    const meta = byName.get(relative) || byName.get(name) || {};

    entries.push({
      name,
      path: `reports/${relative}`,
      title: meta.title || titleFromName(name),
      description: meta.description || '',
      ext,
      size: info.size,
      updated: (await lastCommitDate(relative)) || info.mtime.toISOString(),
      order: Number.isFinite(meta.order) ? meta.order : 100,
    });
  }

  entries.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return String(b.updated).localeCompare(String(a.updated)) || a.name.localeCompare(b.name);
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    count: entries.length,
    files: entries.map(({ order, ...rest }) => rest),
  };

  let previous = null;
  try {
    previous = JSON.parse(await readFile(MANIFEST, 'utf8'));
  } catch {
    previous = null;
  }

  const changed =
    !previous ||
    JSON.stringify(previous.files) !== JSON.stringify(manifest.files) ||
    previous.count !== manifest.count;

  if (check) {
    if (changed) {
      console.error('reports/manifest.json is out of date. Run: node .github/scripts/build-manifest.mjs');
      process.exit(1);
    }
    console.log('reports/manifest.json is up to date.');
    return;
  }

  if (!changed) {
    console.log('No change to reports/manifest.json.');
    return;
  }

  // Keep the previous generatedAt when only re-running for cosmetic reasons.
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Wrote reports/manifest.json (${entries.length} file(s)).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
