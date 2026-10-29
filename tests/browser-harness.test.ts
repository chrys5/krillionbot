import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { build } from 'esbuild';
import { JSDOM, ResourceLoader, VirtualConsole } from 'jsdom';
import { emptyDatabase } from '../src/data/update.js';

test('local helper runs the production content and observer bundles through its checks', async () => {
  const entries = {
    '/fixture.js': 'tests/browser/harness.ts',
    '/extension/bridge.js': 'src/extension/bridge.ts',
    '/extension/content.js': 'src/extension/content.ts',
  };
  const files = new Map<string, Buffer>();
  for (const [path, entry] of Object.entries(entries)) {
    const bundle = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'browser', target: 'chrome111' });
    files.set(path, Buffer.from(bundle.outputFiles[0]!.contents));
  }
  class LocalResources extends ResourceLoader {
    override fetch(url: string) {
      const body = files.get(new URL(url).pathname);
      if (!body) return null;
      return Object.assign(Promise.resolve(body), { abort() {} });
    }
  }
  const database = emptyDatabase();
  database.days['2026-10-28'] = { date: '2026-10-28', dive: 105, sourceUrl: 'fixture', prompts: [{
    text: 'Name a pasta dish', key: 'name a pasta dish', answers: [
      { text: 'First', score: 100, tier: 'krillion', aliases: [] },
      { text: 'Second', score: 85, tier: 'deepcut', aliases: [] },
      { text: 'Third', score: 60, tier: 'rare', aliases: [] },
    ],
  }] };
  const errors: string[] = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(String(error)));
  const dom = new JSDOM(await readFile('tests/browser/index.html', 'utf8'), {
    url: 'https://krillion.io/krillionbot-test/party/TEST', runScripts: 'dangerously',
    resources: new LocalResources(), virtualConsole: console,
    beforeParse(window) {
      Object.defineProperty(window, 'Response', { value: Response });
      window.fetch = async () => new Response(JSON.stringify(database), { headers: { 'Content-Type': 'application/json' } });
      // jsdom omits origin/source on postMessage; emulate real same-window browser delivery.
      window.postMessage = (data: unknown) => {
        window.setTimeout(() => window.dispatchEvent(new window.MessageEvent('message', {
          data, origin: window.location.origin, source: window as unknown as Window,
        })), 0);
      };
    },
  });
  try {
    const run = dom.window.document.querySelector<HTMLButtonElement>('#run')!;
    for (let i = 0; i < 200 && run.disabled; i++) await wait(10);
    assert.equal(run.disabled, false, dom.window.document.querySelector('#results')!.textContent!);
    run.click();
    for (let i = 0; i < 1500 && run.disabled; i++) await wait(10);
    const result = dom.window.document.querySelector('#results')!.textContent!;
    assert.match(result, /ALL LOCAL CHECKS PASSED/, result + '\nBot: ' +
      dom.window.document.querySelector('#krillionbot-controls')?.shadowRoot?.querySelector('p')?.textContent);
    assert.deepEqual(errors, []);
  } finally {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    await wait(30); dom.window.close();
  }
});
