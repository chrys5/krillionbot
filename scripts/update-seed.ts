import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import { readDatabase, writeJson } from '../src/data/store.js';
import { updateSeed } from '../src/data/update.js';

async function main() {
  const { values } = parseArgs({ options: {
    'max-new-days': { type: 'string' },
    output: { type: 'string', default: 'data/seed.json' },
  } });
  const maxNewDays = values['max-new-days'] === undefined ? Infinity : Number(values['max-new-days']);
  if (!(maxNewDays === Infinity || Number.isInteger(maxNewDays) && maxNewDays >= 0)) {
    throw new Error('--max-new-days must be a nonnegative integer');
  }
  const output = resolve(values.output!);
  const database = await readDatabase(output);
  let lastRequest = 0;
  const report = await updateSeed(database, async url => {
    await setTimeout(Math.max(0, 400 - (Date.now() - lastRequest)));
    lastRequest = Date.now();
    const response = await fetch(url, {
      headers: { 'User-Agent': 'KrillionBot-SeedImporter/0.1 (personal archive import)' },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }, { maxNewDays, onProgress: console.log });
  // No newly imported data means no rewrite of the bundled database.
  if (report.importedDays.length) await writeJson(output, database);
  await writeJson(`${output.slice(0, output.endsWith('.json') ? -5 : undefined)}.report.json`, report, true);
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
