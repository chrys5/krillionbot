export interface SeedAnswer {
  text: string;
  score: number;
  tier: string;
  aliases: string[];
  note?: string;
}

export interface SeedPrompt {
  round?: string;
  firstSeen?: string;
  lastSeen?: string;
  text: string;
  key: string;
  answers: SeedAnswer[];
}

export type SeedPack = 'movies' | 'sports' | 'geography' | 'lexicon' | 'unlimited';

export interface SeedChapter {
  pack: SeedPack;
  chapter: number;
  sourceUrl: string;
  fetchedAt: string;
  version: string;
  prompts: SeedPrompt[];
}

export interface SeedDay {
  date: string;
  dive: number;
  sourceUrl: string;
  prompts: SeedPrompt[];
}

export interface SeedDatabase {
  schemaVersion: 1;
  source: string;
  days: Record<string, SeedDay>;
  // Optional so the original daily-only artifact remains readable without migration.
  chapters?: Record<string, SeedChapter>;
  collections?: Record<string, SeedCollection>;
}

export interface SeedCollection {
  kind: 'shared-file' | 'companion';
  sha256: string;
  importedAt: string;
  sourceFile?: string;
  sourceUrl?: string;
  answersUrl?: string;
  pack?: SeedPack;
  chapter?: number;
  prompts: SeedPrompt[];
}

export interface ImportReport {
  checkedAt: string;
  archivePagesFetched: number;
  discoveredDays: number;
  skippedDays: number;
  importedDays: string[];
  failures: { url: string; error: string }[];
  totalDays: number;
  uniquePrompts: number;
  answerRows: number;
}
