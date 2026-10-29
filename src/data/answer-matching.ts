import { normalize } from './normalize.js';

// Prompt identity still uses normalize(). These rules apply only to answer identity.
const spellingQuestion = (prompt: string) => /\b(word|words|letter|letters|spell|spelling|anagram|rhyme|rhymes)\b/iu.test(prompt);
export function answerKey(text: string, prompt = ''): string {
  const normalized = normalize(text);
  if (spellingQuestion(prompt)) return normalized;
  // Preserve meaningful symbols and numbers (C++, C#, R&B, 1984, etc.).
  const folded = normalized.normalize('NFKD').replace(/\p{M}/gu, '');
  const key = folded.replace(/[\s.'’‘“”"\-‐‑–—_]/gu, (character, offset: number) => {
    // Decimal points, numeric ranges, and minus signs change numeric answers.
    if (character === '.' && /\d/u.test(folded[offset - 1] ?? '') && /\d/u.test(folded[offset + 1] ?? '')) return character;
    if (/[-‐‑–—]/u.test(character) && /\d/u.test(folded[offset + 1] ?? '')) return character;
    return '';
  });
  return key || normalized;
}

interface AliasRule { category: RegExp; groups: string[][] }
const rules: AliasRule[] = [
  { category: /\b(countr(?:y|ies)|nation|nations)\b/iu, groups: [
    ['United States', 'United States of America', 'USA', 'US', 'U.S.', 'U.S.A.'],
    ['United Kingdom', 'United Kingdom of Great Britain and Northern Ireland', 'UK', 'U.K.'],
    ['United Arab Emirates', 'UAE', 'U.A.E.'],
    ['South Korea', 'Republic of Korea'], ['North Korea', "Democratic People's Republic of Korea"],
    ['Czechia', 'Czech Republic'], ['Ivory Coast', "Côte d’Ivoire"],
    ['Eswatini', 'Swaziland'], ['Cabo Verde', 'Cape Verde'],
  ] },
  { category: /\b(animal|animals|mammal|mammals|pet|pets|bird|birds)\b/iu, groups: [
    ...'dog cat horse cow pig goat sheep deer bear lion tiger zebra giraffe elephant rabbit duck chicken eagle owl parrot penguin'.split(' ')
      .filter(word => !['sheep', 'deer'].includes(word)).map(word => [word, word + 's']),
    ['mouse', 'mice'], ['goose', 'geese'], ['wolf', 'wolves'], ['fox', 'foxes'],
  ] },
  { category: /\b(vegetable|vegetables)\b/iu, groups: [
    ['eggplant', 'eggplants', 'aubergine', 'aubergines'], ['zucchini', 'zucchinis', 'courgette', 'courgettes'],
    ['bell pepper', 'bell peppers', 'sweet pepper', 'sweet peppers'],
    ...'carrot onion potato tomato cucumber cabbage pumpkin radish'.split(' ')
      .map(word => [word, word + (word.endsWith('o') ? 'es' : word.endsWith('sh') ? 'es' : 's')]),
  ] },
];

// Explicit aliases form equivalence groups in both directions, including across sources.
// No edit-distance matching or blanket stemming: those can erase distinct valid answers.
export class AnswerMatcher {
  private groups = new Map<string, Set<string>>();
  constructor(private prompt: string, aliases: Iterable<Iterable<string>> = []) {
    if (!spellingQuestion(prompt)) {
      for (const rule of rules) if (rule.category.test(prompt)) for (const group of rule.groups) this.add(group);
    }
    for (const group of aliases) this.add(group);
  }
  private add(group: Iterable<string>): void {
    const texts = [...group].filter(text => text.trim());
    const existing = new Set(texts.flatMap(text => [...this.groups.get(answerKey(text, this.prompt)) ?? []]));
    for (const text of texts) existing.add(text);
    for (const text of existing) this.groups.set(answerKey(text, this.prompt), existing);
  }
  key(text: string): string {
    const key = answerKey(text, this.prompt);
    const group = this.groups.get(key);
    return group ? [...group].map(text => answerKey(text, this.prompt)).sort()[0]! : key;
  }
  aliases(text: string): string[] {
    return [...this.groups.get(answerKey(text, this.prompt)) ?? []].filter(alias => alias !== text);
  }
  expand(texts: Iterable<string>): string[] {
    return [...new Set([...texts].flatMap(text => [text, ...this.aliases(text)]))];
  }
  blocked(texts: Iterable<string>): Set<string> { return new Set([...texts].map(text => this.key(text))); }
}
