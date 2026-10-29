import { normalize } from '../data/normalize.js';
import type { SeedLookup } from '../resolver/seed-lookup.js';
import type { AnswerCandidate, FallbackResult, ResolveOptions } from '../llm/cache.js';
import type { RetryProgress } from '../llm/retry.js';
import { fillAnswer, readGame, sameCategory } from './adapter.js';
import { categoryKey, usedAnswers, type PartyState, type Observation } from './protocol.js';
import { requestFailureMessage } from './messaging.js';
import { diagnosticError, diagnosticLevel, type DiagnosticEvent } from './diagnostics.js';

export interface BotStatus {
  enabled: boolean; message: string; prompt: string; lastAnswer: string; submissions: number;
  source?: AnswerCandidate['source']; seedMatched?: boolean; eligible?: number;
  llmRequests?: number; cacheHits?: number; events?: { at: string; message: string }[];
  usedCount?: number; rejectedCount?: number; nextCandidates?: AnswerCandidate[];
  llmDiagnostics?: FallbackResult['diagnostics']; llmProgress?: RetryProgress; retryAt?: number;
  inputFailures?: number; submissionTimeouts?: number; autoRecovery?: boolean;
}
export interface Fallback {
  resolve(prompt: string, excluded: string[], allowNetwork: boolean, options?: ResolveOptions): Promise<FallbackResult>;
  record(prompt: string, answer: string, result: 'accepted' | 'invalid'): Promise<void>;
}
interface PreparedInput {
  input: HTMLInputElement; answer: string; edited: boolean; writing: boolean;
  listener: (event: Event) => void;
}
export interface InputTiming { readyTimeoutMs: number; retryDelayMs: number; submissionTimeoutMs?: number }
interface PendingSubmission {
  answer: string; aliases: string[]; category: string; turn: number | null; version: number;
  startedAt: number; timer: ReturnType<typeof setTimeout>;
}

export class BotController {
  private state: PartyState | null = null;
  private category = '';
  private rejected = new Set<string>();
  private unconfirmed = new Set<string>();
  private used = new Set<string>();
  private queue: AnswerCandidate[] = [];
  private external: AnswerCandidate[] = [];
  private resolvedSignature = '';
  private resolvingEpoch: number | null = null;
  private networkBatches = 0;
  private fallbackMessage = '';
  private lookupAbort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private reported = '';
  private acceptedTurn = '';
  private attemptTurn = '';
  private attempts = 0;
  private queueKey = '';
  private pending: PendingSubmission | null = null;
  private busy = false;
  private preparation: PreparedInput | null = null;
  private preparationFailures = 0;
  private inputRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private inputRetryAt = 0;
  private epoch = 0;
  private autoRecovery = true;
  private status: BotStatus = { enabled: false, message: 'Off', prompt: '', lastAnswer: '', submissions: 0 };

  constructor(private document: Document, private lookup: Pick<SeedLookup, 'lookup' | 'hasPrompt'>, private report: (status: BotStatus) => void,
    private fallback?: Fallback, private inputTiming: InputTiming = { readyTimeoutMs: 1000, retryDelayMs: 250 },
    private log: (event: DiagnosticEvent) => void = () => {}) {}

  getStatus(): BotStatus { return { ...this.status }; }
  setAutoRecovery(enabled: boolean): void {
    this.autoRecovery = enabled;
    this.status.autoRecovery = enabled;
    this.update(this.status.message);
  }

  private resetWork(): void {
    this.epoch++;
    this.cancelLookup();
    this.releaseInput(true);
    this.clearInputRetry();
    this.preparationFailures = 0;
    this.resolvedSignature = '';
    this.queueKey = '';
  }

