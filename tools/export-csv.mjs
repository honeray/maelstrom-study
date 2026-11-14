// Export response JSON files from a clone of the private data repository to CSV.
//
//   node tools/export-csv.mjs <path-to-maelstrom-study-data> [--out dist]
//
// Produces one CSV per survey (every answer key becomes a column), plus
// <survey>-submitted.csv containing only final submissions and participants.csv
// listing each tag with its completion status. Runs with no dependencies so it
// can be used anywhere Node is installed.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const [, , inputDir, ...flags] = process.argv;
if (!inputDir) {
  console.error('Usage: node tools/export-csv.mjs <path-to-maelstrom-study-data> [--out dist]');
  process.exit(1);
}

const outIndex = flags.indexOf('--out');
const outDir = path.resolve(outIndex >= 0 ? flags[outIndex + 1] : 'dist');
const dataDir = path.join(path.resolve(inputDir), 'data');

const META_COLUMNS = ['tag', 'surveyId', 'final', 'pageId', 'firstSeenAt', 'updatedAt', 'submittedAt', 'lang'];

async function listJson(dir) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listJson(full)));
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function cell(value) {
  if (value === undefined || value === null) return '';
  const text = Array.isArray(value) ? value.join('; ') : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows, columns) {
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) lines.push(columns.map((column) => cell(row[column])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

const files = await listJson(dataDir);
if (files.length === 0) {
  console.error(`No JSON files under ${dataDir}`);
  process.exit(1);
}

const records = [];
for (const file of files) {
  try {
    // Strip a UTF-8 BOM in case a file was edited by hand in Notepad.
    const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    const record = JSON.parse(text);
    if (!record?.surveyId || !record?.tag) continue;
    records.push(record);
  } catch (error) {
    console.warn(`skipping unreadable file: ${file} (${error.message})`);
  }
}

const bySurvey = new Map();
for (const record of records) {
  if (!bySurvey.has(record.surveyId)) bySurvey.set(record.surveyId, []);
  bySurvey.get(record.surveyId).push(record);
}

await mkdir(outDir, { recursive: true });

for (const [surveyId, rows] of [...bySurvey.entries()].sort()) {
  const answerKeys = new Set();
  for (const row of rows) for (const key of Object.keys(row.answers || {})) answerKeys.add(key);
  const columns = [...META_COLUMNS, ...[...answerKeys].sort()];

  const flat = rows.map((row) => ({
    tag: row.tag,
    surveyId: row.surveyId,
    final: row.final ? 'yes' : 'no',
    pageId: row.pageId,
    firstSeenAt: row.firstSeenAt,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt,
    lang: row.meta?.lang,
    ...(row.answers || {}),
  }));

  const allPath = path.join(outDir, `${surveyId}.csv`);
  await writeFile(allPath, toCsv(flat, columns), 'utf8');
  console.log(`${allPath}  (${flat.length} records, ${columns.length} columns)`);

  const submitted = flat.filter((row) => row.final === 'yes');
  if (submitted.length) {
    const submittedPath = path.join(outDir, `${surveyId}-submitted.csv`);
    await writeFile(submittedPath, toCsv(submitted, columns), 'utf8');
    console.log(`${submittedPath}  (${submitted.length} submitted)`);
  }
}

// One extra file that lists every tag and which rounds it has completed, which is
// what you need to invite the panel to the next round.
const tags = new Map();
for (const record of records) {
  if (!tags.has(record.tag)) tags.set(record.tag, { tag: record.tag });
  const row = tags.get(record.tag);
  row[`${record.surveyId}_final`] = record.final ? 'yes' : 'no';
  row[`${record.surveyId}_updatedAt`] = record.updatedAt;
}
const tagColumns = ['tag'];
for (const [surveyId] of [...bySurvey.entries()].sort()) {
  tagColumns.push(`${surveyId}_final`, `${surveyId}_updatedAt`);
}
const tagPath = path.join(outDir, 'participants.csv');
await writeFile(tagPath, toCsv([...tags.values()], tagColumns), 'utf8');
console.log(`${tagPath}  (${tags.size} participants)`);
