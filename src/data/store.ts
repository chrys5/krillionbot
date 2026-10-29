import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ARCHIVE_URL } from './archive.js';
import { normalize } from './normalize.js';
import type { SeedDatabase } from './types.js';
import { emptyDatabase } from './update.js';
import { chapterKey, packBase, PACKS } from './packs.js';
import { validateCompanionSource } from './merge.js';

export async function readDatabase(path: string): Promise<SeedDatabase> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDatabase();
    throw error;
  }
  const database = JSON.parse(raw) as SeedDatabase;
  if (database.schemaVersion !== 1 || database.source !== ARCHIVE_URL ||
      !database.days || typeof database.days !== 'object' || Array.isArray(database.days)) {
    throw new Error('Invalid seed database. Refusing to replace existing data.');
  }
  for (const [date, day] of Object.entries(database.days)) {
    if (day.date !== date || !Array.isArray(day.prompts) || day.prompts.length !== 7) {
      throw new Error(`Invalid stored day ${date}`);
    }
    for (const prompt of day.prompts) {
      if (typeof prompt.text !== 'string' || prompt.key !== normalize(prompt.text) ||
          !Array.isArray(prompt.answers) || !prompt.answers.length ||
          prompt.answers.some(answer => typeof answer.text !== 'string' || !answer.text.trim() ||
            !Number.isInteger(answer.score) || answer.score < 0 || answer.score > 100 ||
            typeof answer.tier !== 'string' || !Array.isArray(answer.aliases) ||
            answer.aliases.some(alias => typeof alias !== 'string'))) {
        throw new Error(`Invalid stored prompt in ${date}`);
      }
    }
  }
  if (database.chapters !== undefined) {
    if (!database.chapters || typeof database.chapters !== 'object' || Array.isArray(database.chapters)) {
      throw new Error('Invalid stored chapters');
    }
    for (const [key, chapter] of Object.entries(database.chapters)) {
      if (!chapter || !PACKS.includes(chapter.pack) || !Number.isSafeInteger(chapter.chapter) || chapter.chapter < 1 ||
          key !== chapterKey(chapter.pack, chapter.chapter) ||
          chapter.sourceUrl !== `${packBase(chapter.pack)}/${chapter.chapter}/reveal` ||
          typeof chapter.fetchedAt !== 'string' || !Number.isFinite(Date.parse(chapter.fetchedAt)) ||
          typeof chapter.version !== 'string' || !chapter.version ||
          !Array.isArray(chapter.prompts) || chapter.prompts.length !== 7 ||
          new Set(chapter.prompts.map(p => p.round)).size !== 7 ||
          new Set(chapter.prompts.map(p => p.key)).size !== 7) throw new Error(`Invalid stored chapter ${key}`);
      for (const prompt of chapter.prompts) {
        if (typeof prompt.round !== 'string' || !prompt.round || typeof prompt.text !== 'string' || !prompt.text.trim() ||
            prompt.key !== normalize(prompt.text) || !Array.isArray(prompt.answers) || !prompt.answers.length ||
            prompt.answers.some(answer => !answer || typeof answer.text !== 'string' || !answer.text.trim() ||
              !Number.isInteger(answer.score) || answer.score < 0 || answer.score > 100 ||
              typeof answer.tier !== 'string' || !answer.tier || !Array.isArray(answer.aliases) ||
              answer.aliases.some(alias => typeof alias !== 'string' || !alias.trim()))) {
          throw new Error(`Invalid stored prompt in ${key}`);
        }
      }
    }
  }
  if (database.collections !== undefined) {
    if (!database.collections || typeof database.collections !== 'object' || Array.isArray(database.collections)) throw new Error('Invalid stored collections');
    for (const [key, collection] of Object.entries(database.collections)) {
      if (!collection || !['shared-file', 'companion'].includes(collection.kind) ||
          typeof collection.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(collection.sha256) ||
          key !== `${collection.kind}:${collection.sha256}` || typeof collection.importedAt !== 'string' ||
          !Number.isFinite(Date.parse(collection.importedAt)) || !Array.isArray(collection.prompts) ||
          !collection.prompts.length || new Set(collection.prompts.map(p => p.key)).size !== collection.prompts.length) {
        throw new Error(`Invalid stored collection ${key}`);
      }
      if (collection.kind === 'shared-file') {
        if (typeof collection.sourceFile !== 'string' || !collection.sourceFile.trim()) throw new Error(`Missing source file in ${key}`);
      } else {
        if (collection.prompts.length !== 1) throw new Error(`Invalid companion prompt count in ${key}`);
        validateCompanionSource({ sourceUrl: collection.sourceUrl!, answersUrl: collection.answersUrl!,
          pack: collection.pack!, chapter: collection.chapter!, round: collection.prompts[0]!.round! });
      }
      for (const prompt of collection.prompts) {
        if (!prompt || typeof prompt.text !== 'string' || !prompt.text.trim() || prompt.key !== normalize(prompt.text) ||
            !Array.isArray(prompt.answers) || !prompt.answers.length ||
            new Set(prompt.answers.map(a => normalize(a.text))).size !== prompt.answers.length ||
            prompt.answers.some(a => typeof a.text !== 'string' || !a.text.trim() || !Number.isInteger(a.score) ||
              a.score < 0 || a.score > 100 || typeof a.tier !== 'string' || !a.tier ||
              !Array.isArray(a.aliases) || a.aliases.some(alias => typeof alias !== 'string' || !alias.trim()) ||
              (a.note !== undefined && (typeof a.note !== 'string' || !a.note.trim())))) throw new Error(`Invalid stored collection prompt in ${key}`);
        if (collection.kind === 'shared-file' && (typeof prompt.firstSeen !== 'string' || typeof prompt.lastSeen !== 'string' ||
            !Number.isFinite(Date.parse(prompt.firstSeen)) || !Number.isFinite(Date.parse(prompt.lastSeen)) ||
            Date.parse(prompt.firstSeen) > Date.parse(prompt.lastSeen))) throw new Error(`Invalid stored source timestamps in ${key}`);
      }
    }
  }
  return database;
}

export async function writeJson(path: string, value: unknown, pretty = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`, 'utf8');
  await rename(`${path}.tmp`, path);
}
