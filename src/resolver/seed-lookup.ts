import { normalize } from '../data/normalize.js';
import type { SeedDatabase, SeedPack, SeedPrompt } from '../data/types.js';
import { seedRecords, type SeedRecord } from '../data/records.js';

export interface SeedCandidate {
  text: string;
  aliases: string[];
  score: number;
  tier: string;
  date: string;
  sourceUrl: string;
  source: 'seed';
  pack?: SeedPack;
  chapter?: number;
  sourceFile?: string;
  sourceKind?: SeedRecord['sourceKind'];
  note?: string;
  noteSource?: { kind: SeedRecord['sourceKind']; sourceUrl?: string; sourceFile?: string };
}

export class SeedLookup {
  // Index prompt references, not a second copy of the entire answer corpus.
  private readonly index = new Map<string, { prompt: SeedPrompt; record: SeedRecord }[]>();

  constructor(database: SeedDatabase) {
    for (const record of seedRecords(database)) {
      for (const prompt of record.prompts) {
        const records = this.index.get(prompt.key) ?? [];
        records.push({ prompt, record });
        this.index.set(prompt.key, records);
      }
    }
  }

  lookup(prompt: string, options: {
    used?: Iterable<string>; rejected?: Iterable<string>; limit?: number; maxLength?: number;
  } = {}): SeedCandidate[] {
    const excluded = new Set([...options.used ?? [], ...options.rejected ?? []].map(normalize));
    const records = [...this.index.get(normalize(prompt)) ?? []].sort((a, b) =>
      a.record.priority - b.record.priority ||
      Date.parse(b.prompt.lastSeen ?? b.record.date) - Date.parse(a.prompt.lastSeen ?? a.record.date));
    const candidates = new Map<string, SeedCandidate>();
    // Official reveal > daily archive > shared file > companion. Latest date breaks ties.
    // All conflicting observations remain intact in their source snapshots.
    for (const { prompt: entry, record } of records) {
      const { sourceUrl, pack, chapter, sourceFile, sourceKind } = record;
      const date = entry.lastSeen?.slice(0, 10) ?? record.date;
      const noteSource = { kind: sourceKind, ...(sourceUrl ? { sourceUrl } : {}),
        ...(sourceFile === undefined ? {} : { sourceFile }) };
      for (const answer of entry.answers) {
        const key = normalize(answer.text);
        if (!candidates.has(key)) candidates.set(key, { ...answer, date, sourceUrl, sourceKind, source: 'seed',
          ...(answer.note ? { noteSource } : {}),
          ...(sourceFile === undefined ? {} : { sourceFile }),
          ...(pack === undefined ? {} : { pack, chapter: chapter! }) });
        else {
          // Keep aliases from older snapshots useful for duplicate/rejection filtering.
          const current = candidates.get(key)!;
          current.aliases = [...new Set([...current.aliases, ...answer.aliases])];
          if (!current.note && answer.note) { current.note = answer.note; current.noteSource = noteSource; }
        }
      }
    }
    return [...candidates.values()]
      .filter(answer => answer.text.length <= (options.maxLength ?? Infinity) &&
        ![answer.text, ...answer.aliases].some(text => excluded.has(normalize(text))))
      .sort((a, b) => b.score - a.score || a.text.length - b.text.length || a.text.localeCompare(b.text))
      .slice(0, options.limit ?? 10);
  }

  hasPrompt(prompt: string): boolean { return this.index.has(normalize(prompt)); }
  promptKeys(): string[] { return [...this.index.keys()]; }
}
