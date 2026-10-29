import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { partitionSeed, type SeedIndex } from '../src/data/shards.js';
import type { SeedDatabase } from '../src/data/types.js';

await mkdir('build/extension', { recursive: true });
await build({
  entryPoints: {
    bridge: 'src/extension/bridge.ts', content: 'src/extension/content.ts',
    background: 'src/extension/background.ts', popup: 'src/extension/popup.ts',
  },
  outdir: 'build/extension', bundle: true, format: 'iife', platform: 'browser', target: 'chrome111',
});
for (const filename of ['manifest.json', 'popup.html']) {
  await copyFile(`extension-assets/${filename}`, `build/extension/${filename}`);
}
// Derive local question files from the retained artifact without running an importer.
const seed = await readFile('data/seed.json');
const shards = partitionSeed(JSON.parse(seed.toString('utf8')) as SeedDatabase);
const index: SeedIndex = { schemaVersion: 1, prompts: Object.create(null) as Record<string, string> };
await mkdir('build/extension/seed/prompts', { recursive: true });
for (const [key, database] of shards) {
  const path = `seed/prompts/${createHash('sha256').update(key).digest('hex')}.json`;
  await writeFile(`build/extension/${path}`, JSON.stringify(database));
  index.prompts[key] = path;
}
await writeFile('build/extension/seed/index.json', JSON.stringify(index));
await rm('build/extension/seed.json', { force: true });
await writeFile('build/extension/build-info.json', JSON.stringify({
  version: '0.3.3', seedSHA256: createHash('sha256').update(seed).digest('hex'),
  seedLayout: 'per-question-v1', seedQuestions: shards.size,
}, null, 2));
console.log('Load unpacked: ' + process.cwd() + '/build/extension');
