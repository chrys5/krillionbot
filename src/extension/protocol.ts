export interface PartyEvent {
  seq: number;
  kind: string;
  index?: number;
  answer?: string;
}

export interface PartyState {
  code: string;
  version: number;
  phase: string;
  gameNumber: number;
  holderSince: number | null;
  category: { index: number; text: string; accepted: number } | null;
  events: PartyEvent[];
}

export type Observation =
  | { type: 'state'; state: PartyState }
  | { type: 'result'; accepted: boolean; why: string; answer: string; category: string }
  | { type: 'disconnected' };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value);

// Copy only game fields we use. Never forward account data, chat, socket URLs or tokens.
export function cleanState(value: unknown): PartyState | null {
  if (!object(value) || typeof value.code !== 'string' || !/^[A-Z]{4}$/.test(value.code) ||
      !integer(value.version) || !integer(value.gameNumber) ||
      !['lobby', 'countdown', 'round', 'over'].includes(String(value.phase)) ||
      !(value.holderSince === null || integer(value.holderSince)) || !Array.isArray(value.events)) return null;
  let category: PartyState['category'] = null;
  if (value.category !== null) {
    const c = value.category;
    if (!object(c) || !integer(c.index) || typeof c.text !== 'string' || !c.text ||
        c.text.length > 1000 || !integer(c.accepted) || c.accepted < 0) return null;
    category = { index: c.index, text: c.text, accepted: c.accepted };
  }
  const events: PartyEvent[] = [];
  for (const event of value.events) {
    if (!object(event) || !integer(event.seq) || typeof event.kind !== 'string') return null;
    if (event.kind !== 'category' && event.kind !== 'pass') continue;
    if (event.kind === 'category' && !integer(event.index)) return null;
    if (event.kind === 'pass' && (typeof event.answer !== 'string' || event.answer.length > 300)) return null;
    events.push({ seq: event.seq, kind: event.kind,
      ...(integer(event.index) ? { index: event.index } : {}),
      ...(typeof event.answer === 'string' ? { answer: event.answer } : {}),
    });
  }
  return { code: value.code, version: value.version, phase: String(value.phase),
    gameNumber: value.gameNumber, holderSince: value.holderSince, category, events };
}

export class PartyFeed {
  state: PartyState | null = null;
  private submissions = new Map<string, { answer: string; category: string }>();

  outgoing(value: unknown): void {
    if (!object(value) || value.t !== 'act' || typeof value.cid !== 'string' ||
        !object(value.action) || value.action.type !== 'submit' ||
        typeof value.action.text !== 'string' || !this.state?.category) return;
    this.submissions.set(value.cid, { answer: value.action.text.slice(0, 60), category: categoryKey(this.state) });
    if (this.submissions.size > 20) this.submissions.delete(this.submissions.keys().next().value!);
  }

  receive(value: unknown): Observation | null {
    if (!object(value)) return null;
    if (value.t === 'snap') {
      this.state = cleanState(value.room);
      return this.state ? { type: 'state', state: this.state } : { type: 'disconnected' };
    }
    if (value.t === 'patch' && object(value.patch)) {
      const patch = value.patch;
      if (!this.state || patch.base !== this.state.version || !integer(patch.v)) {
        this.state = null;
        return { type: 'disconnected' };
      }
      const set = object(patch.set) ? patch.set : {};
      const next: Record<string, unknown> = { ...this.state, version: patch.v };
      for (const key of ['code', 'phase', 'gameNumber', 'holderSince', 'category']) {
        if (Object.hasOwn(set, key)) next[key] = set[key];
      }
      if (Array.isArray(patch.eventsAll)) next.events = patch.eventsAll;
      else if (Array.isArray(patch.events)) {
        // Omitted event kinds do not affect category/used-answer reconstruction.
        next.events = [...this.state.events, ...patch.events];
      }
      this.state = cleanState(next);
      return this.state ? { type: 'state', state: this.state } : { type: 'disconnected' };
    }
    if (value.t === 'ack' && typeof value.cid === 'string' && object(value.submit)) {
      const submission = this.submissions.get(value.cid);
      this.submissions.delete(value.cid);
      if (!submission) return null;
      return { type: 'result', accepted: value.submit.accepted === true,
        why: typeof value.submit.why === 'string' ? value.submit.why.slice(0, 100) : '', ...submission };
    }
    if (value.t === 'gone' || value.t === 'removed') {
      this.state = null;
      return { type: 'disconnected' };
    }
    return null;
  }
}

export function categoryKey(state: PartyState): string {
  return `${state.code}:${state.gameNumber}:${state.category?.index ?? ''}`;
}

export function usedAnswers(state: PartyState): string[] | null {
  if (!state.category) return [];
  const start = state.events.findLastIndex(e => e.kind === 'category' && e.index === state.category!.index);
  if (start === -1) return state.category.accepted === 0 ? [] : null;
  const used = state.events.slice(start + 1).filter(e => e.kind === 'pass').map(e => e.answer!);
  // A mid-category snapshot with incomplete events must not pretend the room has no used answers.
  return used.length === state.category.accepted ? used : null;
}
