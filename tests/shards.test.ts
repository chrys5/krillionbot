import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionSeed, type SeedIndex } from '../src/data/shards.js';
import type { SeedDatabase, SeedPrompt } from '../src/data/types.js';
import { BundledSeed } from '../src/resolver/bundled-seed.js';
import { SeedLookup } from '../src/resolver/seed-lookup.js';

const prompt = (key: string, score = 100): SeedPrompt => ({
  key, text: key, answers: [{ text: 'Coffee', score, tier: 'krillion', aliases: [] },
    { text: 'Tea', score: 85, tier: 'deepcut', aliases: [] }],
});
const database = (): SeedDatabase => ({
  schemaVersion: 1, source: 'fixture', days: {
    day: { date: '2026-10-28', dive: 1, sourceUrl: 'archive', prompts: [prompt('drinks'), prompt('hot drinks')] },
  }, chapters: {
    chapter: { pack: 'unlimited', chapter: 1, fetchedAt: '2026-10-29', sourceUrl: 'official', version: '1',
      prompts: [prompt('drinks', 90)] },
  }, collections: {
    shared: { kind: 'shared-file', sha256: 'a'.repeat(64), importedAt: '2026-10-29', sourceFile: 'friend.json', prompts: [{
      ...prompt('drinks', 80), firstSeen: '2026-10-01', lastSeen: '2026-10-27', answers: [
        { text: 'Coffee', score: 80, tier: 'rare', aliases: ['Café'], note: 'Shared note' },
        { text: 'Water', score: 75, tier: 'rare', aliases: [] },
      ],
    }] },
    companion: { kind: 'companion', sha256: 'b'.repeat(64), importedAt: '2026-10-29',
      sourceUrl: 'companion', answersUrl: 'answers', pack: 'geography', chapter: 1, prompts: [prompt('drinks', 70)] },
  },
});

function files(db = database()) {
  const index: SeedIndex = { schemaVersion: 1, prompts: {} };
  const result = new Map<string, unknown>();
  let id = 0;
  for (const [key, shard] of partitionSeed(db)) {
    const path = `seed/prompts/${(++id).toString(16).padStart(64, '0')}.json`;
    index.prompts[key] = path;
    result.set(path, shard);
  }
  result.set('seed/index.json', index);
  return result;
}

test('partitioned lookup preserves ranking, aliases, notes, timestamps and provenance from all sources', () => {
  const db = database(), original = JSON.stringify(db), full = new SeedLookup(db);
  const shards = partitionSeed(db);
  assert.equal(shards.size, 2);
  for (const [key, shard] of shards) {
    const lookup = new SeedLookup(shard);
    assert.deepEqual(lookup.promptKeys(), [key]);
    for (const used of [[], ['Café'], ['Coffee', 'Tea'], ['Coffee', 'Tea', 'Water']]) {
      assert.deepEqual(lookup.lookup(key, { used }), full.lookup(key, { used }));
    }
  }
  assert.equal(JSON.stringify(db), original);
});

test('bundled lookup loads only a matching question, shares concurrent reads, and bounds retained questions', async () => {
  const data = files(), reads: string[] = [];
  const seed = new BundledSeed(async path => { reads.push(path); return structuredClone(data.get(path)); }, 1);
  assert.deepEqual(await seed.promptKeys(), ['drinks', 'hot drinks']);
  assert.deepEqual(reads, ['seed/index.json']);
  assert.deepEqual(await seed.lookup('unknown'), []);
  assert.equal(reads.length, 1);
  const [first, filtered] = await Promise.all([seed.lookup(' DRINKS '), seed.lookup('drinks', { used: ['Café'] })]);
  assert.equal(first[0]!.text, 'Coffee');
  assert.equal(filtered[0]!.text, 'Tea');
  assert.equal(reads.length, 2);
  await seed.lookup('drinks'); assert.equal(reads.length, 2);
  await seed.lookup('hot drinks'); assert.equal(reads.length, 3);
  await seed.lookup('drinks'); assert.equal(reads.length, 4, 'Evicted question reloads on demand');
});

test('failed index and question reads retry; mismatched shards and unexpected paths are rejected', async () => {
  const data = files();
  let failIndex = true, failQuestion = true;
  const seed = new BundledSeed(async path => {
    if (path === 'seed/index.json' && failIndex) { failIndex = false; throw new Error('index failure'); }
    if (path !== 'seed/index.json' && failQuestion) { failQuestion = false; throw new Error('question failure'); }
    return structuredClone(data.get(path));
  });
  await assert.rejects(seed.promptKeys(), /index failure/);
  await assert.rejects(seed.lookup('drinks'), /question failure/);
  assert.equal((await seed.lookup('drinks'))[0]!.text, 'Coffee');
  const unsafe = new BundledSeed(async () => ({ schemaVersion: 1, prompts: { drinks: 'https://example.com/data' } }));
  await assert.rejects(unsafe.promptKeys(), /Invalid bundled seed index/);
  const wrong = new BundledSeed(async path => path === 'seed/index.json' ? data.get(path) : partitionSeed(database()).get('hot drinks'));
  await assert.rejects(wrong.lookup('drinks'), /question mismatch/);
});
