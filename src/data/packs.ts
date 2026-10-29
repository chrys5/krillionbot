import { normalize } from './normalize.js';
import type { SeedChapter, SeedDatabase, SeedPack, SeedPrompt } from './types.js';

export const PACKS: SeedPack[] = ['movies', 'sports', 'geography', 'lexicon', 'unlimited'];
export const packBase = (pack: SeedPack) => `https://krillion.io/api/${pack === 'unlimited' ? pack : `packs/${pack}`}`;
export const chapterKey = (pack: SeedPack, chapter: number) => `${pack}/${chapter}`;
export interface PublicResponse { status: number; body: string }
export type FetchPublic = (url: string) => Promise<PublicResponse>;
interface ChapterResult {
  pack: SeedPack; chapter: number; sourceUrl: string;
  status: 'imported' | 'skipped' | 'locked' | 'unavailable' | 'failed';
  httpStatus?: number; error?: string; answerRows?: number;
}
export interface PackReport {
  checkedAt: string;
  catalogues: { pack: SeedPack; sourceUrl: string; lastGame: number }[];
  chapters: ChapterResult[];
  failures: { url: string; error: string }[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty text');
  return value;
}
export function parseMetadata(body: string, chapter: number) {
  const data = object(JSON.parse(body));
  if (data.game !== chapter || !Number.isSafeInteger(data.lastGame) || Number(data.lastGame) < chapter ||
      Number(data.lastGame) > 10_000 || !Array.isArray(data.prompts) || data.prompts.length !== 7) {
    throw new Error('Invalid chapter metadata/identity');
  }
  const prompts = data.prompts.map(value => {
    const prompt = object(value);
    return { round: text(prompt.id), text: text(prompt.text) };
  });
  if (new Set(prompts.map(p => p.round)).size !== 7 || new Set(prompts.map(p => normalize(p.text))).size !== 7) {
    throw new Error('Expected 7 distinct metadata prompts');
  }
  return { lastGame: Number(data.lastGame), version: text(data.version), prompts };
}

export function parseReveal(body: string, pack: SeedPack, chapter: number,
  metadata: ReturnType<typeof parseMetadata>, fetchedAt: string): SeedChapter {
  const data = object(JSON.parse(body));
  if (!Array.isArray(data.rounds) || data.rounds.length !== 7) throw new Error('Expected 7 reveal rounds');
  const rounds = new Set<string>();
  const prompts: SeedPrompt[] = data.rounds.map(value => {
    const round = object(value);
    const id = text(round.round);
    const promptText = text(round.text);
    if (rounds.has(id) || !metadata.prompts.some(p => p.round === id && p.text === promptText)) {
      throw new Error('Reveal prompt identity mismatch');
    }
    rounds.add(id);
    if (!Array.isArray(round.answers) || !round.answers.length) throw new Error('Missing reveal answers');
    const seen = new Set<string>();
    const answers = round.answers.map(value => {
      const answer = object(value);
      const answerText = text(answer.answer);
      if (!Number.isInteger(answer.score) || Number(answer.score) < 0 || Number(answer.score) > 100) {
        throw new Error('Invalid answer score');
      }
      const aliases = answer.aliases === undefined ? [] : answer.aliases;
      if (!Array.isArray(aliases)) throw new Error('Invalid aliases');
      const key = normalize(answerText);
      if (seen.has(key)) throw new Error(`Duplicate answer: ${answerText}`);
      seen.add(key);
      return { text: answerText, score: Number(answer.score), tier: text(answer.tier), aliases: aliases.map(text) };
    });
    return { round: id, text: promptText, key: normalize(promptText), answers };
  });
  return { pack, chapter, sourceUrl: `${packBase(pack)}/${chapter}/reveal`, fetchedAt,
    version: metadata.version, prompts };
}

// Probe every advertised chapter: a locked chapter does not imply later ones are locked.
// Existing chapter snapshots are immutable and never fetched again.
export async function updatePacks(database: SeedDatabase, fetchPublic: FetchPublic,
  options: { packs?: SeedPack[]; onProgress?: (message: string) => void } = {}): Promise<PackReport> {
  const report: PackReport = { checkedAt: new Date().toISOString(), catalogues: [], chapters: [], failures: [] };
  for (const pack of options.packs ?? PACKS) {
    const catalogueUrl = `${packBase(pack)}/1`;
    try {
      const catalogue = await fetchPublic(catalogueUrl);
      if (catalogue.status !== 200) throw new Error(`Catalogue HTTP ${catalogue.status}`);
      const first = parseMetadata(catalogue.body, 1);
      report.catalogues.push({ pack, sourceUrl: catalogueUrl, lastGame: first.lastGame });
      for (let chapter = 1; chapter <= first.lastGame; chapter++) {
        const sourceUrl = `${packBase(pack)}/${chapter}/reveal`;
        const result: ChapterResult = { pack, chapter, sourceUrl, status: 'failed' };
        report.chapters.push(result);
        if (database.chapters?.[chapterKey(pack, chapter)]) { result.status = 'skipped'; continue; }
        try {
          const response = await fetchPublic(sourceUrl);
          result.httpStatus = response.status;
          if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
          let payload: Record<string, unknown> | undefined;
          try { payload = object(JSON.parse(response.body)); } catch { /* HTML errors are unavailable, never data. */ }
          if (response.status === 402 || payload?.locked === true || payload?.error === 'locked') {
            result.status = 'locked'; result.error = 'Publisher requires unlock';
          } else if (response.status !== 200) {
            result.status = 'unavailable'; result.error = `HTTP ${response.status}`;
          } else {
            const metadataResponse = chapter === 1 ? catalogue : await fetchPublic(`${packBase(pack)}/${chapter}`);
            if (metadataResponse.status !== 200) throw new Error(`Chapter metadata HTTP ${metadataResponse.status}`);
            const metadata = chapter === 1 ? first : parseMetadata(metadataResponse.body, chapter);
            const record = parseReveal(response.body, pack, chapter, metadata, report.checkedAt);
            (database.chapters ??= {})[chapterKey(pack, chapter)] = record;
            result.status = 'imported';
            result.answerRows = record.prompts.reduce((n, p) => n + p.answers.length, 0);
          }
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error);
          if (result.httpStatus === 429 || (result.httpStatus ?? 0) >= 500) {
            report.failures.push({ url: sourceUrl, error: result.error });
            break;
          }
        }
        options.onProgress?.(`${pack}/${chapter}: ${result.status}${result.answerRows ? ` (${result.answerRows} answers)` : ''}`);
      }
    } catch (error) {
      report.failures.push({ url: catalogueUrl, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
