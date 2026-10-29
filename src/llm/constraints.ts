export interface SimpleConstraints { startsWith?: string; endsWith?: string; contains?: string; minLetters?: number; maxLetters?: number; letterBank?: string }

export function questionConstraints(question: string): SimpleConstraints {
  const constraints: SimpleConstraints = {};
  const prefix = /\bstart(?:s|ing)? with\s+["“‘']?([a-z]+)\b/iu.exec(question)?.[1];
  const suffix = /\bend(?:s|ing)? (?:with|in)\s+["“‘']?([a-z]+)\b/iu.exec(question)?.[1];
  // Avoid interpreting an unquoted phrase ("starts with the letter ...") as a prefix.
  if (prefix && !['a', 'an', 'the'].includes(prefix.toLowerCase())) constraints.startsWith = prefix.toLowerCase();
  if (suffix && !['a', 'an', 'the'].includes(suffix.toLowerCase())) constraints.endsWith = suffix.toLowerCase();
  const contained = /\bcontaining\s*["“‘']([a-z]+)["”’']/iu.exec(question)?.[1];
  if (contained) constraints.contains = contained.toLowerCase();
  const length = /\b(\d+)(\+)?[ -]+letter word\b/iu.exec(question);
  if (length) {
    constraints.minLetters = Number(length[1]);
    if (!length[2]) constraints.maxLetters = Number(length[1]);
  }
  const bank = /\bletters in\s*["“]([a-z]+)["”]/iu.exec(question)?.[1];
  if (bank) constraints.letterBank = bank.toLowerCase();
  return constraints;
}

export function fitsConstraints(text: string, constraints: SimpleConstraints): boolean {
  const lower = text.toLowerCase();
  if (constraints.startsWith && !lower.startsWith(constraints.startsWith)) return false;
  if (constraints.endsWith && !lower.endsWith(constraints.endsWith)) return false;
  if (constraints.contains && !lower.includes(constraints.contains)) return false;
  const letters = lower.match(/\p{L}/gu)?.length ?? 0;
  if (constraints.minLetters !== undefined && letters < constraints.minLetters) return false;
  if (constraints.maxLetters !== undefined && letters > constraints.maxLetters) return false;
  if (constraints.letterBank) {
    const pool = [...constraints.letterBank];
    for (const letter of lower) {
      const index = pool.indexOf(letter);
      if (index < 0) return false;
      pool.splice(index, 1);
    }
  }
  return true;
}

export const isCurrentFactQuestion = (question: string) =>
  /\b(current|currently|today|latest|recent|now|monthly|subscribers|followers|this (?:year|month|week))\b/iu.test(question);
export const suggestionTtlMs = (question: string) => (isCurrentFactQuestion(question) ? 1 : 24) * 60 * 60 * 1000;
