import { normalize } from '../data/normalize.js';
import type { PartyState } from './protocol.js';

export interface GameDom {
  prompt: string;
  ourTurn: boolean;
  input: HTMLInputElement | null;
  send: HTMLButtonElement | null;
}

export function readGame(document: Document): GameDom {
  const root = document.querySelector('.pf-root');
  const input = root?.querySelector<HTMLInputElement>('input[aria-label="Your answer"]') ?? null;
  const send = root?.querySelector<HTMLButtonElement>('button[aria-label="Send answer"]') ?? null;
  const prompt = root?.querySelector('.ds-card:not(.gone):not(.cleared) .prompt')?.textContent?.trim() ?? '';
  const ourTurn = !!root && root.getAttribute('data-phase') === 'answering' &&
    !!input && !input.disabled && !input.readOnly &&
    input.placeholder.startsWith('your puffer') && !!send; // maybe this is too brittle?
  return { prompt, ourTurn, input, send };
}

export function sameCategory(dom: GameDom, state: PartyState): boolean {
  return !!state.category && normalize(dom.prompt) === normalize(state.category.text);
}

export function fillAnswer(input: HTMLInputElement, text: string): void {
  const window = input.ownerDocument.defaultView!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Cannot access the answer input setter');
  // TODO: add typing simulation with delays and randomization to avoid anticheat
  setter.call(input, text);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}
