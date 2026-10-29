import { normalize } from '../data/normalize.js';
import type { SeedIndex } from '../data/shards.js';
import type { SeedDatabase } from '../data/types.js';
import { SeedLookup } from './seed-lookup.js';

export class BundledSeed {
  private index: Promise<SeedIndex> | null = null;
  private current: { key: string; lookup: Promise<SeedLookup> } | null = null;

  constructor(private read: (path: string) => Promise<unknown>) {}

  private getIndex(): Promise<SeedIndex> {
    return this.index ??= this.read('seed/index.json').then(value => {
      const index = value as SeedIndex;
      if (index?.schemaVersion !== 1 || !index.prompts || typeof index.prompts !== 'object' ||
          Array.isArray(index.prompts) || Object.entries(index.prompts).some(([key, path]) =>
            key !== normalize(key) || typeof path !== 'string' || !/^seed\/prompts\/[a-f0-9]{64}\.json$/u.test(path))) {
        throw new Error('Invalid bundled seed index');
      }
      return index;
    }).catch(error => { this.index = null; throw error; });
  }

  async promptKeys(): Promise<string[]> { return Object.keys((await this.getIndex()).prompts); }

  private async forPrompt(prompt: string): Promise<SeedLookup | null> {
    const key = normalize(prompt);
    const index = await this.getIndex();
    if (!Object.hasOwn(index.prompts, key)) { this.current = null; return null; }
    // Keep one promise so turns and retries share both pending and completed loads.
    if (this.current?.key !== key) {
      this.current = { key, lookup: this.read(index.prompts[key]!).then(value => {
        const database = value as SeedDatabase;
        if (database?.schemaVersion !== 1 || !database.days) throw new Error('Invalid bundled seed question');
        const result = new SeedLookup(database);
        if (result.promptKeys().length !== 1 || !result.hasPrompt(key)) throw new Error('Bundled seed question mismatch');
        return result;
      }) };
    }
    const current = this.current;
    try {
      return await current.lookup;
    } catch (error) {
      // A failed earlier question must not discard a newer question's load.
      if (this.current === current) this.current = null;
      throw error;
    }
  }

  async lookup(prompt: string, options: Parameters<SeedLookup['lookup']>[1] = {}) {
    return (await this.forPrompt(prompt))?.lookup(prompt, options) ?? [];
  }

  async expandExcluded(prompt: string, answers: string[]): Promise<string[]> {
    return (await this.forPrompt(prompt))?.expandExcluded(prompt, answers) ?? answers;
  }
}
