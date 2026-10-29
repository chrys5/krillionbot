// Explicit source audit; never runs during install, build, tests or extension setup.
import { load } from 'cheerio';
import { setTimeout } from 'node:timers/promises';
import { readDatabase, writeJson } from '../src/data/store.js';
import { normalize } from '../src/data/normalize.js';
import { PACKS } from '../src/data/packs.js';

const database = await readDatabase('data/seed.json');
const origin = 'https://krillion-game.com';
let lastRequest = 0;
async function get(url: string) {
  if (new URL(url).origin !== origin) throw new Error('Unexpected audit origin');
  await setTimeout(Math.max(0, 400 - (Date.now() - lastRequest)));
  lastRequest = Date.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}
const report = {
  checkedAt: new Date().toISOString(),
  policy: 'Official live reveals supply the imported chapters. Companion snapshots are compared separately; older wording, scores and partial HTML do not replace current official records.',
  pages: [] as { sourceUrl: string; title: string; discoveredAnswerPages: string[] }[],
  searches: [] as { sourceUrl: string; pack: string; results: number; chapters: string[]; truncated: boolean }[],
  prompts: [] as { sourceUrl: string; answersUrl: string; pack: string; chapter: number; round: string;
    question: string; htmlRows: number; answerRows: number; officialRows: number | null;
    sameQuestion: boolean; missingFromOfficial: number; changedScores: number; publishedAliases: number }[],
};
for (const path of ['/search/', '/geography/']) {
  const sourceUrl = origin + path;
  const $ = load(await get(sourceUrl));
  report.pages.push({ sourceUrl, title: $('h1').text(), discoveredAnswerPages: [...new Set(
    $('a[href]').map((_i, element) => $(element).attr('href')!).get()
      .filter(href => href.startsWith('/answers/')).map(href => new URL(href, sourceUrl).href))] });
}
for (const pack of PACKS) {
  const sourceUrl = `${origin}/api/suggest/?q=Name&mode=${pack}`;
  const data = JSON.parse(await get(sourceUrl)) as { results: {
    id: string; text: string; mode: string; game_id: string; archive: string }[] };
  if (!Array.isArray(data.results)) throw new Error('Changed search response');
  report.searches.push({ sourceUrl, pack, results: data.results.length,
    chapters: [...new Set(data.results.map(p => p.game_id))], truncated: data.results.length >= 10 });
  for (const prompt of data.results) {
    if (prompt.mode !== pack || !/^[1-9]\d*$/u.test(prompt.game_id)) throw new Error('Unexpected search identity');
    const pageUrl = new URL(prompt.archive, origin).href;
    const $ = load(await get(pageUrl));
    const container = $('details.prompt').filter((_i, e) => $(e).attr('id') === prompt.id);
    const expected = Number(container.attr('data-total'));
    const question = container.find('.prompt-title').text().trim();
    if (!question || question !== prompt.text) throw new Error('Answer page identity mismatch');
    const answersUrl = `${origin}/api/answers/?prompt=${encodeURIComponent(prompt.id)}`;
    const payload = JSON.parse(await get(answersUrl)) as { answers: { answer: string; score: number; tier: string; aliases?: string[] }[] };
    if (!Array.isArray(payload.answers) || payload.answers.length !== expected || payload.answers.some(
      answer => typeof answer.answer !== 'string' || !Number.isInteger(answer.score) || answer.score < 0 || answer.score > 100 || typeof answer.tier !== 'string')) {
      throw new Error(`Incomplete companion answers: ${prompt.id}`);
    }
    const round = prompt.id.split(':')[2]!;
    const official = database.chapters?.[`${pack}/${prompt.game_id}`]?.prompts.find(p => p.round === round);
    const answers = new Map(official?.answers.map(a => [normalize(a.text), a]));
    report.prompts.push({ sourceUrl: pageUrl, answersUrl, pack, chapter: Number(prompt.game_id), round, question,
      htmlRows: container.find('.answer-row[data-answer][data-score]').length, answerRows: payload.answers.length,
      officialRows: official?.answers.length ?? null, sameQuestion: official?.text === question,
      missingFromOfficial: payload.answers.filter(a => !answers.has(normalize(a.answer))).length,
      changedScores: payload.answers.filter(a => answers.has(normalize(a.answer)) && answers.get(normalize(a.answer))!.score !== a.score).length,
      publishedAliases: payload.answers.reduce((n, a) => n + (a.aliases?.length ?? 0), 0) });
  }
}
await writeJson('data/seed.sources.report.json', report, true);
console.log(JSON.stringify({ pages: report.pages.length, searches: report.searches,
  verifiedAnswerPages: report.prompts.length, changedQuestions: report.prompts.filter(p => !p.sameQuestion).length,
  answerRows: report.prompts.reduce((n, p) => n + p.answerRows, 0) }, null, 2));
