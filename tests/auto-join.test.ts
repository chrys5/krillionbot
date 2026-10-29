import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { AutoJoin, joinAction } from '../src/extension/auto-join.js';

function fixture(html: string) {
  const dom = new JSDOM(html, { url: 'https://krillion.io/party/TEST' });
  let now = 0;
  const clicks: string[] = [], messages: string[] = [];
  dom.window.document.addEventListener('click', event => {
    clicks.push((event.target as HTMLElement).textContent!.trim());
    event.preventDefault();
  });
  const join = new AutoJoin(dom.window.document, message => messages.push(message), () => now, element => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true' ||
          node.style.display === 'none' || node.style.visibility === 'hidden') return false;
    }
    return true;
  });
  return { dom, join, clicks, messages, advance: (ms: number) => { now += ms; join.tick(); } };
}

test('auto-join defaults off, delays actions, avoids repeated clicks, pauses and resumes', () => {
  const f = fixture('<button>Join game</button>');
  try {
    f.join.tick(); f.advance(2000); assert.deepEqual(f.clicks, []);
    f.join.setEnabled(true); f.join.tick(); f.advance(999); assert.deepEqual(f.clicks, []);
    f.advance(1); assert.deepEqual(f.clicks, ['Join game']);
    for (let i = 0; i < 5; i++) f.advance(1000);
    assert.deepEqual(f.clicks, ['Join game']);
    f.dom.window.document.body.innerHTML = '<button>Play again</button>';
    f.join.tick(); f.join.setEnabled(false); f.advance(5000);
    assert.equal(f.clicks.length, 1);
    f.join.setEnabled(true); f.join.tick(); f.advance(1000);
    assert.deepEqual(f.clicks, ['Join game', 'Play again']);
  } finally { f.dom.window.close(); }
});

test('auto-join excludes the Party landing page and resets the action delay when returning to a room', () => {
  const f = fixture('<button>JOIN NEXT GAME</button>');
  try {
    f.join.setEnabled(true); f.join.tick(); f.advance(999);
    for (const path of ['/party', '/party/', '/party?mode=public', '/party/#lobby']) {
      f.dom.reconfigure({ url: `https://krillion.io${path}` });
      f.join.tick(); f.advance(5000);
      assert.deepEqual(f.clicks, [], `No auto-join on ${path}`);
    }
    f.dom.window.document.body.innerHTML = '<button>Wake puffer</button><button>Join game</button>';
    f.join.tick(); f.advance(5000);
    assert.deepEqual(f.clicks, [], 'Landing-page exclusion applies to every auto-join action');
    f.dom.window.document.body.innerHTML = '<button>JOIN NEXT GAME</button>';
    f.dom.reconfigure({ url: 'https://krillion.io/party/TEST/' });
    f.join.tick(); f.advance(999); assert.deepEqual(f.clicks, []);
    f.advance(1); assert.deepEqual(f.clicks, ['JOIN NEXT GAME']);
    f.advance(5000); assert.deepEqual(f.clicks, ['JOIN NEXT GAME']);
  } finally { f.dom.window.close(); }
});

test('wake takes priority and replay, new opponent, rematch, and next games work across navigation', () => {
  const f = fixture('<button>Rematch</button><button>Wake the puffer 🐡</button>');
  try {
    f.join.setEnabled(true); f.join.tick(); f.advance(1000);
    assert.deepEqual(f.clicks, ['Wake the puffer 🐡']);
    for (const text of ['Play again', 'Keep playing', 'New opponent', 'Rematch', 'Quick play', 'Join', 'JOIN NEXT GAME', 'Play now', 'Play']) {
      f.dom.window.document.body.innerHTML = `<button>${text}</button>`;
      f.dom.reconfigure({ url: `https://krillion.io/party/${text === 'Join' ? 'ABCD' : 'TEST'}` });
      f.join.tick(); f.advance(3000);
      assert.equal(f.clicks.at(-1), text);
    }
    f.dom.window.document.body.innerHTML = '<button>Wake your puffer</button>';
    f.dom.reconfigure({ url: 'https://krillion.io/settings' });
    f.join.tick(); f.advance(5000); assert.equal(f.clicks.at(-1), 'Play');
  } finally { f.dom.window.close(); }
});

