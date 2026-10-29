import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

await build({ entryPoints: ['tests/browser/harness.ts'], outfile: 'build/fixture.js', bundle: true, platform: 'browser', target: 'chrome111' });
const files: Record<string, [string, string]> = {
  '/krillionbot-test/party/TEST': ['tests/browser/index.html', 'text/html'],
  '/fixture.js': ['build/fixture.js', 'text/javascript'],
  '/extension/bridge.js': ['build/extension/bridge.js', 'text/javascript'],
  '/extension/content.js': ['build/extension/content.js', 'text/javascript'],
  '/extension/seed.json': ['data/seed.json', 'application/json'],
};
const server = createServer(async (request, response) => {
  const entry = files[new URL(request.url ?? '/', 'http://127.0.0.1').pathname];
  if (!entry) { response.writeHead(404); response.end('Not found'); return; }
  try {
    response.writeHead(200, { 'Content-Type': entry[1] + '; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(await readFile(entry[0]));
  } catch { response.end('Build the extension first.'); }
});
server.on('error', error => { console.error(error); process.exitCode = 1; });
server.listen(4173, '127.0.0.1', () => {
  console.log('Open http://127.0.0.1:4173/krillionbot-test/party/TEST in Chrome and click Run checks.');
  console.log('This server is local only. Stop it with Ctrl+C. No extension installation is needed for the simulation.');
});
