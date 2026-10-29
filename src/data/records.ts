import type { SeedDatabase, SeedPack, SeedPrompt } from './types.js';

export interface SeedRecord {
  prompts: SeedPrompt[];
  date: string;
  sourceUrl: string;
  priority: number;
  sourceKind: 'official' | 'archive' | 'shared-file' | 'companion';
  sourceFile?: string;
  pack?: SeedPack;
  chapter?: number;
}

export function seedRecords(database: SeedDatabase): SeedRecord[] {
  return [
    ...Object.values(database.days).map(day => ({ prompts: day.prompts, date: day.date,
      sourceUrl: day.sourceUrl, priority: 1, sourceKind: 'archive' as const })),
    ...Object.values(database.chapters ?? {}).map(chapter => ({ prompts: chapter.prompts,
      date: chapter.fetchedAt.slice(0, 10), sourceUrl: chapter.sourceUrl, priority: 0,
      sourceKind: 'official' as const, pack: chapter.pack, chapter: chapter.chapter })),
    ...Object.values(database.collections ?? {}).map(collection => ({ prompts: collection.prompts,
      date: collection.importedAt.slice(0, 10), sourceUrl: collection.sourceUrl ?? '',
      priority: collection.kind === 'shared-file' ? 2 : 3, sourceKind: collection.kind,
      ...(collection.sourceFile === undefined ? {} : { sourceFile: collection.sourceFile }),
      ...(collection.pack === undefined ? {} : { pack: collection.pack }),
      ...(collection.chapter === undefined ? {} : { chapter: collection.chapter }) })),
  ];
}
