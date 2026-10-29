const POSITION_KEY = 'krillionbot:panel-position:v1';
interface Position { x: number; y: number }

export function makeDraggablePanel(panel: HTMLElement, handle: HTMLElement): () => void {
  const document = panel.ownerDocument, window = document.defaultView!;
  let position: Position | null = null;
  let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;
  const place = (x: number, y: number) => {
    const bounds = panel.getBoundingClientRect();
    position = {
      x: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)),
    };
    panel.style.left = `${position.x}px`; panel.style.top = `${position.y}px`; panel.style.right = 'auto';
  };
  const save = () => {
    try { if (position) window.localStorage.setItem(POSITION_KEY, JSON.stringify(position)); } catch { /* Storage can be disabled. */ }
  };
  try {
    const saved = JSON.parse(window.localStorage.getItem(POSITION_KEY) ?? 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) place(saved.x, saved.y);
  } catch { /* Ignore missing or malformed positions. */ }
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || drag) return;
    const bounds = panel.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top };
    handle.setPointerCapture?.(event.pointerId);
    handle.style.cursor = 'grabbing'; event.preventDefault();
  };
  const move = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    place(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
    event.preventDefault();
  };
  const end = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null; handle.style.cursor = '';
    if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    save();
  };
  const key = (event: KeyboardEvent) => {
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta) return;
    const bounds = panel.getBoundingClientRect(), step = event.shiftKey ? 50 : 20;
    place(bounds.left + delta[0]! * step, bounds.top + delta[1]! * step); save(); event.preventDefault();
  };
  const resize = () => {
    if (!position || !panel.isConnected) return;
    place(position.x, position.y);
  };
  const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(resize) : null;
  observer?.observe(panel);
  handle.addEventListener('pointerdown', down);
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  handle.addEventListener('lostpointercapture', end);
  handle.addEventListener('keydown', key);
  window.addEventListener('resize', resize);
  return () => {
    observer?.disconnect();
    handle.removeEventListener('pointerdown', down);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.removeEventListener('pointercancel', end);
    handle.removeEventListener('lostpointercapture', end);
    handle.removeEventListener('keydown', key);
    window.removeEventListener('resize', resize);
  };
}
