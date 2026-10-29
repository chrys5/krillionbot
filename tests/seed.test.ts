import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { ARCHIVE_URL, parseArchive, parseDay } from '../src/data/archive.js';
import { normalize } from '../src/data/normalize.js';
import { readDatabase, writeJson } from '../src/data/store.js';
import { emptyDatabase, updateSeed } from '../src/data/update.js';
import { SeedLookup } from '../src/resolver/seed-lookup.js';

const fixture = await readFile(new URL('../../tests/fixtures/daily.html', import.meta.url), 'utf8');
const dayUrl = (date: string) => `https://www.linkedinpinpointanswer.today/krillion-answers/${date}`;
const dayHtml = (date = '2026-10-28') => fixture.replaceAll('2026-10-28', date);
const archive = (dates: string[], next = '') =>
  dates.map(date => `<a href="${dayUrl(date)}">${date}</a>`).join('') +
  (next ? `<a href="${next}">Next</a>` : '');
const prompt = 'Name a bird that lives in or by water';
const makeDatabase = () => {
  const database = emptyDatabase();
  database.days['2026-10-28'] = parseDay(dayHtml(), dayUrl('2026-10-28'));
  return database;
};

test('archive follows Next, deduplicates days, and ignores external links', () => {
  const html = archive(['2026-10-28', '2026-10-28'], '/krillion-answers/archive?page=2') +
    '<a href="https://example.com/krillion-answers/2026-10-27">Other</a>';
  assert.deepEqual(parseArchive(html, ARCHIVE_URL), {
    days: [dayUrl('2026-10-28')], next: `${ARCHIVE_URL}?page=2`,
  });
  assert.throws(() => parseArchive('<h1>Blocked</h1>', ARCHIVE_URL), /no daily links/);
});

test('daily parser reads all tiers, entities and Unicode but excludes quips and scripts', () => {
  const day = parseDay(dayHtml(), dayUrl('2026-10-28'));
  assert.equal(day.prompts.length, 7);
  assert.equal(day.dive, 105);
  assert.deepEqual(day.prompts[0]!.answers.map(a => a.text), ['Sungrebe', "Abbott's Booby", 'Café bird']);
  assert.equal(day.prompts[0]!.answers[0]!.score, 100);
  assert.equal(day.prompts[0]!.answers[1]!.tier, 'deepcut');
  assert.ok(!JSON.stringify(day).includes('explanation must'));
});

test('incomplete or changed markup is rejected instead of saved as a valid day', () => {
  assert.throws(() => parseDay(dayHtml(), dayUrl('2026-10-27')), /identity does not match/);
  assert.throws(() => parseDay(dayHtml().replace('2 answers', '3 answers'), dayUrl('2026-10-28')), /count mismatch/);
  assert.throws(() => parseDay(dayHtml().replace('data-score="100"', 'data-score="NaN"'), dayUrl('2026-10-28')), /Malformed/);
  assert.throws(() => parseDay(dayHtml().replace('id="krillion-prompt-7"', 'id="missing"'), dayUrl('2026-10-28')), /7 distinct/);
});

test('normalization preserves restrictions and normalizes Unicode/spacing/case', () => {
  assert.equal(normalize('  CAFÉ\n bird '), normalize('cafe\u0301 bird'));
  assert.notEqual(normalize('Name a city over 100,000'), normalize('Name a city over 10,000'));
  assert.notEqual(normalize('Name a bird'), normalize('Name a bird (not a duck)'));
});

test('seed lookup excludes used/rejected answers and known aliases, then can exhaust', () => {
  const database = makeDatabase();
  database.days['2026-10-28']!.prompts[0]!.answers[0]!.aliases.push('Sun grebe');
  const lookup = new SeedLookup(database);
  assert.equal(lookup.lookup(`  ${prompt.toUpperCase()}  `)[0]!.text, 'Sungrebe');
  const candidates = lookup.lookup(prompt, { used: [' SUN GREBE '], rejected: ['Café bird'] });
  assert.deepEqual(candidates.map(a => a.text), ["Abbott's Booby"]);
  assert.deepEqual(lookup.lookup(prompt, { used: ['Sungrebe', "Abbott's Booby", 'Café bird'] }), []);
  assert.deepEqual(lookup.lookup(`${prompt} (not ducks)`), []);
});

test('repeated answers use latest score while retaining old dated snapshots', () => {
  const database = makeDatabase();
  const oldDay = parseDay(dayHtml('2026-10-27'), dayUrl('2026-10-27'));
  oldDay.prompts[0]!.answers[0]!.score = 30;
  database.days[oldDay.date] = oldDay;
  const lookup = new SeedLookup(database);
  assert.equal(lookup.lookup(prompt).filter(a => a.text === 'Sungrebe').length, 1);
  assert.equal(lookup.lookup(prompt)[0]!.score, 100);
  assert.equal(oldDay.prompts[0]!.answers[0]!.score, 30);
});

