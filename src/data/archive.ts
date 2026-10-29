import { load } from 'cheerio';
import { normalize } from './normalize.js';
import type { SeedAnswer, SeedDay } from './types.js';

export const ARCHIVE_URL = 'https://www.linkedinpinpointanswer.today/krillion-answers/archive';
const ORIGIN = new URL(ARCHIVE_URL).origin;
const DAY_PATH = /^\/krillion-answers\/(\d{4}-\d{2}-\d{2})$/u;

export function dateFromUrl(url: string): string {
  const parsed = new URL(url);
  const date = DAY_PATH.exec(parsed.pathname)?.[1];
  if (parsed.origin !== ORIGIN || !date || parsed.search || parsed.hash) {
    throw new Error(`Not an archive daily URL: ${url}`);
  }
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid date: ${date}`);
  }
  return date;
}

export function parseArchive(html: string, url: string): { days: string[]; next: string | null } {
  const $ = load(html);
  const days = new Set<string>();
  let next: string | null = null;
  $('a[href]').each((_index, element) => {
    const link = $(element);
    const target = new URL(link.attr('href')!, url);
    if (target.origin !== ORIGIN) return;
    if (DAY_PATH.test(target.pathname) && !target.search && !target.hash) {
      days.add(target.href);
    }
    if (target.pathname === '/krillion-answers/archive' &&
        (normalize(link.text()) === 'next' || link.attr('rel') === 'next')) {
      next = target.href;
    }
  });
  if (!days.size) throw new Error('Archive page has no daily links; page may have changed.');
  return { days: [...days], next };
}

export function parseDay(html: string, sourceUrl: string): SeedDay {
  const date = dateFromUrl(sourceUrl);
  const $ = load(html);
  const canonical = $('link[rel="canonical"]').attr('href');
  if (!canonical || new URL(canonical, sourceUrl).href !== sourceUrl) {
    throw new Error(`Daily page identity does not match ${sourceUrl}`);
  }
  const dive = /Dive\s*#(\d+)/iu.exec($('body').text())?.[1];
  if (!dive) throw new Error(`Missing dive number for ${date}`);
  const prompts: SeedDay['prompts'] = [];
  $('article[id^="krillion-prompt-"]').each((_index, element) => {
    const article = $(element);
    const text = article.find('h3').first().text().trim().replace(/\s+/gu, ' ');
    if (!text) throw new Error(`Missing prompt text for ${date}`);
    const answers = new Map<string, SeedAnswer>();
    const rows = article.find('[data-answer="true"]');
    rows.each((_row, answerElement) => {
      const answer = $(answerElement);
      // Read only the answer span. Gem quips and tier explanations are not answers.
      const answerText = answer.find('[data-answer-text="true"]').text().trim();
      const rawScore = answer.attr('data-score');
      const score = Number(rawScore);
      const tier = answer.closest('[data-tier]').attr('data-tier');
      if (!answerText || !rawScore || !Number.isInteger(score) || score < 0 || score > 100 || !tier) {
        throw new Error(`Malformed answer row for ${date}: ${text}`);
      }
      const key = normalize(answerText);
      const previous = answers.get(key);
      if (previous && (previous.score !== score || previous.tier !== tier)) {
        throw new Error(`Conflicting duplicate answer: ${answerText}`);
      }
      answers.set(key, { text: answerText, score, tier, aliases: [] });
    });
    // The source exposes a count per tier. Detect truncated/missing answer markup.
    article.find('[data-tier]').each((_tier, tierElement) => {
      const tier = $(tierElement);
      const countText = tier.find('[data-answer-count="true"]').first().text();
      const expected = Number(countText.replace(/[^\d]/gu, ''));
      if (!countText || expected !== tier.find('[data-answer="true"]').length) {
        throw new Error(`Tier answer count mismatch for ${date}: ${text}`);
      }
    });
    if (!answers.size) throw new Error(`No answers for ${date}: ${text}`);
    prompts.push({ text, key: normalize(text), answers: [...answers.values()] });
  });
  if (prompts.length !== 7 || new Set(prompts.map(p => p.key)).size !== 7) {
    throw new Error(`Expected 7 distinct prompts for ${date}, found ${prompts.length}`);
  }
  return { date, dive: Number(dive), sourceUrl, prompts };
}