test('rematch takes precedence over new opponents and waits before switching opponents', () => {
  for (const rematch of ['Rematch', 'Request rematch', 'Accept rematch']) {
    for (const opponent of ['New opponent', 'Find new opponent', 'Find a new opponent']) {
      const f = fixture(`<button>${opponent}</button><button id="rematch">${rematch}</button>`);
      try {
        f.join.setEnabled(true); f.join.tick(); f.advance(1000);
        assert.deepEqual(f.clicks, [rematch]);
        for (let i = 0; i < 5; i++) f.advance(3000);
        assert.deepEqual(f.clicks, [rematch], 'Do not leave the opponent while rematch remains available');
        f.dom.window.document.querySelector<HTMLButtonElement>('#rematch')!.disabled = true;
        f.join.tick(); f.advance(1000);
        assert.deepEqual(f.clicks, [rematch, opponent], 'New opponent remains available when rematch is unavailable');
      } finally { f.dom.window.close(); }
    }
  }
});

test('ignores hidden, disabled, unrelated, external, extension, and active-round controls', () => {
  const f = fixture(`<button disabled>Play again</button><button aria-disabled="true">Rematch</button>
    <div hidden><button>Join</button></div><div inert><button>Quick play</button></div>
    <div aria-hidden="true"><button>Play now</button></div><div style="display:none"><button>New opponent</button></div>
    <a href="https://other.example/">Join game</a><button>Leave game</button><button>Buy rematch</button>
    <div id="krillionbot-controls"><button>Play</button></div>`);
  try {
    f.join.setEnabled(true); f.join.tick(); f.advance(5000); assert.deepEqual(f.clicks, []);
    f.dom.window.document.body.innerHTML = '<div class="pf-root" data-phase="answering"><button>New opponent</button><button>Wake puffer</button></div>';
    f.join.tick(); f.advance(1000); assert.deepEqual(f.clicks, ['Wake puffer']);
    f.dom.window.document.body.innerHTML = '<button aria-label="Accept rematch">🐡</button>';
    assert.equal(joinAction(f.dom.window.document.querySelector('button')!), 2);
    f.join.tick(); f.advance(3000); assert.equal(f.clicks.length, 2);
  } finally { f.dom.window.close(); }
});

test('production content loads saved auto-join and Stop/Enable pauses and resumes it', async () => {
  const bundle = await build({ entryPoints: ['src/extension/content.ts'], bundle: true, write: false, platform: 'browser' });
  const dom = new JSDOM('<button>JOIN NEXT GAME</button>', { url: 'https://krillion.io/party', runScripts: 'outside-only' });
  let now = 0;
  let tick!: () => void;
  const listeners: ((message: any, sender: any, respond: (value: any) => void) => boolean | undefined)[] = [];
  const clicks: string[] = [];
  Object.assign(dom.window, {
    chrome: { runtime: {
      id: 'test-extension',
      sendMessage: async (request: any) => {
        if (request.type === 'KRILLIONBOT_AUTO_JOIN_CONFIG') return { enabled: true };
        if (request.type === 'KRILLIONBOT_SEED') return { promptKeys: [] };
        throw new Error('Unexpected request');
      },
      onMessage: { addListener: (listener: typeof listeners[number]) => listeners.push(listener) },
    } },
    setInterval: (callback: () => void) => { tick = callback; return 1; }, clearInterval: () => {},
  });
  dom.window.Date.now = () => now;
  dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 30 }] as unknown as DOMRectList;
  dom.window.document.addEventListener('click', event => {
    if (!(event.target as HTMLElement).closest('#krillionbot-controls')) clicks.push((event.target as HTMLElement).textContent!);
  });
  const send = (type: string) => new Promise(resolve => {
    for (const listener of listeners) listener({ type }, { id: 'test-extension' }, resolve);
  });
  try {
    dom.window.eval(bundle.outputFiles[0]!.text);
    await new Promise(resolve => setTimeout(resolve, 0));
    tick(); now = 1000; tick(); assert.deepEqual(clicks, [], 'Saved auto-join stays idle on the landing page');
    dom.reconfigure({ url: 'https://krillion.io/party/TEST' });
    tick(); now = 2000; tick(); assert.deepEqual(clicks, ['JOIN NEXT GAME']);
    await send('KRILLIONBOT_STOP');
    dom.window.document.querySelector('button')!.textContent = 'Play again';
    now = 5000; tick(); now = 6000; tick(); assert.deepEqual(clicks, ['JOIN NEXT GAME']);
    await send('KRILLIONBOT_ENABLE');
    tick(); now = 7000; tick(); assert.deepEqual(clicks, ['JOIN NEXT GAME', 'Play again']);
  } finally {
    dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close();
  }
});
