import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import { readDatabase, writeJson } from '../src/data/store.js';
import { PACKS, updatePacks } from '../src/data/packs.js';
import type { SeedPack } from '../src/data/types.js';

const { values } = parseArgs({ options: {
  output: { type: 'string', default: 'data/seed.json' },
  pack: { type: 'string', multiple: true },
} });
const packs = values.pack ?? PACKS;
if (packs.some(pack => !PACKS.includes(pack as SeedPack))) throw new Error(`Valid packs: ${PACKS.join(', ')}`);
const output = resolve(values.output!);
const database = await readDatabase(output);
let lastRequest = 0;
const report = await updatePacks(database, async url => {
  await setTimeout(Math.max(0, 400 - (Date.now() - lastRequest)));
  lastRequest = Date.now();
  const response = await fetch(url, {
    headers: { 'User-Agent': 'KrillionBot-SeedImporter/0.1 (personal archive import)' },
    signal: AbortSignal.timeout(30_000), redirect: 'error',
  });
  return { status: response.status, body: await response.text() };
}, { packs: [...new Set(packs)] as SeedPack[], onProgress: console.log });
if (report.chapters.some(chapter => chapter.status === 'imported')) await writeJson(output, database);
await writeJson(output.replace(/\.json$/u, '') + '.packs.report.json', report, true);
console.log(JSON.stringify({ catalogues: report.catalogues, counts: Object.fromEntries(
  ['imported', 'skipped', 'locked', 'unavailable', 'failed'].map(status => [status, report.chapters.filter(c => c.status === status).length])),
  failures: report.failures }, null, 2));
if (report.failures.length || report.chapters.some(c => c.status === 'failed')) process.exitCode = 1;
