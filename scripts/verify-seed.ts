import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readDatabase } from '../src/data/store.js';
import { databaseStats } from '../src/data/update.js';
import { SeedLookup } from '../src/resolver/seed-lookup.js';
import { seedRecords } from '../src/data/records.js';

const loadStart = performance.now();
const database = await readDatabase('data/seed.json');
assert.ok(Object.keys(database.days).length, 'Import seed data before running verification');
const lookup = new SeedLookup(database);
const loadMs = performance.now() - loadStart;
const uniquePrompts = new Map(seedRecords(database)
  .flatMap(day => day.prompts).map(prompt => [prompt.key, prompt.text]));
const durations: number[] = [];
for (const text of uniquePrompts.values()) {
  const start = performance.now();
  const candidates = lookup.lookup(text);
  durations.push(performance.now() - start);
  assert.ok(candidates.length > 0 && candidates.length <= 10, `No candidates: ${text}`);
  const best = candidates[0]!;
  const withoutBest = lookup.lookup(text, { used: [best.text] });
  assert.ok(!withoutBest.some(candidate => candidate.text === best.text), `Used answer returned: ${text}`);
}
assert.deepEqual(lookup.lookup('This is deliberately an unknown prompt, not a real category.'), []);
durations.sort((a, b) => a - b);
const dates = Object.keys(database.days).sort();
console.log(JSON.stringify({
  ...databaseStats(database),
  totalChapters: Object.keys(database.chapters ?? {}).length,
  totalCollections: Object.keys(database.collections ?? {}).length,
  firstDate: dates[0], lastDate: dates.at(-1),
  corpusVerification: 'Every indexed prompt resolves; used top answers are excluded.',
  loadAndIndexMs: Math.round(loadMs),
  lookupP95Ms: Number(durations[Math.ceil(durations.length * 0.95) - 1]!.toFixed(2)),
  lookupMaxMs: Number(durations.at(-1)!.toFixed(2)),
  timingScope: 'Node local lookup only; not browser submission or game acknowledgement.',
}, null, 2));
