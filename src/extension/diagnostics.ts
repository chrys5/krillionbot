import type { KeyValueStore } from '../llm/cache.js';

export const VERSION = '0.3.6';
export const DIAGNOSTICS_KEY = 'krillionbot:diagnostics:v1';
export const AUTO_RECOVERY_KEY = 'krillionbot:auto-recovery:v1';
export interface DiagnosticEvent {
  level: 'info' | 'warning' | 'error'; event: string; message: string; context?: unknown;
}
export interface DiagnosticEntry extends DiagnosticEvent { at: string; version: string; tabId?: number; frameId?: number }
export const LOG_LIMIT = 1000;
export const LOG_BYTES = 1024 * 1024;

export function diagnosticLevel(message: string): DiagnosticEvent['level'] | undefined {
  if (/error|failed|failure|could not|cannot|denied|not granted|not confirmed|invalidated/i.test(message)) return 'error';
  if (/reject|invalid|unavailable|incomplete|interrupt|offline|timeout|timed out|exhaust|no seed|no usable|manual entry|three attempts|retry|retrying|missing|unconfirmed|waiting for an empty input|stale|unexpected/i.test(message)) return 'warning';
  return undefined;
}

export function diagnosticError(error: unknown): { name: string; message: string; stack?: string } {
  if (error && typeof error === 'object') {
    const value = error as { name?: unknown; message?: unknown; stack?: unknown };
    return { name: typeof value.name === 'string' ? value.name : 'Error',
      message: typeof value.message === 'string' ? value.message : 'Unknown exception',
      ...(typeof value.stack === 'string' ? { stack: value.stack } : {}) };
  }
  return { name: 'Error', message: typeof error === 'string' ? error : 'Unknown exception' };
}

function clean(value: unknown, depth = 0, secrets: string[] = []): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
    return text.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
      .replace(/\bsk-[\w-]+/g, '[redacted]')
      .replace(/(?:https?|wss?):\/\/[^\s"']+/gi, '[URL omitted]').slice(0, 1500);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.slice(-30).map(item => clean(item, depth + 1, secrets));
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).slice(0, 45)
    .filter(([key]) => !/api.?key|authorization|credential|password|cookie|secret|headers|chat|players?|socket|url|inputValue|manualInput|token(?!s$)/i.test(key))
    .map(([key, item]) => [key, clean(item, depth + 1, secrets)]));
}

export class DiagnosticLog {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: KeyValueStore, private readSecrets: () => Promise<string[]> = async () => []) {}

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }

  append(value: unknown, source: { tabId?: number; frameId?: number } = {}): Promise<void> {
    return this.run(async () => {
      const event = value as DiagnosticEvent;
      if (!event || !['info', 'warning', 'error'].includes(event.level) || typeof event.event !== 'string' ||
          typeof event.message !== 'string') throw new Error('Invalid diagnostic event');
      const entry = clean({ ...source, at: new Date().toISOString(), version: VERSION,
        level: event.level, event: event.event.slice(0, 100), message: event.message, context: event.context },
        0, await this.readSecrets()) as DiagnosticEntry;
      if (JSON.stringify(entry).length > 12000) entry.context = { truncated: true };
      const stored = await this.store.get(DIAGNOSTICS_KEY);
      const entries: DiagnosticEntry[] = Array.isArray(stored) ? stored.slice(-(LOG_LIMIT - 1)) : [];
      entries.push(entry);
      while (entries.length > 1 && new TextEncoder().encode(JSON.stringify(entries)).byteLength > LOG_BYTES) entries.shift();
      await this.store.set(DIAGNOSTICS_KEY, entries);
    });
  }

  read(): Promise<DiagnosticEntry[]> {
    return this.run(async () => {
      const entries = await this.store.get(DIAGNOSTICS_KEY);
      return Array.isArray(entries) ? entries : [];
    });
  }
  clear(): Promise<void> { return this.run(() => this.store.set(DIAGNOSTICS_KEY, [])); }
}

// The caller handles persistence failure locally; never recursively try to log it.
export async function sendDiagnostic(event: DiagnosticEvent): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: 'KRILLIONBOT_LOG', entry: event });
  if (response?.saved !== true) throw new Error('Diagnostic log could not be saved');
}
