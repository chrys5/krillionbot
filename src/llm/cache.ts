import { normalize } from '../data/normalize.js';
import { AnswerMatcher } from '../data/answer-matching.js';
import { PROMPT_SCHEMA_VERSION, type Generate, type LlmSettings, type GeneratedCandidate } from './provider.js';
import { fitsConstraints, isCurrentFactQuestion, questionConstraints, suggestionTtlMs } from './constraints.js';
import { cancelled, failureInfo, ProviderError, type FailureInfo } from './failure.js';
import { generateWithRetries, LookupError, type AttemptTrace, type RetryProgress } from './retry.js';

export interface AnswerCandidate {
  text: string;
  aliases: string[];
  source: 'seed' | 'history' | 'cache' | 'llm';
}
export interface FallbackResult {
  candidates: AnswerCandidate[];
  message: string;
  requests: number;
  cacheHits: number;
  networkUsed: boolean;
  retryAt?: number;
  retryable?: boolean;
  diagnostics?: { question: string; failure?: FailureInfo; attempts: AttemptTrace[]; model: string; format: string; initialTimeoutMs: number; retryBudgetMs: number; maxOutputTokens: number };
}
export interface ResolveOptions { signal?: AbortSignal; onProgress?: (value: RetryProgress) => void }
interface Subscriber { progress?: (value: RetryProgress) => void }
interface Job { promise: Promise<{ candidates: GeneratedCandidate[]; attempts: AttemptTrace[] }>; controller: AbortController; subscribers: Set<Subscriber>; settled: boolean; lastProgress?: RetryProgress }
interface RecentFailure { failure: FailureInfo; attempts: AttemptTrace[]; retryAt: number }
export interface KeyValueStore { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
interface CacheEntry { createdAt: number; expiresAt: number; candidates: GeneratedCandidate[] }
interface History { accepted: { text: string; at: number }[]; invalid: { text: string; at: number }[] }
const TTL = 24 * 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 2500;
const CACHE_PREFIX = 'krillionbot:generated:v2:';
const HISTORY_PREFIX = 'krillionbot:history:v2:';
export const METRICS_KEY = 'krillionbot:metrics:v1';

export function cacheKey(prompt: string, settings: LlmSettings): string {
  return CACHE_PREFIX + JSON.stringify(['party', normalize(prompt), settings.baseUrl, settings.format, settings.model,
    settings.jsonMode, settings.chatTokenField, PROMPT_SCHEMA_VERSION]);
}
const historyKey = (prompt: string) => HISTORY_PREFIX + JSON.stringify(['party', normalize(prompt)]);
const historyValue = (value: unknown): History => {
  const h = value as History | null;
  return h && Array.isArray(h.accepted) && Array.isArray(h.invalid) ? h : { accepted: [], invalid: [] };
};

export class AnswerCache {
  private inFlight = new Map<string, Job>();
  private failures = new Map<string, RecentFailure>();
  private writeQueue = Promise.resolve();

  constructor(private store: KeyValueStore, private session: KeyValueStore, private generate: Generate,
    private now = () => Date.now()) {}

  resetFailures(): void {
    this.failures.clear();
    for (const job of this.inFlight.values()) job.controller.abort();
    this.inFlight.clear();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(fn);
    this.writeQueue = next.then(() => {}, () => {});
    return next;
  }

  async metrics(): Promise<{ requests: number; cacheHits: number }> {
    const value = await this.store.get(METRICS_KEY) as { requests?: number; cacheHits?: number } | undefined;
    return { requests: value?.requests ?? 0, cacheHits: value?.cacheHits ?? 0 };
  }

  private async count(key: 'requests' | 'cacheHits') {
    await this.serial(async () => {
      const metrics = await this.metrics(); metrics[key]++;
      await this.store.set(METRICS_KEY, metrics);
    });
  }

  async record(prompt: string, text: string, result: 'accepted' | 'invalid'): Promise<void> {
    if (!text.trim() || text.length > 60) return;
    await this.serial(async () => {
      const key = historyKey(prompt);
      const history = historyValue(await this.store.get(key));
      const matcher = new AnswerMatcher(prompt);
      const normalized = matcher.key(text);
      history.accepted = history.accepted.filter(answer => matcher.key(answer.text) !== normalized);
      history.invalid = history.invalid.filter(answer => matcher.key(answer.text) !== normalized && answer.at > this.now() - TTL);
      if (result === 'accepted') history.accepted.unshift({ text, at: this.now() });
      else history.invalid.push({ text, at: this.now() });
      history.accepted = history.accepted.slice(0, 200);
      history.invalid = history.invalid.slice(-200);
      await this.store.set(key, history);
    });
  }