test('input-length filtering happens before the seed shortlist, so valid local answers are not missed', () => {
  const database = makeDatabase();
  const answers = database.days['2026-10-28']!.prompts[0]!.answers;
  answers.unshift(...Array.from({ length: 12 }, (_, i) => ({ text: 'x'.repeat(61) + i, aliases: [], score: 100, tier: 'krillion' })));
  const candidates = new SeedLookup(database).lookup(prompt, { maxLength: 60 });
  assert.equal(candidates[0]!.text, 'Sungrebe'); assert.ok(candidates.every(a => a.text.length <= 60));
});

test('incremental import fetches only missing daily pages, then zero days on rerun', async () => {
  const database = makeDatabase();
  const original = JSON.stringify(database.days['2026-10-28']);
  const calls: string[] = [];
  const fetchHtml = async (url: string) => {
    calls.push(url);
    if (url === ARCHIVE_URL) return archive(['2026-10-28'], '/krillion-answers/archive?page=2');
    if (url === `${ARCHIVE_URL}?page=2`) return archive(['2026-10-27']);
    if (url === dayUrl('2026-10-27')) return dayHtml('2026-10-27');
    throw new Error(`Unexpected request: ${url}`);
  };
  const report = await updateSeed(database, fetchHtml);
  assert.deepEqual(report.importedDays, ['2026-10-27']);
  assert.equal(report.skippedDays, 1);
  assert.equal(report.answerRows, 18);
  assert.equal(JSON.stringify(database.days['2026-10-28']), original);
  assert.deepEqual(calls, [ARCHIVE_URL, `${ARCHIVE_URL}?page=2`, dayUrl('2026-10-27')]);
  calls.length = 0;
  const beforeRerun = JSON.stringify(database);
  const rerun = await updateSeed(database, fetchHtml);
  assert.deepEqual(rerun.importedDays, []);
  assert.equal(rerun.skippedDays, 2);
  assert.deepEqual(calls, [ARCHIVE_URL, `${ARCHIVE_URL}?page=2`]);
  assert.equal(JSON.stringify(database), beforeRerun);
});

test('new daily is appended without refetching previously imported history', async () => {
  const database = makeDatabase();
  const calls: string[] = [];
  const report = await updateSeed(database, async url => {
    calls.push(url);
    return url === ARCHIVE_URL ? archive(['2026-10-29', '2026-10-28']) : dayHtml('2026-10-29');
  });
  assert.deepEqual(report.importedDays, ['2026-10-29']);
  assert.deepEqual(calls, [ARCHIVE_URL, dayUrl('2026-10-29')]);
  assert.ok(database.days['2026-10-28']);
});

test('failed day is reported and remains retryable without losing imported data', async () => {
  const database = makeDatabase();
  const report = await updateSeed(database, async url => {
    if (url === ARCHIVE_URL) return archive(['2026-10-28', '2026-10-27']);
    throw new Error('HTTP 503');
  });
  assert.equal(report.failures[0]!.error, 'HTTP 503');
  assert.equal(report.totalDays, 1);
  assert.equal(database.days['2026-10-27'], undefined);
  const retry = await updateSeed(database, async url => url === ARCHIVE_URL
    ? archive(['2026-10-28', '2026-10-27']) : dayHtml('2026-10-27'));
  assert.deepEqual(retry.importedDays, ['2026-10-27']);
});

test('pagination cycles are reported, not followed indefinitely', async () => {
  const report = await updateSeed(emptyDatabase(), async url => url.includes('archive')
    ? archive(['2026-10-28'], '/krillion-answers/archive') : dayHtml());
  assert.match(report.failures[0]!.error, /pagination loop/);
  assert.deepEqual(report.importedDays, ['2026-10-28']);
});

test('database survives round trip; malformed existing data is never treated as empty', async () => {
  const testRoot = resolve('.cache/tests');
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, 'krillion-seed-'));
  const path = join(directory, 'seed.json');
  try {
    assert.deepEqual(await readDatabase(path), emptyDatabase());
    const database = makeDatabase();
    await writeJson(path, database);
    assert.deepEqual(await readDatabase(path), database);
    await writeFile(path, '{malformed');
    await assert.rejects(readDatabase(path));
    assert.equal(await readFile(path, 'utf8'), '{malformed');
  } finally {
    assert.equal(dirname(resolve(directory)), testRoot);
    assert.ok(basename(directory).startsWith('krillion-seed-'));
    await rm(directory, { recursive: true, force: true });
  }
});
