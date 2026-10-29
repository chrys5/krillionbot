import { ARCHIVE_URL, dateFromUrl, parseArchive, parseDay } from './archive.js';
import type { ImportReport, SeedDatabase } from './types.js';
import { seedRecords } from './records.js';

export type FetchHtml = (url: string) => Promise<string>;

export function emptyDatabase(): SeedDatabase {
  return { schemaVersion: 1, source: ARCHIVE_URL, days: {} };
}

export function databaseStats(database: SeedDatabase) {
  const prompts = seedRecords(database).flatMap(record => record.prompts);
  return {
    totalDays: Object.keys(database.days).length,
    uniquePrompts: new Set(prompts.map(prompt => prompt.key)).size,
    answerRows: prompts.reduce((sum, prompt) => sum + prompt.answers.length, 0),
  };
}

// Existing imported days are immutable. Only missing dates are requested and appended.
export async function updateSeed(
  database: SeedDatabase,
  fetchHtml: FetchHtml,
  options: { maxNewDays?: number; onProgress?: (message: string) => void } = {},
): Promise<ImportReport> {
  const report: ImportReport = {
    checkedAt: new Date().toISOString(), archivePagesFetched: 0,
    discoveredDays: 0, skippedDays: 0, importedDays: [], failures: [],
    ...databaseStats(database),
  };
  const dailyUrls = new Set<string>();
  const visited = new Set<string>();
  let next: string | null = ARCHIVE_URL;
  while (next) {
    const url: string = next;
    try {
      if (visited.has(url)) throw new Error('Archive pagination loop detected');
      visited.add(url);
      const page = parseArchive(await fetchHtml(url), url);
      report.archivePagesFetched++;
      page.days.forEach(day => dailyUrls.add(day));
      next = page.next;
    } catch (error) {
      report.failures.push({ url, error: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  report.discoveredDays = dailyUrls.size;
  report.skippedDays = [...dailyUrls].filter(url => database.days[dateFromUrl(url)]).length;
  const missing = [...dailyUrls].filter(url => !database.days[dateFromUrl(url)])
    .sort().reverse().slice(0, options.maxNewDays ?? Infinity);
  for (const url of missing) {
    try {
      const day = parseDay(await fetchHtml(url), url);
      database.days[day.date] = day;
      report.importedDays.push(day.date);
      options.onProgress?.(`Imported ${day.date}: ${day.prompts.reduce((n, p) => n + p.answers.length, 0)} answers`);
    } catch (error) {
      report.failures.push({ url, error: error instanceof Error ? error.message : String(error) });
      options.onProgress?.(`Failed ${url}: ${report.failures.at(-1)!.error}`);
    }
  }
  return Object.assign(report, databaseStats(database));
}
