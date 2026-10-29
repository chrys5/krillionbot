import { normalize } from './normalize.js';
import { seedRecords } from './records.js';
import type { SeedDatabase } from './types.js';

export function bankCoverage(database: SeedDatabase) {
  const questions = new Map<string, Map<string, Set<string>>>();
  let answerRows = 0, noteRows = 0, aliasRows = 0;
  for (const record of seedRecords(database)) for (const prompt of record.prompts) {
    let answers = questions.get(prompt.key);
    if (!answers) questions.set(prompt.key, answers = new Map());
    for (const answer of prompt.answers) {
      answerRows++;
      if (answer.note) noteRows++;
      aliasRows += answer.aliases.length;
      const key = normalize(answer.text);
      let variants = answers.get(key);
      if (!variants) answers.set(key, variants = new Set());
      variants.add(`${answer.score}:${answer.tier}`);
    }
  }
  let uniqueAnswerPairs = 0, conflictingAnswerPairs = 0;
  for (const answers of questions.values()) for (const variants of answers.values()) {
    uniqueAnswerPairs++;
    if (variants.size > 1) conflictingAnswerPairs++;
  }
  return { uniquePrompts: questions.size, uniqueAnswerPairs, answerRows, noteRows, aliasRows, conflictingAnswerPairs };
}
