import type { SeedDatabase } from './types.js';

export interface SeedIndex {
  schemaVersion: 1;
  prompts: Record<string, string>;
}

// Preserve every observation and its provenance; only partition by exact prompt key.
export function partitionSeed(database: SeedDatabase): Map<string, SeedDatabase> {
  const shards = new Map<string, SeedDatabase>();
  const shard = (key: string) => {
    let value = shards.get(key);
    if (!value) {
      value = { schemaVersion: 1, source: database.source, days: {} };
      shards.set(key, value);
    }
    return value;
  };
  for (const [id, day] of Object.entries(database.days)) {
    for (const prompt of day.prompts) shard(prompt.key).days[id] = { ...day, prompts: [prompt] };
  }
  for (const [id, chapter] of Object.entries(database.chapters ?? {})) {
    for (const prompt of chapter.prompts) {
      (shard(prompt.key).chapters ??= {})[id] = { ...chapter, prompts: [prompt] };
    }
  }
  for (const [id, collection] of Object.entries(database.collections ?? {})) {
    for (const prompt of collection.prompts) {
      (shard(prompt.key).collections ??= {})[id] = { ...collection, prompts: [prompt] };
    }
  }
  return shards;
}
