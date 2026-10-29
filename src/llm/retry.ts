import type { Generate, GeneratedCandidate, LlmSettings, ProviderRequest } from './provider.js';
import { cancelled, failureInfo, ProviderError, type FailureInfo } from './failure.js';

export interface AttemptTrace {
  attempt: number; timeoutMs: number; elapsedMs: number; outcome: 'success' | 'failed';
  failure?: FailureInfo; retryDelayMs?: number;
}
export interface RetryProgress { message: string; attempt: number; timeoutMs: number; attempts: AttemptTrace[] }
export class LookupError extends Error {
  constructor(public failure: FailureInfo, public attempts: AttemptTrace[]) { super(failure.message); }
}
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function generateWithRetries(generate: Generate, request: ProviderRequest, settings: LlmSettings,
  apiKey: string, options: {
    signal?: AbortSignal; beforeAttempt?: () => Promise<void>;
    onProgress?: (value: RetryProgress) => void; onFailure?: (failure: FailureInfo) => Promise<void>;
    now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; random?: () => number;
  } = {}): Promise<{ candidates: GeneratedCandidate[]; attempts: AttemptTrace[] }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableDelay;
  const random = options.random ?? Math.random;
  const start = now(), attempts: AttemptTrace[] = [];
  const totalBudget = settings.retryBudgetMs;
  const emit = (message: string, attempt: number, timeoutMs: number) => options.onProgress?.({ message, attempt, timeoutMs, attempts: [...attempts] });
  for (let attempt = 1; attempt <= settings.maxAttempts; attempt++) {
    if (options.signal?.aborted) throw new LookupError(failureInfo(cancelled()), attempts);
    const remaining = totalBudget - (now() - start);
    if (remaining <= 0) break;
    let timeoutMs = Math.min(settings.timeoutMs * 2 ** (attempt - 1), remaining, 15000);
    const attemptStart = now();
    try {
      await options.beforeAttempt?.();
      if (options.signal?.aborted) throw cancelled();
      timeoutMs = Math.min(timeoutMs, totalBudget - (now() - start));
      if (timeoutMs <= 0) throw new ProviderError('budget', 'LLM retry time budget exhausted.', false);
      emit(`LLM attempt ${attempt}/${settings.maxAttempts} · timeout ${timeoutMs} ms`, attempt, timeoutMs);
      const candidates = await generate({ ...request, ...(options.signal ? { signal: options.signal } : {}) }, { ...settings, timeoutMs }, apiKey);
      if (options.signal?.aborted) throw cancelled();
      attempts.push({ attempt, timeoutMs, elapsedMs: now() - attemptStart, outcome: 'success' });
      return { candidates, attempts };
    } catch (error) {
      const failure = options.signal?.aborted ? failureInfo(cancelled()) : failureInfo(error);
      const trace: AttemptTrace = { attempt, timeoutMs, elapsedMs: now() - attemptStart, outcome: 'failed', failure };
      attempts.push(trace);
      await options.onFailure?.(failure);
      const delay = Math.max(failure.retryAfterMs ?? 0, Math.round(100 * 2 ** (attempt - 1) * (1 + random() * 0.25)));
      const left = totalBudget - (now() - start);
      if (!failure.retryable || attempt === settings.maxAttempts || delay >= left) throw new LookupError(failure, attempts);
      trace.retryDelayMs = delay;
      emit(`${failure.message} Retrying attempt ${attempt + 1}/${settings.maxAttempts} in ${delay} ms.`, attempt, timeoutMs);
      try { await sleep(delay, options.signal); }
      catch { throw new LookupError(failureInfo(cancelled()), attempts); }
    }
  }
  throw new LookupError(failureInfo(new ProviderError('budget', 'LLM retry time budget exhausted.', false)), attempts);
}
