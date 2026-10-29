import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { makeDraggablePanel } from '../src/extension/draggable-panel.js';

function fixture() {
  const dom = new JSDOM('<div id="panel"><button>Move panel</button><button>Enable</button></div>', { url: 'https://krillion.io/party' });
  const panel = dom.window.document.querySelector<HTMLDivElement>('#panel')!;
  const handle = panel.querySelector('button')!;
  panel.getBoundingClientRect = () => ({ left: parseFloat(panel.style.left || '700'), top: parseFloat(panel.style.top || '70'),
    width: 276, height: 200 }) as DOMRect;
  const pointer = (target: EventTarget, type: string, x: number, y: number, id = 1) => {
    const event = new dom.window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: id }); target.dispatchEvent(event);
  };
  return { dom, panel, handle, pointer };
}

test('only the handle drags; pointer identity, release, persistence and viewport bounds are respected', () => {
  const f = fixture(), document = f.dom.window.document;
  let dispose = makeDraggablePanel(f.panel, f.handle);
  try {
    f.pointer(f.panel.querySelectorAll('button')[1]!, 'pointerdown', 710, 80);
    f.pointer(document, 'pointermove', 100, 200);
    assert.equal(f.panel.style.left, '');
    f.pointer(f.handle, 'pointerdown', 710, 80);
    f.pointer(document, 'pointermove', 110, 180, 2);
    assert.equal(f.panel.style.left, '');
    f.pointer(document, 'pointermove', 110, 180);
    assert.equal(f.panel.style.left, '100px'); assert.equal(f.panel.style.top, '170px');
    f.pointer(document, 'pointerup', 110, 180);
    f.pointer(document, 'pointermove', 500, 500);
    assert.equal(f.panel.style.left, '100px');
    dispose(); f.panel.style.left = ''; f.panel.style.top = '';
    dispose = makeDraggablePanel(f.panel, f.handle);
    assert.equal(f.panel.style.left, '100px'); assert.equal(f.panel.style.top, '170px');
    f.pointer(f.handle, 'pointerdown', 110, 180);
    f.pointer(document, 'pointermove', -1000, 10000);
    assert.equal(f.panel.style.left, '8px');
    assert.equal(f.panel.style.top, `${f.dom.window.innerHeight - 208}px`);
    f.pointer(document, 'pointercancel', -1000, 10000);
    Object.defineProperty(f.dom.window, 'innerHeight', { value: 250, configurable: true });
    f.dom.window.dispatchEvent(new f.dom.window.Event('resize'));
    assert.equal(f.panel.style.top, '42px');
  } finally { dispose(); f.dom.window.close(); }
});

test('keyboard movement works and a saved off-screen position is clamped after reload', () => {
  const f = fixture();
  const dispose = makeDraggablePanel(f.panel, f.handle);
  try {
    f.handle.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    assert.equal(f.panel.style.left, '680px');
    f.handle.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true }));
    assert.equal(f.panel.style.top, '120px');
    dispose();
    Object.defineProperty(f.dom.window, 'innerWidth', { value: 320, configurable: true });
    const remove = makeDraggablePanel(f.panel, f.handle);
    assert.equal(f.panel.style.left, '36px');
    remove();
  } finally { dispose(); f.dom.window.close(); }
});
