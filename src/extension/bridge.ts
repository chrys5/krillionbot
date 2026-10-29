import { PartyFeed, type Observation } from './protocol.js';

const CHANNEL = 'krillionbot:party:v1';
const NativeSocket = window.WebSocket;
let current = 0;
let latest: Observation | null = null;
const publish = (observation: Observation) => {
  if (observation.type !== 'result') latest = observation;
  window.postMessage({ channel: CHANNEL, observation }, location.origin);
};

// Passive listener: never sends socket commands or changes the game's input telemetry.
window.WebSocket = class extends NativeSocket {
  private botFeed: PartyFeed | undefined;
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    const target = new URL(String(url), location.href);
    if (target.hostname !== 'party.krillion.io' || !/^\/rooms\/[A-Z]{4}\/ws$/.test(target.pathname)) return;
    const generation = ++current;
    const feed = new PartyFeed();
    this.botFeed = feed;
    latest = null;
    this.addEventListener('message', event => {
      if (generation !== current || typeof event.data !== 'string') return;
      try {
        const observation = feed.receive(JSON.parse(event.data));
        if (observation) publish(observation);
      } catch { publish({ type: 'disconnected' }); }
    });
    this.addEventListener('close', () => {
      if (generation === current) publish({ type: 'disconnected' });
    });
  }

  override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.botFeed && typeof data === 'string') {
      try { this.botFeed.outgoing(JSON.parse(data)); } catch { /* Non-JSON frame. */ }
    }
    super.send(data);
  }
};
window.addEventListener('message', event => {
  if (event.source === window && event.origin === location.origin &&
      event.data?.channel === CHANNEL && event.data?.request === 'snapshot' && latest) publish(latest);
});
