export type FailureKind = 'timeout' | 'network' | 'rate-limit' | 'server' | 'authentication' | 'request' |
  'quota' | 'invalid-output' | 'incomplete' | 'empty' | 'cancelled' | 'budget';
export interface FailureInfo { kind: FailureKind; message: string; retryable: boolean; status?: number; retryAfterMs?: number }

export class ProviderError extends Error {
  constructor(public kind: FailureKind, message: string, public retryable: boolean,
    public status?: number, public retryAfterMs?: number) { super(message); this.name = 'ProviderError'; }
}

export function failureInfo(error: unknown): FailureInfo {
  if (error instanceof ProviderError) return { kind: error.kind, message: error.message, retryable: error.retryable,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) };
  // Transport errors may contain URLs or headers. Never copy arbitrary exception text to diagnostics.
  return { kind: 'network', message: 'LLM connection failed.', retryable: true };
}

export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function cancelled(): ProviderError { return new ProviderError('cancelled', 'LLM lookup cancelled.', false); }
