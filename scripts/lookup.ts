import { parseArgs } from 'node:util';
import { readDatabase } from '../src/data/store.js';
import { SeedLookup } from '../src/resolver/seed-lookup.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  used: { type: 'string', multiple: true, default: [] },
  rejected: { type: 'string', multiple: true, default: [] },
  database: { type: 'string', default: 'data/seed.json' },
} });
if (!positionals.length) {
  console.error('Usage: npm run lookup -- "Name a pasta dish" --used "Spaghetti"');
  process.exitCode = 1;
} else {
  const database = await readDatabase(values.database!);
  const candidates = new SeedLookup(database).lookup(positionals.join(' '), {
    used: values.used, rejected: values.rejected,
  });
  console.log(JSON.stringify(candidates, null, 2));
}
