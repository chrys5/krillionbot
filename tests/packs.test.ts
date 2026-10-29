import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { parseMetadata, parseReveal, packBase, updatePacks } from '../src/data/packs.js';
import { emptyDatabase } from '../src/data/update.js';
import { SeedLookup } from '../src/resolver/seed-lookup.js';
import { readDatabase, writeJson } from '../src/data/store.js';
import { parseDay } from '../src/data/archive.js';

const metadata = (game = 1, lastGame = 3) => JSON.stringify({ game, lastGame, version: 'public-v1',
  prompts: Array.from({ length: 7 }, (_, i) => ({ id: `r${i + 1}`, text: `Name a thing ${i + 1}` })) });
const reveal = () => JSON.stringify({ rounds: Array.from({ length: 7 }, (_, i) => ({
  round: `r${i + 1}`, text: `Name a thing ${i + 1}`,
  answers: [{ answer: 'Café', aliases: ['Coffee'], score: 85, tier: 'deepcut', quip: 'Excluded prose' }],
})) });
const chapter = () => parseReveal(reveal(), 'geography', 1, parseMetadata(metadata(), 1), '2026-10-29T00:00:00Z');

test('reveal preserves source, chapter, rounds, scores, Unicode and aliases; excludes prose', () => {
  const record = chapter();
  assert.equal(record.sourceUrl, `${packBase('geography')}/1/reveal`);
  assert.equal(record.pack, 'geography'); assert.equal(record.chapter, 1);
  assert.deepEqual(record.prompts[0]!.answers, [{ text: 'Café', aliases: ['Coffee'], score: 85, tier: 'deepcut' }]);
  assert.equal(record.prompts[0]!.round, 'r1');
  const noAliases = reveal().replaceAll(',"aliases":["Coffee"]', '');
  assert.deepEqual(parseReveal(noAliases, 'geography', 1, parseMetadata(metadata(), 1), record.fetchedAt).prompts[0]!.answers[0]!.aliases, []);
});

test('malformed, incomplete, wrong-identity, locked and non-JSON reveals are rejected atomically', () => {
  for (const body of ['<html>blocked</html>', '{"locked":true}', reveal().replace('"score":85', '"score":"85"'),
    reveal().replace('r7', 'r6'), reveal().replace('Name a thing 7', 'Different question'),
    JSON.stringify({ rounds: JSON.parse(reveal()).rounds.slice(0, 6) }),
    reveal().replace('["Coffee"]', '[4]')]) {
    assert.throws(() => parseReveal(body, 'geography', 1, parseMetadata(metadata(), 1), chapter().fetchedAt));
  }
  assert.throws(() => parseMetadata(metadata(2), 1), /identity/);
});

test('import checks beyond locked chapters and distinguishes unavailable from parse failures', async () => {
  const database = emptyDatabase();
  const report = await updatePacks(database, async url => {
    if (url.endsWith('/1')) return { status: 200, body: metadata(1, 5) };
    if (url.endsWith('/2/reveal')) return { status: 402, body: '{"locked":true}' };
    if (url.endsWith('/4/reveal')) return { status: 404, body: '{"error":"Unknown puzzle"}' };
    if (url.endsWith('/5/reveal')) return { status: 200, body: '<html>bad</html>' };
    if (url.endsWith('/3')) return { status: 200, body: metadata(3, 5) };
    return { status: 200, body: reveal() };
  }, { packs: ['geography'] });
  assert.deepEqual(report.chapters.map(c => c.status), ['imported', 'locked', 'imported', 'unavailable', 'failed']);
  assert.deepEqual(Object.keys(database.chapters!), ['geography/1', 'geography/3']);
});

test('rerun never requests imported chapters and preserves the entire database on no-op', async () => {
  const database = emptyDatabase();
  database.chapters = { 'geography/1': chapter() };
  const before = JSON.stringify(database);
  const calls: string[] = [];
  const report = await updatePacks(database, async url => {
    calls.push(url);
    return url.endsWith('/1') ? { status: 200, body: metadata() } : { status: 402, body: '{"error":"locked"}' };
  }, { packs: ['geography'] });
  assert.deepEqual(calls, [`${packBase('geography')}/1`, `${packBase('geography')}/2/reveal`, `${packBase('geography')}/3/reveal`]);
  assert.equal(report.chapters[0]!.status, 'skipped');
  assert.equal(JSON.stringify(database), before);
});

