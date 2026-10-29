import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

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
// Packaging copies the retained artifact. It never calls the archive importer.
await copyFile('data/seed.json', 'build/extension/seed.json');
const seed = await readFile('data/seed.json');
await writeFile('build/extension/build-info.json', JSON.stringify({
  version: '0.3.1', seedSHA256: createHash('sha256').update(seed).digest('hex'),
}, null, 2));
console.log('Load unpacked: ' + process.cwd() + '/build/extension');
