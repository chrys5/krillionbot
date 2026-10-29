import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { normalize } from './normalize.js';
import { PACKS } from './packs.js';
import type { SeedAnswer, SeedCollection, SeedDatabase, SeedPack, SeedPrompt } from './types.js';

export const contentHash = (body: string) => createHash('sha256').update(body).digest('hex');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty text');
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error('Invalid source timestamp');
  return result;
}
function parseAnswer(value: unknown, shared: boolean): SeedAnswer {
  const data = object(value);
  const score = shared ? data.points : data.score;
  if (!Number.isInteger(score) || Number(score) < 0 || Number(score) > 100) throw new Error('Invalid source score');
  const aliases = data.aliases ?? [];
  if (!Array.isArray(aliases)) throw new Error('Invalid source aliases');
  const note = shared ? data.note : data.note ?? data.quip;
  if (note != null && typeof note !== 'string') throw new Error('Invalid source note');
  return { text: text(data.answer), score: Number(score), tier: text(data.tier), aliases: aliases.map(text),
    ...(typeof note === 'string' && note.trim() ? { note } : {}) };
}
function distinctAnswers(answers: SeedAnswer[]) {
  if (!answers.length || new Set(answers.map(a => normalize(a.text))).size !== answers.length) {
    throw new Error('Empty or duplicate source answers');
  }
  return answers;
}

export function parseSharedFile(body: string, sourceFile: string, importedAt: string): SeedCollection {
  const data = object(JSON.parse(body));
  const prompts: SeedPrompt[] = Object.entries(data).map(([question, value]) => {
    const entry = object(value);
    if (entry.question !== question) throw new Error('Shared question key mismatch');
    const firstSeen = timestamp(entry.firstSeen), lastSeen = timestamp(entry.lastSeen);
    if (Date.parse(firstSeen) > Date.parse(lastSeen)) throw new Error('Reversed source timestamps');
    const answers = Object.entries(object(entry.answers)).map(([key, value]) => {
      const answer = parseAnswer(value, true);
      if (answer.text !== key) throw new Error('Shared answer key mismatch');
      return answer;
    });
    return { text: text(question), key: normalize(question), firstSeen, lastSeen, answers: distinctAnswers(answers) };
  });
  if (!prompts.length || new Set(prompts.map(p => p.key)).size !== prompts.length) throw new Error('Empty or duplicate source prompts');
  return { kind: 'shared-file', sha256: contentHash(body), importedAt: timestamp(importedAt), sourceFile: text(sourceFile), prompts };
}

export interface CompanionSource { sourceUrl: string; answersUrl: string; pack: SeedPack; chapter: number; round: string }
export function validateCompanionSource(source: CompanionSource): void {
  const page = new URL(source.sourceUrl), answers = new URL(source.answersUrl);
  if (!PACKS.includes(source.pack) || !Number.isSafeInteger(source.chapter) || source.chapter < 1 ||
      !/^r[1-7]$/u.test(source.round) || page.origin !== 'https://krillion-game.com' ||
      !page.pathname.startsWith(`/answers/${source.pack}/${source.chapter}/${source.round}-`) || page.search || page.hash ||
      answers.origin !== page.origin || answers.pathname !== '/api/answers/' ||
      answers.searchParams.get('prompt') !== `${source.pack}:${source.chapter}:${source.round}` || answers.hash) {
    throw new Error('Invalid companion source identity');
  }
}
export function parseCompanion(body: string, pageHtml: string, source: CompanionSource, importedAt: string): SeedCollection {
  validateCompanionSource(source);
  const $ = load(pageHtml);
  const id = `${source.pack}:${source.chapter}:${source.round}`;
  const containers = $('details.prompt').filter((_i, element) => $(element).attr('id') === id);
  if (containers.length !== 1) throw new Error('Companion page identity mismatch');
  const promptText = text(containers.find('.prompt-title').text().trim());
  const rawCount = containers.attr('data-total');
  const data = object(JSON.parse(body));
  if (!Array.isArray(data.answers) || !rawCount || !/^\d+$/u.test(rawCount) || data.answers.length !== Number(rawCount)) {
    throw new Error('Incomplete companion answers');
  }
  const answers = distinctAnswers(data.answers.map(value => parseAnswer(value, false)));
  return { kind: 'companion', sha256: contentHash(source.sourceUrl + '\n' + body + '\n' + promptText), importedAt: timestamp(importedAt),
    sourceUrl: source.sourceUrl, answersUrl: source.answersUrl, pack: source.pack, chapter: source.chapter,
    prompts: [{ round: source.round, text: promptText, key: normalize(promptText), answers }] };
}

export function appendCollection(database: SeedDatabase, collection: SeedCollection): boolean {
  const id = `${collection.kind}:${collection.sha256}`;
  if (database.collections?.[id]) return false;
  (database.collections ??= {})[id] = collection;
  return true;
}
