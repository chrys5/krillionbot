import assert from 'node:assert/strict';
import test from 'node:test';
import { AnswerMatcher } from '../src/data/answer-matching.js';
import { SeedLookup } from '../src/resolver/seed-lookup.js';
import { emptyDatabase } from '../src/data/update.js';

test('answer identity handles formatting and accents but retains meaningful symbols and numbers', () => {
  const matcher = new AnswerMatcher('Name a famous character');
  for (const [one, two] of [['Spider-Man', 'Spider man'], ['Beyoncé', 'Beyonce'], ["O’Connor", "O'Connor"], ['U.S.A.', 'USA']]) {
    assert.equal(matcher.key(one!), matcher.key(two!));
  }
  for (const [one, two] of [['C++', 'C#'], ['C', 'C++'], ['1984', '1985'], ['R&B', 'RB'], ['cat', 'bat'], ['1.5', '15'], ['-1', '1'], ['1-2', '12']]) {
    assert.notEqual(matcher.key(one!), matcher.key(two!));
  }
});

test('semantic aliases and selected plurals are scoped to the category', () => {
  const countries = new AnswerMatcher('Name a country in Europe');
  assert.equal(countries.key('United Kingdom'), countries.key('U.K.'));
  assert.equal(countries.key('Czechia'), countries.key('Czech Republic'));
  const animals = new AnswerMatcher('Name an animal');
  assert.equal(animals.key('dog'), animals.key('dogs'));
  assert.equal(animals.key('mouse'), animals.key('mice'));
  assert.notEqual(new AnswerMatcher('Name a film').key('Dog'), new AnswerMatcher('Name a film').key('Dogs'));
  const words = new AnswerMatcher('Name a word starting with D');
  assert.notEqual(words.key('dog'), words.key('dogs'));
  assert.notEqual(words.key('resume'), words.key('résumé'));
  assert.notEqual(words.key('re-sign'), words.key('resign'));
  assert.notEqual(words.key('UK'), words.key('United Kingdom'));
  assert.notEqual(countries.key('Congo'), countries.key('Democratic Republic of the Congo'));
});

test('source aliases propagate transitively and work in both directions', () => {
  const matcher = new AnswerMatcher('Name a drink', [['Coffee', 'Café'], ['Cafe', 'Java']]);
  assert.equal(matcher.key('Java'), matcher.key('Coffee'));
  assert.deepEqual(new Set(matcher.expand(['JAVA'])), new Set(['JAVA', 'Coffee', 'Café', 'Cafe', 'Java']));
});

test('seed deduplicates equivalents and expands source aliases without changing the seed', () => {
  const database = emptyDatabase();
  const prompt = 'Name a country';
  database.days.fixture = { date: '2026-10-29', dive: 1, sourceUrl: 'fixture', prompts: [{
    text: prompt, key: prompt.toLowerCase(), answers: [
      { text: 'USA', aliases: [], score: 100, tier: 'krillion' },
      { text: 'United States', aliases: ['States'], score: 85, tier: 'deepcut' },
      { text: 'Canada', aliases: [], score: 60, tier: 'rare' },
    ],
  }] };
  const original = JSON.stringify(database);
  const lookup = new SeedLookup(database);
  assert.deepEqual(lookup.lookup(prompt).map(a => a.text), ['USA', 'Canada']);
  assert.ok(lookup.lookup(prompt)[0]!.aliases.includes('States'));
  assert.deepEqual(lookup.lookup(prompt, { used: ['States'] }).map(a => a.text), ['Canada']);
  assert.ok(lookup.expandExcluded(prompt, ['U.S.']).includes('States'));
  assert.equal(JSON.stringify(database), original);
  // A long preferred spelling must not hide a usable short alias.
  database.days.fixture.prompts[0]!.answers[0]!.text = 'Long country name '.repeat(5);
  database.days.fixture.prompts[0]!.answers[0]!.aliases = ['USA'];
  assert.equal(new SeedLookup(database).lookup(prompt, { maxLength: 60 })[0]!.text, 'United States');
});
