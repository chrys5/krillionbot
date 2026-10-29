import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import test from 'node:test';
import { appendCollection, parseSharedFile, parseCompanion, validateCompanionSource } from '../src/data/merge.js';
import { emptyDatabase, databaseStats } from '../src/data/update.js';
import { bankCoverage } from '../src/data/coverage.js';
import { parseDay } from '../src/data/archive.js';
import { readDatabase, writeJson } from '../src/data/store.js';
import { SeedLookup } from '../src/resolver/seed-lookup.js';

const at = '2026-10-29T00:00:00Z';
const shared = (score = 100, answer = 'Café') => JSON.stringify({ 'Name a thing': {
  question: 'Name a thing', firstSeen: '2026-10-25T00:00:00Z', lastSeen: '2026-10-25T01:00:00Z',
  answers: { [answer]: { answer, points: score, tier: score === 100 ? 'krillion' : 'rare', note: 'A source note', aliases: ['Coffee'] } },
} });
const source = { sourceUrl: 'https://krillion-game.com/answers/geography/1/r1-country/',
  answersUrl: 'https://krillion-game.com/api/answers/?prompt=geography%3A1%3Ar1',
  pack: 'geography' as const, chapter: 1, round: 'r1' };
const html = '<details class="prompt" id="geography:1:r1" data-total="1"><span class="prompt-title">Name a thing</span></details>';
const companion = JSON.stringify({ answers: [{ answer: 'Café', score: 30, tier: 'schooler' }] });

test('shared importer retains original notes, timestamps, aliases and local provenance', () => {
  const collection = parseSharedFile(shared(), 'data/friend.json', at);
  assert.equal(collection.kind, 'shared-file'); assert.equal(collection.sourceFile, 'data/friend.json');
  assert.equal(collection.sourceUrl, undefined); assert.equal(collection.sha256.length, 64);
  assert.equal(collection.prompts[0]!.firstSeen, '2026-10-25T00:00:00Z');
  assert.equal(collection.prompts[0]!.answers[0]!.note, 'A source note');
  assert.deepEqual(collection.prompts[0]!.answers[0]!.aliases, ['Coffee']);
});

test('malformed files and changed question restrictions are never silently merged', () => {
  for (const body of ['{}', '<html>no</html>', shared().replace('"points":100', '"points":"100"'),
    shared().replace('"question":"Name a thing"', '"question":"Name a thing (not coffee)"'),
    shared().replace('2026-10-25T01:00:00Z', '2026-10-24T01:00:00Z'),
    shared().replace('"note":"A source note"', '"note":{}')]) {
    assert.throws(() => parseSharedFile(body, 'data/friend.json', at));
  }
});

test('content hashes make repeat imports a complete no-op while a changed source remains a separate snapshot', () => {
  const database = emptyDatabase();
  const collection = parseSharedFile(shared(), 'data/friend.json', at);
  assert.equal(appendCollection(database, collection), true);
  const before = JSON.stringify(database);
  assert.equal(appendCollection(database, { ...collection, importedAt: '2026-11-01T00:00:00Z' }), false);
  assert.equal(JSON.stringify(database), before);
  assert.equal(appendCollection(database, parseSharedFile(shared(60), 'data/friend.json', at)), true);
  assert.equal(Object.keys(database.collections!).length, 2);
  assert.equal(bankCoverage(database).conflictingAnswerPairs, 1);
});

test('companion importer reads the complete API list and requires exact page identity/count', () => {
  const collection = parseCompanion(companion, html, source, at);
  assert.equal(collection.sourceUrl, source.sourceUrl); assert.equal(collection.chapter, 1);
  assert.equal(collection.prompts[0]!.round, 'r1');
  assert.throws(() => parseCompanion(companion, html.replace('data-total="1"', 'data-total="50"'), source, at), /Incomplete/);
  assert.throws(() => parseCompanion(companion, html.replace('geography:1:r1', 'geography:2:r1'), source, at), /identity/);
  assert.throws(() => validateCompanionSource({ ...source, sourceUrl: 'https://example.com/answers/geography/1/r1-country/' }), /identity/);
  assert.throws(() => validateCompanionSource({ ...source, answersUrl: 'https://krillion-game.com/api/answers/?prompt=movies:1:r1' }), /identity/);
});

