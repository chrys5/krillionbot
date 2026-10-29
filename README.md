# Krillion Bot

A local-first Puffer Party bot, being implemented in checkpoints. See [SPEC.md](SPEC.md) for product scope.

## Checkpoints

1. Seed import and incremental updates. **Implemented and verified.**
2. Unpacked extension gameplay. **User confirmed live success on a Justin Bieber song question.**
3. Text-only structured LLM generation, persistent suggestion cache and acceptance learning. **Implemented; local verification and live setup in [LLM_TESTING.md](LLM_TESTING.md).**
4. Bounded LLM retries, failure diagnostics, and stable input preparation (0.3.1). **Implemented and verified locally: 67 tests pass. Live checks remain user-run.**

Pause for review after each checkpoint is implemented and verified. Reconnect/recovery and web search follow the MVP.

### Checkpoint 1 verification (October 28, 2026)

- Imported all 105 dates listed by the source archive, July 16 through October 28: 735 distinct prompts and 500,047 answer rows. No import failures.
- Retained the one-time artifact in `data/seed.json` (about 33.6 MB).
- Ran a second live update: all 105 dates skipped, no daily pages refetched, and the seed file's SHA-256 and last-write time remained unchanged.
- Passed 11 offline tests, including new-day merging, no-op reruns, failed-day retries, constraint-preserving matching, used/rejected/alias filtering, and malformed-data protection.
- Verified every indexed prompt returns candidates and excludes a used top answer. Node lookup p95 was 13.94 ms, maximum 192.15 ms; initial file load/validation/indexing took 479 ms in this run. These are development-machine observations, not browser submission guarantees.
- This was the checkpoint 1 baseline. Later checkpoints add browser support and cached LLM fallback.

## Test the Chrome extension

See [TESTING.md](TESTING.md) for the local helper and real-game checklist.

```powershell
npm run test:browser
npm run build:extension
```

The helper runs at `http://127.0.0.1:4173/krillionbot-test/party/TEST`; click **Run checks**. It now includes a mock provider/cache demonstration and clearly labels simulated acceptance. The real unpacked extension is emitted into `build/extension` and starts Off after reload. Configure a provider in the popup to enable new LLM requests; see [LLM_TESTING.md](LLM_TESTING.md).

Checkpoint 2 baseline: **22 automated tests passed** and packaging was checked. The user subsequently confirmed successful live seed submission. New LLM requests and generated-answer acceptance still need the user's real-provider/game test.

Checkpoint 3 baseline: **39 automated tests passed**, including a deterministic text-only provider, the browser helper using production scripts, cache/history persistence across mocked worker/browser restarts, single-flight request deduplication, rejection/duplicate distinctions and stale-response protection. The user subsequently reported some successful LLM gameplay. The default LLM output cap remains 400 tokens with no generated rarity/type fields.

Version **0.3.1** verification: **67 tests pass** across the combined project. Transient provider failures use bounded backoff, adaptive attempt deadlines and `Retry-After`; diagnostics preserve the cause and attempt details. Delayed Send rendering waits rather than immediately stopping. Failed preparations clear abandoned bot text and retry up to three times per turn; manual edits are preserved and stale turns cannot click. The browser helper adds fault scenarios, Send-delay controls and an attempt log. No real API calls or real game acceptance were exercised in this verification. Reload the extension and Krillion, then follow [LLM_TESTING.md](LLM_TESTING.md). Work pauses here for user testing.

## Development

Requires Node.js 20+ and npm. Run from this project directory:

```sh
npm ci
npm test
```

`npm test` compiles TypeScript and runs offline parser, incremental-import, storage, and lookup tests. Fixtures are reduced examples, not the real seed database. Generated JavaScript goes in `dist/`.

After importing real data, run `npm run seed:verify` to check that every indexed prompt resolves, used top answers are excluded, and unknown prompts return no candidates. It also reports local lookup timing; this is not browser/game latency.

