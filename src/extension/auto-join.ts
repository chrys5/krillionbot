export const AUTO_JOIN_KEY = 'krillionbot:auto-join:v1';

const label = (element: Element) => (element.getAttribute('aria-label') || element.textContent || '')
  .normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

export function joinAction(element: Element): number | null {
  const text = label(element);
  if (/^wake (?:the |your )?puffer$/.test(text)) return 0;
  if (/^(?:play again|keep playing)$/.test(text)) return 1;
  if (/^(?:find (?:a )?)?new opponent$/.test(text)) return 2;
  if (/^(?:request |accept )?rematch$/.test(text)) return 3;
  if (/^(?:join|quick join|quick play|find (?:a )?match|play|play now)$/.test(text) ||
      /^join (?:a |the )?(?:game|match|queue|lobby)$/.test(text)) return 4;
  return null;
}

export class AutoJoin {
  private enabled = false;
  private candidate: HTMLElement | null = null;
  private since = 0;
  private lastClick = -Infinity;
  private attempted = new Set<string>();
  private screen = '';
  constructor(private document: Document, private report: (message: string) => void,
    private now = () => Date.now(), private visible = (element: HTMLElement) => {
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const style = document.defaultView!.getComputedStyle(node);
        if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true' ||
            style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return element.getClientRects().length > 0;
    }) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled; this.candidate = null; this.attempted.clear();
    this.report(enabled ? 'Auto-join on: waiting for a game control.' : 'Auto-join off.');
  }

  tick(): void {
    if (!this.enabled || !/^\/party(?:\/|$)/.test(this.document.location.pathname)) return;
    const controls = [...this.document.querySelectorAll<HTMLElement>('button, a[href], [role="button"]')]
      .filter(element => !element.closest('#krillionbot-controls') && this.visible(element) &&
        !element.matches(':disabled, [aria-disabled="true"]') && joinAction(element) !== null &&
        (joinAction(element) === 0 || !this.document.querySelector('.pf-root[data-phase="answering"]')) &&
        (!(element instanceof this.document.defaultView!.HTMLAnchorElement) ||
          new URL(element.href, this.document.location.href).origin === this.document.location.origin))
      .sort((a, b) => joinAction(a)! - joinAction(b)!);
    const screen = this.document.location.pathname + '|' + controls.map(element => label(element)).sort().join('|');
    if (screen !== this.screen) { this.screen = screen; this.attempted.clear(); }
    const target = controls.find(element => !this.attempted.has(label(element))) ?? null;
    if (target !== this.candidate) { this.candidate = target; this.since = this.now(); return; }
    if (!target || this.now() - this.since < 1000 || this.now() - this.lastClick < 3000) return;
    this.attempted.add(label(target)); this.lastClick = this.now();
    this.report(`Auto-join: ${label(target)}.`);
    target.click();
  }
}