  async resolve(prompt: string, excluded: string[], settings: LlmSettings, apiKey: string,
    allowNetwork = true, options: ResolveOptions = {}): Promise<FallbackResult> {
    const history = historyValue(await this.store.get(historyKey(prompt)));
    const matcher = new AnswerMatcher(prompt);
    const blockedTexts = matcher.expand([...excluded, ...history.invalid.filter(a => a.at > this.now() - TTL).map(a => a.text)]);
    const blocked = matcher.blocked(blockedTexts);
    const constraints = questionConstraints(prompt);
    const eligible = (answers: GeneratedCandidate[]) => {
      const seen = new Set<string>();
      return answers.filter(a => {
        const key = matcher.key(a.text);
        if (blocked.has(key) || seen.has(key) || !fitsConstraints(a.text, constraints)) return false;
        seen.add(key); return true;
      });
    };
    const result = async (answers: GeneratedCandidate[], source: AnswerCandidate['source'], message: string): Promise<FallbackResult> => ({
      candidates: answers.map(answer => ({ ...answer, aliases: matcher.aliases(answer.text), source })), message, networkUsed: source === 'llm', ...await this.metrics(),
    });
    const accepted = history.accepted.filter(a => !isCurrentFactQuestion(prompt) || a.at > this.now() - suggestionTtlMs(prompt));
    const confirmed = eligible(accepted.map(a => ({ text: a.text })));
    if (confirmed.length) return result(confirmed, 'history', 'Reusing game-confirmed history');
    const key = cacheKey(prompt, settings);
    const entry = await this.store.get(key) as CacheEntry | undefined;
    const cached = entry && entry.expiresAt > this.now() ? eligible(entry.candidates) : [];
    if (cached.length) {
      await this.count('cacheHits');
      return result(cached, 'cache', 'Reusing cached suggestions (unverified)');
    }
    if (!settings.enabled) return result([], 'cache', 'No local answer. Enable LLM requests in the extension popup.');
    if (!allowNetwork) return result([], 'cache', 'Candidate batches exhausted for this category. Manual entry is available.');
    if (!settings.model) return result([], 'cache', 'Choose a model in the extension popup.');
    if (!apiKey) return result([], 'cache', 'Enter an API key in the extension popup for this browser session.');
    if (options.signal?.aborted) throw cancelled();
    const failureKey = key + JSON.stringify([settings.timeoutMs, settings.maxOutputTokens, settings.maxAttempts, settings.retryBudgetMs]);
    const rateKey = 'krillionbot:provider-delay:v1:' + JSON.stringify([settings.baseUrl, settings.format, settings.model]);
    const diagnostics = (attempts: AttemptTrace[], failure?: FailureInfo): NonNullable<FallbackResult['diagnostics']> => ({
      question: prompt, ...(failure ? { failure } : {}), attempts, model: settings.model, format: settings.format,
      initialTimeoutMs: settings.timeoutMs, retryBudgetMs: settings.retryBudgetMs, maxOutputTokens: settings.maxOutputTokens,
    });
    const failureResult = async (recent: RecentFailure, networkUsed: boolean): Promise<FallbackResult> => {
      const wait = Math.max(0, Math.ceil((recent.retryAt - this.now()) / 1000));
      return { ...await result([], 'llm', `${recent.failure.message}${wait ? ` Retry available in ${wait} s.` : ''}`),
        networkUsed, retryAt: recent.retryAt, retryable: recent.failure.retryable,
        diagnostics: diagnostics(recent.attempts, recent.failure) };
    };
    const serverDelay = Number(await this.session.get(rateKey) ?? 0);
    if (serverDelay > this.now()) return failureResult({ failure: {
      kind: 'rate-limit', message: 'Provider Retry-After delay is still active.', retryable: true,
    }, attempts: [], retryAt: serverDelay }, false);
    const recent = this.failures.get(failureKey);
    if (recent && recent.retryAt > this.now()) return failureResult(recent, false);
    let job = this.inFlight.get(key);
    if (job?.controller.signal.aborted) { this.inFlight.delete(key); job = undefined; }
    if (!job) {
      const created: Job = { promise: Promise.resolve({ candidates: [], attempts: [] }), controller: new AbortController(), subscribers: new Set(), settled: false };
      created.promise = (async () => {
        // Keep prior suggestions distinct from room exclusions: another room may still use them.
        const known = matcher.expand([...(entry && entry.expiresAt > this.now() ? entry.candidates.map(a => a.text) : []),
          ...accepted.map(a => a.text)]);
        const generated = await generateWithRetries(this.generate, { prompt, excluded: blockedTexts, known }, settings, apiKey, {
          signal: created.controller.signal, now: this.now,
          onProgress: progress => {
            created.lastProgress = progress;
            for (const subscriber of created.subscribers) { try { subscriber.progress?.(progress); } catch { /* A closed view cannot fail the provider request. */ } }
          },
          onFailure: async failure => {
            if (failure.retryAfterMs !== undefined) await this.session.set(rateKey, this.now() + failure.retryAfterMs);
          },
          beforeAttempt: async () => {
            const delay = Number(await this.session.get(rateKey) ?? 0) - this.now();
            if (delay > 0) throw new ProviderError('rate-limit', 'Provider Retry-After delay is still active.', true, 429, delay);
            await this.serial(async () => {
              const requests = Number(await this.session.get('krillionbot:sessionRequests') ?? 0);
              if (requests >= 100) throw new ProviderError('budget', 'LLM session limit reached (100 HTTP attempts).', false);
              await this.session.set('krillionbot:sessionRequests', requests + 1);
            });
            await this.count('requests');
          },
        });
        const answers = generated.candidates;
        if (created.controller.signal.aborted) throw cancelled();
        if (answers.length) await this.serial(async () => {
          const previous = await this.store.get(key) as CacheEntry | undefined;
          const old = previous && previous.expiresAt > this.now() ? previous.candidates : [];
          const merged = new Map([...old, ...answers].map(a => [matcher.key(a.text), a]));
          await this.store.set(key, { createdAt: this.now(), expiresAt: this.now() + suggestionTtlMs(prompt), candidates: [...merged.values()].slice(-100) });
        });
        return generated;
      })().finally(() => {
        created.settled = true;
        if (this.inFlight.get(key) === created) this.inFlight.delete(key);
      });
      job = created;
      this.inFlight.set(key, created);
    }
    try {
      const generated = await this.join(job, options);
      const answers = eligible(generated.candidates);
      if (!generated.candidates.length) {
        const empty: RecentFailure = { failure: { kind: 'empty', message: 'LLM completed but returned zero usable candidates.', retryable: false },
          attempts: generated.attempts, retryAt: this.now() + FAILURE_COOLDOWN_MS };
        this.failures.set(failureKey, empty);
        return failureResult(empty, true);
      }
      this.failures.delete(failureKey);
      return { ...await result(answers, 'llm', answers.length ? 'Generated suggestions (unverified)' : 'Generated answers are all excluded.'),
        diagnostics: diagnostics(generated.attempts) };
    } catch (error) {
      const failure = error instanceof LookupError ? error.failure : failureInfo(error);
      const recent: RecentFailure = { failure, attempts: error instanceof LookupError ? error.attempts : [],
        retryAt: this.now() + (failure.retryable ? Math.max(250, failure.retryAfterMs ?? 0) : FAILURE_COOLDOWN_MS) };
      if (failure.kind !== 'cancelled') this.failures.set(failureKey, recent);
      return failureResult(recent, failure.kind !== 'cancelled');
    }
  }

  private async join(job: Job, options: ResolveOptions) {
    const subscriber: Subscriber = options.onProgress ? { progress: options.onProgress } : {};
    job.subscribers.add(subscriber);
    if (job.lastProgress && !options.signal?.aborted) { try { subscriber.progress?.(job.lastProgress); } catch {} }
    let abort: () => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(cancelled());
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([job.promise, interrupted]); }
    finally {
      options.signal?.removeEventListener('abort', abort);
      job.subscribers.delete(subscriber);
      if (!job.settled && !job.subscribers.size) job.controller.abort();
    }
  }
}
