import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { setTimeout as wait } from 'node:timers/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

test('popup saves session keys with a blank model, reopens, retains, scopes, and forgets them', async () => {
  const [popupBundle, backgroundBundle, html] = await Promise.all([
    build({ entryPoints: ['src/extension/popup.ts'], bundle: true, write: false, platform: 'browser' }),
    build({ entryPoints: ['src/extension/background.ts'], bundle: true, write: false, platform: 'browser' }),
    readFile('extension-assets/popup.html', 'utf8'),
  ]);
  const local = new Map<string, unknown>(), session = new Map<string, unknown>();
  const storage = (data: Map<string, unknown>) => ({
    get: async (key: string) => ({ [key]: data.get(key) }),
    set: async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value));
    },
    remove: async (key: string) => { data.delete(key); },
    setAccessLevel: async () => {},
  });
  let handler!: (message: unknown, sender: unknown, respond: (response: any) => void) => boolean;
  let granted = true;
  let dropSaveResponse = false;
  const exported: Blob[] = [];
  const downloads: string[] = [];
  const runtime = {
    id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`,
    onMessage: { addListener: (fn: typeof handler) => { handler = fn; } },
    sendMessage: (message: any) => new Promise(resolve => {
      if (dropSaveResponse && message.type === 'KRILLIONBOT_SAVE_CONFIG') return resolve(undefined);
      handler(message, { id: 'test-extension', url: runtime.getURL('popup.html') }, resolve);
    }),
  };
  const chrome = {
    runtime, storage: { local: storage(local), session: storage(session) },
    permissions: { contains: async () => granted, request: async () => granted },
    tabs: { query: async () => [] },
  };
  runInNewContext(backgroundBundle.outputFiles[0]!.text, {
    chrome, URL, AbortController, setTimeout, clearTimeout, TextEncoder,
    fetch: async () => { assert.fail('Saving settings must not make an API request'); },
  });
  const open = async () => {
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    Object.assign(dom.window, { chrome, Blob });
    dom.window.URL.createObjectURL = (blob: Blob) => { exported.push(blob); return 'blob:test'; };
    dom.window.URL.revokeObjectURL = () => {};
    dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
    dom.window.eval(popupBundle.outputFiles[0]!.text);
    await until(() => dom.window.document.querySelector('#provider-status')!.textContent!.includes('cache hits'));
    return dom;
  };
  let dom = await open();
  const field = (id: string) => dom.window.document.querySelector<HTMLInputElement>(`#${id}`)!;
  const status = () => field('save-status').textContent!;
  const keyState = () => field('key-state').textContent!;
  const save = async () => {
    field('save').click();
    await until(() => !field('save').disabled);
  };
  try {
    assert.match(keyState(), /No key/);
    assert.equal(field('auto-join').checked, false);
    await until(() => !field('auto-recovery').disabled);
    assert.equal(field('auto-recovery').checked, true);
    field('auto-recovery').checked = false;
    field('auto-recovery').dispatchEvent(new dom.window.Event('change'));
    await until(() => !field('auto-recovery').disabled);
    field('auto-join').checked = true;
    field('auto-join').dispatchEvent(new dom.window.Event('change'));
    await until(() => !field('auto-join').disabled);
    assert.equal(local.get('krillionbot:auto-join:v1'), true);
    field('llm-enabled').checked = true;
    field('api-key').value = ' mock-secret ';
    await save();
    assert.match(status(), /Settings saved.*Enter a model ID/);
    assert.match(keyState(), /A key is set/);
    assert.equal(field('api-key').value, '');
    assert.ok(!JSON.stringify(Object.fromEntries(local)).includes('mock-secret'));
    assert.equal((session.get('krillionbot:credential:v1') as any).apiKey, 'mock-secret');

    dom.window.close(); dom = await open();
    assert.equal(field('auto-join').checked, true);
    assert.equal(field('auto-recovery').checked, false);
    assert.match(keyState(), /A key is set/);
    assert.equal(field('api-key').value, '');
    field('model').value = 'mock-model';
    await save();
    assert.equal(status(), 'Settings saved.');
    assert.match(keyState(), /A key is set/);

    field('base-url').value = 'https://other.example/v1';
    await save();
    assert.match(keyState(), /No key/);
    field('base-url').value = 'https://api.openai.com/v1';
    await save();
    assert.match(keyState(), /A key is set/);

    granted = false;
    field('api-key').value = 'replacement-secret';
    await save();
    assert.match(status(), /access was not granted/);
    assert.equal(field('api-key').value, 'replacement-secret');
    assert.equal((session.get('krillionbot:credential:v1') as any).apiKey, 'mock-secret');

    granted = true; dropSaveResponse = true;
    await save();
    assert.match(status(), /Could not confirm/);
    assert.equal(field('api-key').value, 'replacement-secret');
    dropSaveResponse = false;
    field('forget-key').click();
    await until(() => keyState() === 'Key removed.');
    assert.equal(session.has('krillionbot:credential:v1'), false);
    field('view-logs').click();
    await until(() => dom.window.document.querySelector('#logs-output')!.textContent!.includes('popup.status'));
    assert.ok(!dom.window.document.querySelector('#logs-output')!.textContent!.includes('replacement-secret'));
    field('export-logs').click();
    await until(() => downloads.length === 1);
    const exportData = JSON.parse(await exported[0]!.text());
    assert.ok(exportData.entries.length > 0);
    assert.match(downloads[0]!, /^krillionbot-logs-.*\.json$/);
    field('clear-logs').click();
    await until(() => dom.window.document.querySelector('#logs-status')!.textContent === 'Logs cleared.');
    dom.window.close(); dom = await open();
    assert.match(keyState(), /No key/);
  } finally { dom.window.close(); }
});

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await wait(5);
  }
  assert.fail('Popup did not finish updating');
}