## Seed database: create once, update incrementally

The retained artifact is `data/seed.json`, sourced from the [user-provided archive](https://www.linkedinpinpointanswer.today/krillion-answers/archive). It is intended to ship with the extension. Installing dependencies, building, testing, and starting the extension must not scrape or rebuild it.

To explicitly check for new daily dives:

```sh
npm run seed:update
```

The updater reads the existing file, follows the archive index pagination, and fetches **only missing daily dates**. Existing daily records and their source URLs/scores remain intact. If there is no new data, it does not rewrite `seed.json`. It updates `data/seed.report.json` with import counts and any failures; failed dates remain missing and can be retried by rerunning the same command. A malformed existing database stops the command instead of being replaced with an empty one.

The first import fetches all available dates, once. Later runs append newly discovered dates. There is no scheduled refresh yet.

### Themed packs and Unlimited

Run this separate, explicit command to append public numbered chapters:

```sh
npm run seed:packs
# Optionally check one mode (repeat --pack to select several):
npm run seed:packs -- --pack lexicon
```

The importer reads each mode's public `/{gameNumber}` metadata and uses `lastGame` to discover the advertised range. It checks every missing `/{gameNumber}/reveal` independently, including chapters after a locked response. A readable reveal must contain seven distinct rounds matching that chapter's metadata, valid scores, and nonempty answer lists before it is saved. Source URL, pack, chapter, round, version, fetch time, original wording, scores, tiers, and any published aliases are retained. No aliases are inferred. Existing chapter snapshots and daily records are preserved. The backward-compatible `chapters` collection is optional in schema version 1; older daily-only seeds still load.

`data/seed.packs.report.json` records each imported, skipped, locked, unavailable, or failed chapter separately, with its URL and HTTP status when requested. Locked responses are never imported as empty chapters; failed and unavailable chapters remain retryable. A rate limit or server error stops that mode's scan. Imported reveals are skipped on rerun; the chapter-1 metadata request still discovers the current range. A no-op import does not rewrite the seed. Install, build, tests, and extension setup never run either importer.

Live coverage verified October 28, 2026:

| Mode | Advertised chapters checked | Imported | Locked |
| --- | --- | --- | --- |
| Movies | 1–30 | 1 | 2–30 |
| Sports | 1–30 | 1 | 2–30 |
| Geography | 1–30 | 1 | 2–30 |
| Lexicon | 1–30 | 1–30 | None |
| Unlimited | 1–76 | 1 | 2–76 |

The initial 34 imported chapters added 238 question records and 35,084 answer rows to the 105 daily snapshots (500,047 answer rows), bringing that baseline to 968 distinct prompts and 535,131 answer rows. The broader merged bank below retains those original snapshots. These reveals publish no aliases, so their alias arrays are empty. All 162 locked chapters returned HTTP 402; there were zero other unavailable chapters or import failures within the advertised ranges. No claim is made about numbers outside those ranges. `data/seed.verification.json` records the earlier pack preservation checks and a live Lexicon rerun that skipped all 30 chapters, requested only metadata, and left that seed hash and modification time unchanged.

The [companion search](https://krillion-game.com/search/) and [Geography archive](https://krillion-game.com/geography/) were also inspected. All 28 surfaced pack/Unlimited answer pages were verified against their complete answer API responses, including the [published Africa page](https://krillion-game.com/answers/geography/1/r1-country-in-africa/). HTML can contain only the first 50 answers. These companion snapshots differ from current official reveals: three question wordings changed, some answers and scores differ, and Geography lists 301 rows versus 333 in the live official reveal. The comparison is in `data/seed.sources.report.json`; the companion records are now retained as separate collections in the merged bank. The audit found no Lexicon search results. To explicitly repeat this source audit:

```sh
npm run build
node dist/scripts/inspect-pack-sources.js
```

Lookup and extension packaging include every retained source. The initial pack expansion passed 47 offline tests; the merge below extends that validation.

### Merged answer bank (October 29, 2026)

`data/seed.json` now combines the original daily archive, official public pack/Unlimited chapters, the supplied `krillion-answers-2026-10-25 (2).json`, and all 28 previously verified companion answer pages. It contains **1,481 distinct normalized question texts and 994,980 distinct question/answer pairs**, up from 968 and 534,876 before this merge. The 1,191,398 stored answer rows include repeated source observations and conflicting scores. All 4,050 supplied answer notes, per-question first/last-seen timestamps, file SHA-256, local filename, and available companion URL/pack/chapter/round metadata are preserved. Unknown metadata is not inferred for the shared file.

Original daily and official chapter snapshots remain unchanged. Optional `collections` in schema version 1 retain imported sources independently. Lookup combines answers only for exactly matching normalized questions and deduplicates normalized answer text. Punctuation and restrictions remain significant. Conflicting score/tier observations remain stored; selection uses official reveal, then daily archive, then shared file, then companion, with the newest observation date breaking ties within a source class. Shared files use each question's original `lastSeen` time rather than its import time. Notes and aliases can enrich matching answers without replacing the preferred score; returned notes carry their own source attribution. There are 1,875 question/answer pairs with conflicting score/tier observations. Shared-file answers are source observations, not proof of current official acceptance or access to a particular locked chapter.

Repeat or add explicit source imports with:

```powershell
npm run seed:merge -- --input 'data/krillion-answers-2026-10-25 (2).json'
# Offline file-only import; --input may be repeated:
npm run seed:merge -- --input 'data/another-source.json' --skip-companion
```

The shared-file format is the supplied question-keyed JSON export. The entire file is validated before import. Unchanged files are skipped by content hash, and companion URLs already imported are skipped without network requests. A changed file becomes another immutable snapshot. Companion pages use the verified URLs in `data/seed.sources.report.json` and require the full answer API count to match the page before import. Existing companion snapshots are retained on rerun. Failures remain retryable and appear separately in `data/seed.merge.report.json`. A no-op rerun does not rewrite the seed. Nothing imports or regenerates data during setup/build/tests.

The merged bank is about 80 MB. The extension keeps it in the background worker and sends only the small question index and requested candidates to each game tab. Packaging copies the retained bank into `build/extension/seed.json`. All 86 automated tests pass. Every question resolves in the full corpus check, and a repeat merge skips all 29 sources without changing the seed hash or modification time. Merge verification and preservation evidence are recorded in `data/seed.merge.verification.json`.

For a limited initial import to a separate output:

```sh
npm run seed:update -- --max-new-days 1 --output .cache/sample-seed.json
```

Daily pages are parsed using their semantic prompt/tier/answer attributes. Gem explanations are excluded; per-tier counts and all seven prompt blocks must be present before a date is accepted. These checks detect missing markup, not factual errors in the source. Archived Daily answers are candidates for matching Party prompts; live Party acceptance is not yet verified.

## Try a local lookup

```sh
npm run lookup -- "Name a pasta dish"
npm run lookup -- "Name a pasta dish" --used "Pastasciutta antifascista"
```

Use repeated `--used` or `--rejected` flags to exclude multiple answers. Lookup returns up to ten candidates ordered by the selected source's score, then length. Known aliases are also excluded when present. Repeated answers use the source priority described above, with all original observations retained. Prompt matching normalizes case, Unicode, and whitespace and preserves constraints and punctuation. An unknown or exhausted prompt returns an empty list so the next source can be tried later.

Resolution is now seed -> confirmed Party history -> cached unverified suggestions -> a new LLM batch. Generated cache identity includes the exact normalized question, mode, provider/model and prompt/schema version. Batches persist for 24 hours (1 hour for current-fact questions). Keys stay in trusted extension session storage. The seed artifact is extended only through explicit importer commands and is never regenerated on setup. No Google search or related-question matching is implemented.
