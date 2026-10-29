import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { readDatabase, writeJson } from '../src/data/store.js';
import { appendCollection, contentHash, parseSharedFile, parseCompanion, validateCompanionSource, type CompanionSource } from '../src/data/merge.js';
import { bankCoverage } from '../src/data/coverage.js';

const { values } = parseArgs({ options: {
  input: { type: 'string', multiple: true }, output: { type: 'string', default: 'data/seed.json' },
  'skip-companion': { type: 'boolean', default: false },
  'companion-report': { type: 'string', default: 'data/seed.sources.report.json' },
} });
const output = resolve(values.output!);
const database = await readDatabase(output);
const originalSnapshots = contentHash(JSON.stringify({ days: database.days, chapters: database.chapters }));
const report = {
  checkedAt: new Date().toISOString(), policy: 'Keep immutable source snapshots; exact normalized question/answer union. Official reveal > daily archive > shared file > companion; latest date breaks ties. Preserve all conflicting scores and notes.',
  before: bankCoverage(database), after: {} as ReturnType<typeof bankCoverage>,
  sources: [] as { source: string; status: 'imported' | 'skipped' | 'failed'; prompts?: number; answerRows?: number; error?: string }[],
  existingDailyAndChapterSnapshotsUnchanged: false, seedWritten: false,
};
for (const path of values.input ?? []) {
  const body = await readFile(path, 'utf8');
  const id = `shared-file:${contentHash(body)}`;
  if (database.collections?.[id]) { report.sources.push({ source: path, status: 'skipped' }); continue; }
  // Parse/validate the whole file before mutating the database or writing anything.
  const collection = parseSharedFile(body, relative(process.cwd(), resolve(path)).replaceAll('\\', '/'), report.checkedAt);
  appendCollection(database, collection);
  report.sources.push({ source: path, status: 'imported', prompts: collection.prompts.length,
    answerRows: collection.prompts.reduce((n, p) => n + p.answers.length, 0) });
  console.log(`Imported ${path}: ${collection.prompts.length} questions`);
}
let lastRequest = 0;
async function get(url: string) {
  await setTimeout(Math.max(0, 400 - (Date.now() - lastRequest)));
  lastRequest = Date.now();
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'User-Agent': 'KrillionBot-SeedImporter/0.1 (personal archive import)' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}
if (!values['skip-companion']) {
  const manifest = JSON.parse(await readFile(values['companion-report']!, 'utf8')) as { prompts: CompanionSource[] };
  if (!Array.isArray(manifest.prompts)) throw new Error('Invalid companion source report');
  // Validate all destinations before any requests; only known public answer URLs are accepted.
  manifest.prompts.forEach(validateCompanionSource);
  for (const source of manifest.prompts) {
    if (Object.values(database.collections ?? {}).some(c => c.sourceUrl === source.sourceUrl)) {
      report.sources.push({ source: source.sourceUrl, status: 'skipped' }); continue;
    }
    try {
      const html = await get(source.sourceUrl);
      const body = await get(source.answersUrl);
      const collection = parseCompanion(body, html, source, report.checkedAt);
      const added = appendCollection(database, collection);
      report.sources.push({ source: source.sourceUrl, status: added ? 'imported' : 'skipped',
        prompts: 1, answerRows: collection.prompts[0]!.answers.length });
      console.log(`${added ? 'Imported' : 'Skipped'} ${source.sourceUrl}`);
    } catch (error) {
      report.sources.push({ source: source.sourceUrl, status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
}
report.existingDailyAndChapterSnapshotsUnchanged = originalSnapshots === contentHash(JSON.stringify({ days: database.days, chapters: database.chapters }));
if (!report.existingDailyAndChapterSnapshotsUnchanged) throw new Error('Existing snapshots changed; refusing to write');
report.after = bankCoverage(database);
if (report.sources.some(source => source.status === 'imported')) {
  await writeJson(output, database);
  report.seedWritten = true;
}
await writeJson(output.replace(/\.json$/u, '') + '.merge.report.json', report, true);
console.log(JSON.stringify({ ...report, sources: { imported: report.sources.filter(s => s.status === 'imported').length,
  skipped: report.sources.filter(s => s.status === 'skipped').length, failed: report.sources.filter(s => s.status === 'failed') } }, null, 2));
if (report.sources.some(source => source.status === 'failed')) process.exitCode = 1;