test('failed chapter stays retryable and later chapters are checked', async () => {
  const database = emptyDatabase();
  let fail = true;
  const fetchPublic = async (url: string) => {
    if (url.endsWith('/reveal')) {
      if (url.endsWith('/2/reveal') && fail) throw new Error('Connection reset');
      return { status: 200, body: reveal() };
    }
    return { status: 200, body: metadata(Number(url.split('/').at(-1))) };
  };
  const first = await updatePacks(database, fetchPublic, { packs: ['lexicon'] });
  assert.deepEqual(first.chapters.map(c => c.status), ['imported', 'failed', 'imported']);
  fail = false;
  const second = await updatePacks(database, fetchPublic, { packs: ['lexicon'] });
  assert.deepEqual(second.chapters.map(c => c.status), ['skipped', 'imported', 'skipped']);
});

test('rate limits stop the affected pack; untested chapters are not labelled locked', async () => {
  const report = await updatePacks(emptyDatabase(), async url => url.endsWith('/1')
    ? { status: 200, body: metadata() } : { status: 429, body: '{}' }, { packs: ['sports'] });
  assert.equal(report.chapters.length, 1);
  assert.equal(report.chapters[0]!.status, 'failed'); assert.equal(report.failures.length, 1);
});

test('lookup includes chapter provenance and excludes aliases without mutating snapshots', () => {
  const database = emptyDatabase();
  database.chapters = { 'geography/1': chapter() };
  const before = JSON.stringify(database);
  const lookup = new SeedLookup(database);
  const candidate = lookup.lookup('Name a thing 1')[0]!;
  assert.equal(candidate.pack, 'geography'); assert.equal(candidate.chapter, 1);
  assert.deepEqual(lookup.lookup('Name a thing 1', { used: ['COFFEE'] }), []);
  assert.equal(JSON.stringify(database), before);
});

test('chapter round trips preserve daily records and malformed stored chapters cannot be overwritten', async () => {
  const root = resolve('.cache/tests');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'krillion-packs-'));
  const path = join(directory, 'seed.json');
  try {
    const database = emptyDatabase();
    const fixture = await readFile(new URL('../../tests/fixtures/daily.html', import.meta.url), 'utf8');
    database.days['2026-10-28'] = parseDay(fixture, 'https://www.linkedinpinpointanswer.today/krillion-answers/2026-10-28');
    const beforeDays = JSON.stringify(database.days);
    await updatePacks(database, async url => url.endsWith('/reveal')
      ? { status: 200, body: reveal() } : { status: 200, body: metadata(1, 1) }, { packs: ['geography'] });
    assert.equal(JSON.stringify(database.days), beforeDays);
    await writeJson(path, database);
    assert.deepEqual(await readDatabase(path), database);
    for (const corrupt of [
      (d: typeof database) => { d.chapters!['geography/1']!.sourceUrl = 'https://example.com'; },
      (d: typeof database) => { d.chapters!['geography/1']!.chapter = 2; },
      (d: typeof database) => { d.chapters!['geography/1']!.prompts[0]!.answers[0]!.aliases = [42 as unknown as string]; },
      (d: typeof database) => { d.chapters!['geography/1']!.prompts.pop(); },
    ]) {
      const invalid = structuredClone(database); corrupt(invalid);
      const raw = JSON.stringify(invalid); await writeFile(path, raw);
      await assert.rejects(readDatabase(path), /Invalid stored/);
      assert.equal(await readFile(path, 'utf8'), raw);
    }
  } finally {
    assert.equal(dirname(resolve(directory)), root);
    assert.ok(basename(directory).startsWith('krillion-packs-'));
    await rm(directory, { recursive: true, force: true });
  }
});