test('lookup unions sources without merging different restrictions, preserves conflicts and enriches notes', () => {
  const database = emptyDatabase();
  appendCollection(database, parseSharedFile(shared(), 'data/friend.json', at));
  appendCollection(database, parseSharedFile(shared(60, 'Tea'), 'data/other.json', at));
  appendCollection(database, parseCompanion(companion, html, source, at));
  const unchanged = JSON.stringify(database);
  const lookup = new SeedLookup(database);
  assert.deepEqual(lookup.lookup('NAME A THING').map(a => [a.text, a.score]), [['Café', 100], ['Tea', 60]]);
  assert.equal(lookup.lookup('Name a thing')[0]!.sourceFile, 'data/friend.json');
  assert.equal(lookup.lookup('Name a thing')[0]!.note, 'A source note');
  assert.deepEqual(lookup.lookup('Name a thing (not coffee)'), []);
  assert.deepEqual(lookup.lookup('Name a thing', { used: ['COFFEE'] }), []);
  assert.equal(JSON.stringify(database), unchanged);
  assert.equal(bankCoverage(database).uniqueAnswerPairs, 2);
  assert.equal(bankCoverage(database).conflictingAnswerPairs, 1);
  assert.equal(databaseStats(database).uniquePrompts, 1);
});

test('official scores win over lower-priority files regardless of their import dates', () => {
  const database = emptyDatabase();
  const collection = parseSharedFile(shared(), 'data/friend.json', '2030-01-01T00:00:00Z');
  appendCollection(database, collection);
  database.chapters = { 'geography/1': { pack: 'geography', chapter: 1, sourceUrl: 'https://krillion.io/api/packs/geography/1/reveal',
    fetchedAt: at, version: 'v1', prompts: [{ text: 'Name a thing', key: 'name a thing', round: 'r1',
      answers: [{ text: 'Café', score: 60, tier: 'rare', aliases: [] }] }] } };
  const before = JSON.stringify(database);
  const answer = new SeedLookup(database).lookup('Name a thing')[0]!;
  assert.equal(answer.score, 60); assert.equal(answer.sourceKind, 'official');
  assert.equal(answer.note, 'A source note'); assert.deepEqual(answer.aliases, ['Coffee']);
  assert.equal(answer.noteSource?.sourceFile, 'data/friend.json');
  assert.equal(answer.sourceUrl, 'https://krillion.io/api/packs/geography/1/reveal');
  assert.equal(JSON.stringify(database), before);
});

test('shared snapshot score selection uses source observation time rather than later import time', () => {
  const database = emptyDatabase();
  const newer = parseSharedFile(shared(), 'data/newer.json', at);
  const older = parseSharedFile(shared(60).replaceAll('2026-10-25', '2026-10-24'), 'data/older.json', '2030-01-01T00:00:00Z');
  appendCollection(database, newer); appendCollection(database, older);
  const answer = new SeedLookup(database).lookup('Name a thing')[0]!;
  assert.equal(answer.score, 100); assert.equal(answer.sourceFile, 'data/newer.json');
  assert.equal(answer.date, '2026-10-25');
  assert.equal(bankCoverage(database).conflictingAnswerPairs, 1);
});

test('merged bank round trips and original daily snapshots stay byte-for-byte identical', async () => {
  const root = resolve('.cache/tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'merge-seed-'));
  try {
    const database = emptyDatabase();
    const fixture = await readFile(new URL('../../tests/fixtures/daily.html', import.meta.url), 'utf8');
    database.days['2026-10-28'] = parseDay(fixture, 'https://www.linkedinpinpointanswer.today/krillion-answers/2026-10-28');
    const before = JSON.stringify(database.days);
    appendCollection(database, parseSharedFile(shared(), 'data/friend.json', at));
    appendCollection(database, parseCompanion(companion, html, source, at));
    const path = join(directory, 'seed.json'); await writeJson(path, database);
    assert.deepEqual(await readDatabase(path), database);
    assert.equal(JSON.stringify(database.days), before);
    database.collections![Object.keys(database.collections!)[0]!]!.prompts[0]!.answers[0]!.score = 101;
    await writeJson(path, database);
    await assert.rejects(readDatabase(path), /Invalid stored/);
  } finally {
    assert.equal(dirname(resolve(directory)), root); assert.ok(basename(directory).startsWith('merge-seed-'));
    await rm(directory, { recursive: true, force: true });
  }
});