  enable(): void {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending = null; }
    this.resetWork();
    this.status.enabled = true;
    this.clearRetry();
    this.networkBatches = 0;
    this.resolvedSignature = '';
    this.update('Waiting for a live category');
    void this.tick();
  }

  stop(message = 'Off'): void {
    this.epoch++;
    this.cancelLookup();
    this.status.enabled = false;
    this.clearInputRetry();
    this.releaseInput(true);
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    this.resolvingEpoch = null;
    this.update(message);
  }

  observe(observation: Observation): void {
    if (observation.type === 'disconnected') {
      this.diagnostic('error', 'game.disconnected', 'Game connection or state interrupted.');
      this.state = null;
      this.stop('Connection/state interrupted. Reload, then enable again.');
      return;
    }
    if (observation.type === 'result') {
      if (!this.pending || observation.answer !== this.pending.answer || observation.category !== this.category) {
        const reconciled = observation.accepted && observation.category === this.category && this.unconfirmed.has(observation.answer);
        this.diagnostic(reconciled ? 'info' : 'warning', 'submission.late-result',
          reconciled ? 'Accepted result arrived after game-state reconciliation or timeout.' : 'Unmatched or late submission result.', observation);
        return;
      }
      const answer = this.pending.answer;
      const turn = this.pending.turn;
      clearTimeout(this.pending.timer);
      this.pending = null;
      this.diagnostic(observation.accepted ? 'info' : 'warning', 'submission.result',
        observation.accepted ? 'Submission accepted.' : 'Submission rejected or unconfirmed.', observation);
      if (observation.accepted) {
        this.used.add(answer);
        this.acceptedTurn = `${this.category}:${turn}`;
        this.learn(answer, 'accepted');
      }
      else if (['miss', 'repeat'].includes(observation.why)) {
        this.rejected.add(answer);
        if (observation.why === 'miss') this.learn(answer, 'invalid');
      }
      else { this.stop(`Submission not confirmed (${observation.why || 'unknown result'}).`); return; }
      this.queueKey = '';
      this.update(observation.accepted ? `Accepted: ${answer}` : `Rejected: ${answer}; trying next`);
      this.releaseInput(true);
      // Let the game's promise settle and its Send button become ready.
      setTimeout(() => { void this.tick(); }, 0);
      return;
    }
    this.state = observation.state;
    void this.tick();
  }

  async tick(): Promise<void> {
    if (!this.status.enabled || this.busy) return;
    const state = this.state;
    if (!state || state.phase !== 'round' || !state.category) {
      if (this.pending) this.finishPending('Game left the answer round.', 'info');
      this.clearInputRetry();
      if (this.lookupAbort || this.retryTimer) { this.epoch++; this.cancelLookup(); this.resolvedSignature = ''; }
      this.update('Waiting for a live category');
      return;
    }
    const key = categoryKey(state);
    if (key !== this.category) {
      this.cancelLookup();
      if (this.pending) this.finishPending('Category changed before submission acknowledgement.', 'info');
      this.epoch++;
      this.category = key;
      this.rejected.clear(); this.unconfirmed.clear(); this.used.clear(); this.queueKey = ''; this.acceptedTurn = '';
      this.external = []; this.resolvedSignature = ''; this.networkBatches = 0;
      this.resolvingEpoch = null; this.fallbackMessage = '';
      this.preparationFailures = 0; this.clearInputRetry();
      delete this.status.llmDiagnostics;
    }
    this.status.prompt = state.category.text;
    this.status.seedMatched = this.lookup.hasPrompt(state.category.text);
    const used = usedAnswers(state);
    if (!used) { this.stop('Used-answer list is incomplete. Re-enable at a new category.'); return; }
    for (const answer of used) {
      if (!this.used.has(answer)) this.learn(answer, 'accepted');
      this.used.add(answer);
    }
    if (this.pending) {
      const appeared = used.some(answer => [this.pending!.answer, ...this.pending!.aliases].some(alias => normalize(alias) === normalize(answer)));
      if (!appeared && state.holderSince === this.pending.turn) return;
      if (appeared) this.acceptedTurn = `${key}:${this.pending.turn}`;
      this.finishPending(appeared ? 'Answer appears in the used list; continuing from game state.' : 'Turn changed before submission acknowledgement.', 'info');
    }
    if (this.acceptedTurn === `${key}:${state.holderSince}`) return;
    const turn = `${key}:${state.holderSince}`;
    if (turn !== this.attemptTurn) {
      this.attemptTurn = turn; this.attempts = 0; this.preparationFailures = 0; this.clearInputRetry();
    }
    if (this.attempts >= 3) { this.update('Three attempts this turn. Manual entry is available.'); return; }
    const signature = JSON.stringify([key, [...this.used].sort(), [...this.rejected].sort(), [...this.unconfirmed].sort()]);
    if (signature !== this.queueKey) {
      this.queue = this.lookup.lookup(state.category.text, { used: [...this.used, ...this.unconfirmed], rejected: this.rejected, maxLength: 60 });
      if (!this.queue.length) {
        const blocked = new Set([...this.used, ...this.rejected, ...this.unconfirmed].map(normalize));
        this.queue = this.external.filter(candidate => ![candidate.text, ...candidate.aliases].some(a => blocked.has(normalize(a))));
      }
      this.queueKey = signature;
    }
    this.status.eligible = this.queue.length;
    this.status.usedCount = this.used.size;
    this.status.rejectedCount = this.rejected.size;
    this.status.nextCandidates = this.queue.slice(0, 5);
    if (!this.queue.length) {
      delete this.status.source;
      const reason = this.status.seedMatched ? 'Seed question matched.' : 'No seed question match.';
      if (this.fallback && this.resolvingEpoch === null && this.resolvedSignature !== signature && !this.retryTimer) {
        this.resolvedSignature = signature;
        const epoch = this.epoch;
        this.resolvingEpoch = epoch;
        const abort = new AbortController();
        this.lookupAbort = abort;
        this.update(`${reason} Checking seed/history/cache/LLM…`);
        void this.fallback.resolve(state.category.text, [...this.used, ...this.rejected, ...this.unconfirmed], this.networkBatches < 2, {
          signal: abort.signal,
          onProgress: progress => {
            if (epoch !== this.epoch || !this.status.enabled) return;
            this.status.llmProgress = progress;
            this.update(`${reason} ${progress.message}`);
          },
        })
          .then(result => {
            if (epoch !== this.epoch || !this.status.enabled) return;
            this.external = result.candidates;
            if (result.networkUsed) this.networkBatches++;
            this.status.llmRequests = result.requests;
            this.status.cacheHits = result.cacheHits;
            this.status.llmDiagnostics = result.diagnostics;
            delete this.status.llmProgress;
            this.fallbackMessage = result.message;
            this.queueKey = '';
            if (!result.candidates.length && result.retryable && result.retryAt && this.networkBatches < 2) {
              this.scheduleRetry(result.retryAt, epoch);
            }
          }).catch(error => {
            if (epoch === this.epoch) {
              this.diagnostic('error', 'lookup.failed', 'Answer lookup failed.', diagnosticError(error));
              delete this.status.llmProgress;
              this.fallbackMessage = `Fallback failed. ${requestFailureMessage(error)}`;
            }
          }).finally(() => {
            if (this.resolvingEpoch === epoch) this.resolvingEpoch = null;
            if (this.lookupAbort === abort) this.lookupAbort = null;
            if (epoch === this.epoch) void this.tick();
          });
      } else if (this.resolvingEpoch === null) {
        this.update(`${reason} ${this.fallbackMessage || 'Manual entry is available.'}`);
      }
      return;
    }
    this.clearRetry();
    this.status.source = this.queue[0]!.source;
    const dom = readGame(this.document);
    if (!sameCategory(dom, state) || !dom.ourTurn) { this.update(`Ready; waiting for your turn · ${this.status.source}`); return; }
    if (!dom.input || !dom.send || dom.input.value.trim()) {
      this.update('Waiting for an empty input; keeping your manual answer'); return;
    }
    if (this.preparationFailures >= 3) {
      this.update('Send button stayed unavailable after 3 preparations. Waiting for next turn; manual entry is available.'); return;
    }
    if (this.inputRetryAt > Date.now()) { this.update('Waiting for game controls before retrying input…'); return; }
    this.busy = true;
    const epoch = this.epoch;
    const candidate = this.queue[0]!;
    const answer = candidate.text;
    try {
      const prepared = this.ownInput(dom.input, answer);
      prepared.writing = true;
      try { fillAnswer(dom.input, answer); } finally { prepared.writing = false; }
      // Yield for the game's controlled input, then wait for its Send handler/button to render.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const deadline = Date.now() + this.inputTiming.readyTimeoutMs;
      let fresh = readGame(this.document);
      while (true) {
        fresh = readGame(this.document);
        if (!this.status.enabled || epoch !== this.epoch || this.preparation !== prepared || prepared.edited ||
            this.state?.phase !== 'round' || categoryKey(this.state) !== key ||
            this.state.holderSince !== state.holderSince || !fresh.ourTurn || !sameCategory(fresh, this.state)) {
          this.diagnostic('info', 'input.cancelled', 'Input preparation cancelled after a turn, state, or manual-input change.');
          return;
        }
        // React can replace the node while retaining our controlled value. Manual input events relinquish ownership.
        if (fresh.input && fresh.input !== prepared.input && fresh.input.value === answer) prepared.input = fresh.input;
        if (!fresh.input || fresh.input !== prepared.input || fresh.input.value !== answer) {
          this.retryInput(epoch); return;
        }
        const nowUsed = usedAnswers(this.state);
        if (!nowUsed || nowUsed.some(text => [answer, ...candidate.aliases].some(alias => normalize(text) === normalize(alias)))) {
          this.queueKey = ''; return;
        }
        if (fresh.send && !fresh.send.disabled) break;
        if (Date.now() >= deadline) { this.retryInput(epoch); return; }
        this.update('Preparing answer; waiting for the Send button…');
        await new Promise<void>(resolve => setTimeout(resolve, 16));
      }
      const timer = setTimeout(() => {
        if (!this.pending || this.pending.timer !== timer || !this.status.enabled) return;
        this.status.submissionTimeouts = (this.status.submissionTimeouts ?? 0) + 1;
        if (!this.autoRecovery) {
          this.diagnostic('error', 'submission.timeout', 'No submission result after timeout; automatic recovery is off.');
          this.stop('No submission result after 5 seconds. Enable to retry, or turn on automatic recovery.');
          return;
        }
        this.finishPending('No submission result before timeout; rechecking the game and trying another eligible answer.');
        this.resetWork();
        this.external = [];
        void this.tick();
      }, this.inputTiming.submissionTimeoutMs ?? 5000);
      this.pending = { answer, aliases: candidate.aliases, category: key, turn: state.holderSince,
        version: state.version, startedAt: Date.now(), timer };
      this.status.lastAnswer = answer;
      this.status.submissions++;
      this.attempts++;
      this.preparationFailures = 0;
      this.update(`Submitting (${candidate.source}): ${answer}`);
      this.diagnostic('info', 'submission.sent', 'Clicking Send answer.');
      fresh.send!.click();
    } catch (error) {
      this.diagnostic('error', 'input.exception', 'Answer input operation failed.', diagnosticError(error));
      this.stop(`Input error: ${requestFailureMessage(error)}`);
    } finally {
      if (!this.pending) this.releaseInput(true);
      this.busy = false;
      if (this.status.enabled && !this.pending) queueMicrotask(() => { void this.tick(); });
    }
  }

  private finishPending(message: string, level: DiagnosticEvent['level'] = 'warning'): void {
    if (!this.pending) return;
    this.diagnostic(level, 'submission.recovery', message);
    clearTimeout(this.pending.timer);
    // No rejection evidence: exclude for this category without learning invalidity.
    this.unconfirmed.add(this.pending.answer);
    for (const alias of this.pending.aliases) this.unconfirmed.add(alias);
    this.pending = null;
    this.releaseInput(true);
    this.queueKey = '';
    this.update(message);
  }

  private diagnostic(level: DiagnosticEvent['level'], event: string, message: string, detail?: unknown): void {
    const dom = readGame(this.document);
    try { this.log({ level, event, message, context: {
      capturedAt: new Date().toISOString(), status: this.getStatus(), game: this.state,
      category: this.category, attempts: this.attempts, preparationFailures: this.preparationFailures,
      rejected: [...this.rejected], unconfirmed: [...this.unconfirmed], used: [...this.used],
      pending: this.pending ? { answer: this.pending.answer, aliases: this.pending.aliases, turn: this.pending.turn,
        category: this.pending.category, version: this.pending.version, elapsedMs: Date.now() - this.pending.startedAt } : null,
      dom: { prompt: dom.prompt, ourTurn: dom.ourTurn, hasInput: !!dom.input, inputLength: dom.input?.value.length,
        inputMatchesBot: dom.input?.value === this.status.lastAnswer, inputEdited: this.preparation?.edited,
        inputDisabled: dom.input?.disabled, inputReadOnly: dom.input?.readOnly, placeholder: dom.input?.placeholder,
        hasSend: !!dom.send, sendDisabled: dom.send?.disabled }, detail,
    } }); } catch { /* Diagnostics must not interrupt gameplay. */ }
  }

  private ownInput(input: HTMLInputElement, answer: string): PreparedInput {
    const prepared: PreparedInput = { input, answer, edited: false, writing: false, listener: () => {} };
    prepared.listener = event => {
      const target = event.target as Element | null;
      if (!prepared.writing && target?.matches?.('.pf-root input[aria-label="Your answer"]')) prepared.edited = true;
    };
    this.document.addEventListener('input', prepared.listener, true);
    this.preparation = prepared;
    return prepared;
  }

  private releaseInput(clear: boolean): void {
    const prepared = this.preparation;
    if (!prepared) return;
    this.preparation = null;
    this.document.removeEventListener('input', prepared.listener, true);
    if (clear && !prepared.edited) {
      const current = readGame(this.document).input;
      for (const input of new Set([prepared.input, current])) {
        if (input?.value === prepared.answer) fillAnswer(input, '');
      }
    }
  }

  private clearInputRetry(): void {
    if (this.inputRetryTimer) clearTimeout(this.inputRetryTimer);
    this.inputRetryTimer = null; this.inputRetryAt = 0;
  }

  private retryInput(epoch: number): void {
    this.preparationFailures++;
    this.diagnostic('warning', 'input.retry', 'Answer input or Send button did not become ready.');
    this.clearInputRetry();
    if (this.preparationFailures >= 3) return;
    this.inputRetryAt = Date.now() + this.inputTiming.retryDelayMs;
    this.inputRetryTimer = setTimeout(() => {
      this.inputRetryTimer = null; this.inputRetryAt = 0;
      if (epoch === this.epoch && this.status.enabled) void this.tick();
    }, this.inputTiming.retryDelayMs);
  }

  private update(message: string): void {
    this.status.inputFailures = this.preparationFailures;
    if (this.status.message !== message) {
      this.status.message = message;
      this.status.events = [...this.status.events ?? [], { at: new Date().toISOString(), message }].slice(-25);
      const level = diagnosticLevel(message);
      if (level) this.diagnostic(level, 'bot.status', message);
    }
    const snapshot = JSON.stringify(this.status);
    if (snapshot === this.reported) return;
    this.reported = snapshot;
    this.report(this.getStatus());
  }

  private learn(answer: string, result: 'accepted' | 'invalid'): void {
    const prompt = this.state?.category?.text;
    if (prompt && this.fallback) void this.fallback.record(prompt, answer, result).catch(error => {
      this.diagnostic('error', 'history.write', 'Could not save answer history.', diagnosticError(error));
      this.update(`Could not save answer history. ${requestFailureMessage(error)}`);
    });
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    delete this.status.retryAt;
  }

  private cancelLookup(): void {
    this.lookupAbort?.abort(); this.lookupAbort = null;
    this.resolvingEpoch = null;
    this.clearRetry();
    delete this.status.llmProgress;
  }

  private scheduleRetry(at: number, epoch: number): void {
    this.clearRetry(); this.status.retryAt = at;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.status.enabled || epoch !== this.epoch || this.state?.phase !== 'round') return;
      if (Date.now() < at) { this.scheduleRetry(at, epoch); return; }
      delete this.status.retryAt;
      this.resolvedSignature = '';
      void this.tick();
    }, Math.min(2147483647, Math.max(10, at - Date.now())));
  }
}
