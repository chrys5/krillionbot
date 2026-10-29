# Repository map

This guide describes the files present on October 29, 2026. Paths below are relative to the repository root. Generated dependencies and downloaded third-party bundles are grouped rather than documented individually.

## Entry points and runtime flow

This project is a TypeScript Chrome Manifest V3 extension, plus Node.js tools for preparing data and testing it. There is no single `main.ts`, Node server, or standalone executable for normal gameplay.

Chrome loads `build/extension/manifest.json`. The source manifest is `extension-assets/manifest.json`, and `scripts/build-extension.ts` produces four browser bundles:

| Entry point | When and where it runs | Responsibility |
| --- | --- | --- |
| `src/extension/bridge.ts` → `bridge.js` | Krillion page's MAIN world, at `document_start` | Observes the game's WebSocket traffic, reconstructs relevant game observations, and publishes sanitized state/results to the content script. Observes outgoing submission IDs to correlate acknowledgements; does not originate game socket commands. |
| `src/extension/content.ts` → `content.js` | Isolated content script, at `document_idle` | Main per-tab integration: mounts the in-page controls, creates the controller, receives observations, requests candidates/history operations from the worker, runs DOM observation and auto-join, and exposes Enable/Stop/status/diagnostics. |
| `src/extension/background.ts` → `background.js` | Chrome extension service worker | Owns the full seed bank and lookup index, provider requests, settings, credentials, cache/history persistence, cancellation, and runtime message handling. Loads the bank lazily. |
| `src/extension/popup.ts` → `popup.js` | When the toolbar popup opens | Provider configuration, API-host permissions, session key management, auto-join setting, active-tab controls, and the manual LLM/cache test. |

`src/extension/controller.ts` is the main gameplay algorithm. Start there to understand answer selection and submission; start with `content.ts` to understand how the extension is wired into a tab.

```text
Game WebSocket
  → bridge.ts + protocol.ts
  → window.postMessage
  → content.ts
  → BotController
      → background messages
          → SeedLookup
          → confirmed history
          → generated cache
          → provider + retries
      → adapter.ts → game's existing input and Send button
      → actual acceptance/rejection → background history storage

Toolbar popup → settings / worker requests / active-tab Enable and Stop
AutoJoin → visible join, replay, rematch, and wake controls
```

The candidate order is seed → confirmed Party history → cached suggestions → a new LLM batch. The content script receives a small question-key index and requested candidates; the full bank stays in the worker. A ready queue is kept in the tab for submission.

## Directory layout

```text
krillionbot/
├── src/
│   ├── extension/       Chrome integration and gameplay controller
│   ├── resolver/        Seed candidate lookup and ranking
│   ├── llm/             Provider adapter, retries, constraints, cache/history
│   └── data/            Database schema, parsing, validation, import/merge logic
├── extension-assets/    Source manifest and popup HTML
├── scripts/             Explicit Node build, data, lookup, and test-server commands
├── tests/               Automated tests, reduced fixtures, browser simulation
├── data/                Local retained seed, source export, import/audit reports
├── .cache/              Local audit helpers and downloaded investigation artifacts
├── dist/                TypeScript compiler output
├── build/               Loadable extension and browser-test bundle
└── node_modules/        Installed dependencies
```

## Runtime source files

### `src/extension/`

| File | Responsibility |
| --- | --- |
| `content.ts` | Per-tab entry point and wiring described above; also forwards retry progress, cancellation and learning requests, mounts the panel only on Party routes, and coordinates Stop/Enable with auto-join. |
| `controller.ts` | `BotController` state machine: category/turn identity, used/rejected answers, candidate queues, off-turn preparation, fallback requests, bounded retries, input ownership/cleanup, one in-flight submission, stale-result protection, and learning from game feedback. |
| `background.ts` | Trusted service-worker entry point: seed/index loading, source resolution, Chrome local/session storage, credential scoping, provider work, and request authorization/validation. |
| `bridge.ts` | Early page-context WebSocket observer and snapshot relay. Uses `PartyFeed` to interpret relevant messages. |
| `protocol.ts` | Sanitized `PartyState`/`Observation` types; validates snapshots, applies versioned patches, correlates submit acknowledgements, constructs category identities, and reconstructs used answers while detecting incomplete event history. |
| `adapter.ts` | Game-specific DOM selectors, current-turn/readiness checks, DOM/protocol category agreement, and filling the controlled input through its native setter plus an input event. This is the first place to inspect if the game's HTML changes. |
| `auto-join.ts` | Recognizes eligible join/replay/rematch/wake controls; handles visibility, disabled state, stable-control delay, click spacing, and active-round exclusions. Defines the persistent auto-join setting key. |
| `messaging.ts` | Content-to-worker request helper and safe, actionable error messages for invalidated extension contexts, unavailable workers, and storage failures. |
| `popup.ts` | Toolbar popup event handlers and settings UI integration described above. |

### `src/resolver/`

| File | Responsibility |
| --- | --- |
| `seed-lookup.ts` | `SeedLookup`: indexes prompt references, uses exact normalized questions, combines source observations, deduplicates answers, preserves/enriches aliases and notes, filters used/rejected/oversized answers, and returns ranked candidates (10 by default). |

For conflicting observations of the same answer, preferred source order is official reveal → daily archive → shared file → companion. Newer observation dates break ties within a source class. Once a preferred score is selected, candidates sort by score descending, then answer length, then text. Different question restrictions are not merged.

### `src/llm/`

| File | Responsibility |
| --- | --- |
| `provider.ts` | Settings/defaults/validation; Responses and compatible Chat Completions requests; text-only candidate schema; output extraction, cleanup, deduplication and constraint validation; provider error classification. |
| `cache.ts` | `AnswerCache`: persistent generated batches, accepted/invalid history, expiry, cache identity, request sharing, cancellation subscriptions, provider holds, request metrics/session limits, and history → cache → provider resolution. Uses injected stores so it can run in Chrome and tests. |
| `constraints.ts` | Extracts/checks simple explicit question constraints, including prefix/suffix, quoted substring, letter counts and letter bank. Detects current-fact wording to shorten freshness. |
| `retry.ts` | Bounded provider retry chains: adaptive attempt deadlines, total budget, backoff/jitter, `Retry-After`, cancellation, progress and attempt traces. |
| `failure.ts` | Typed provider failures, safe failure information, cancellation errors, and parsing numeric/date `Retry-After` headers. |

### `src/data/`

These include both runtime-safe shared modules and Node-only maintenance modules. Importers do not run as part of gameplay.

| File | Responsibility |
| --- | --- |
| `types.ts` | Seed schema: answers/prompts, daily snapshots, official chapters, imported collections, source metadata and import report types. |
| `normalize.ts` | Shared Unicode/case/whitespace normalization used for question/answer identity. Preserves punctuation and restrictions. |
| `records.ts` | Presents daily, official chapter and collection snapshots through one record interface, attaching provenance and source priority for lookup/statistics. |
| `archive.ts` | Parses the daily archive index/pagination and seven-question daily pages with Cheerio; validates page identity, answer rows and tier counts. |
| `update.ts` | Incremental daily-import orchestration, empty database creation and basic statistics. Fetches missing dates, preserves imported days, reports failures. |
| `packs.ts` | Official pack catalogues, chapter metadata/reveal parsing and incremental imports. Distinguishes imported/skipped/locked/unavailable/failed chapters and checks later chapters after locked responses. |
| `merge.ts` | Shared question-keyed export parsing, full companion-page/API parsing, provenance/notes/timestamp preservation, content hashes and immutable collection insertion. |
| `store.ts` | Node filesystem access: reads and validates retained databases, refuses malformed existing data, and writes JSON via temporary file plus rename. |
| `coverage.ts` | Corpus audit counts: distinct prompts, distinct question/answer pairs, stored rows, notes/aliases and conflicting score/tier observations. |

## All maintained scripts and how to run them

Run from the repository root. npm commands compile TypeScript first. Node.js 20+ is required.

| Source script | Command | Purpose and output |
| --- | --- | --- |
| `scripts/build-extension.ts` | `npm run build:extension` | Bundles the four Chrome entry points with esbuild; copies the manifest, popup HTML and retained `data/seed.json` to `build/extension/`; writes `build-info.json` with version and seed SHA-256. Does not import data. |
| `scripts/serve-test.ts` | `npm run test:browser` | Builds the extension, bundles `tests/browser/harness.ts` to `build/fixture.js`, and serves the local simulation at `http://127.0.0.1:4173/krillionbot-test/party/TEST`. Click Run checks. Stops with Ctrl+C. Uses the retained seed; simulated game/provider feedback. |
| `scripts/lookup.ts` | `npm run lookup -- "exact question"` | Offline seed lookup CLI; prints candidates with provenance. Supports repeated `--used` and `--rejected` flags and `--database PATH`. Does not invoke the LLM/history path. |
| `scripts/update-seed.ts` | `npm run seed:update` | Network importer for missing daily archive dates. Updates `data/seed.json` only when days are added; writes `data/seed.report.json`. Supports `--max-new-days N` and `--output PATH`. |
| `scripts/update-packs.ts` | `npm run seed:packs` | Network importer for public official chapters in movies, sports, geography, lexicon and unlimited. Writes `data/seed.packs.report.json`; adds readable missing chapters to the seed. Supports repeated `--pack NAME` and `--output PATH`. |
| `scripts/merge-seed.ts` | `npm run seed:merge -- --input PATH` | Imports one or more shared JSON exports and, by default, missing companion pages listed in the audit report. Writes `data/seed.merge.report.json`; appends source collections to the seed. Supports repeated `--input`, `--skip-companion`, `--companion-report PATH` and `--output PATH`. Identical file hashes/already imported companion URLs are skipped. |
| `scripts/inspect-pack-sources.ts` | `npm run build`, then `node dist/scripts/inspect-pack-sources.js` | Explicit network audit of companion search/archive pages and full answer API results against retained official chapters. Writes `data/seed.sources.report.json`, which the merge tool uses as its companion-source manifest. Does not modify the seed. No npm alias. |
| `scripts/verify-seed.ts` | `npm run seed:verify` | Offline whole-bank check against `data/seed.json`: each indexed question resolves, used top answers are excluded, an unknown question returns nothing. Prints corpus statistics and Node load/lookup timing; does not write a verification report file. |

Examples:

```powershell
# Refresh the main bank from the daily archive and official public chapters.
npm run seed:update
npm run seed:packs

# Restrict chapter checks to one or more modes.
npm run seed:packs -- --pack lexicon --pack geography

# Add a shared export without companion network requests.
npm run seed:merge -- --input 'data/another-source.json' --skip-companion

# Reuse the supplied export and import any missing known companion sources.
npm run seed:merge -- --input 'data/krillion-answers-2026-10-25 (2).json'

# Debug exact matching and exclusions.
npm run lookup -- 'Name a pasta dish' --used 'Spaghetti' --rejected 'Lasagne'

# Validate the updated bank, then copy it into the extension package.
npm run seed:verify
npm run build:extension

# Small archive sample in a separate database.
npm run seed:update -- --max-new-days 1 --output .cache/sample-seed.json
```

`--output` selects the database to read/update; it does not first clone `data/seed.json`. A missing output starts with an empty database. After updating the main bank, rebuild the extension, reload its Chrome extension card, and refresh the game tab to use the packaged copy.

## Automated tests and browser helper

| Command | Scope |
| --- | --- |
| `npm run build` | TypeScript compile/type check into `dist/`; includes source, scripts and tests. Does not create the loadable extension package. |
| `npm test` | Build, then all Node tests in `dist/tests`. Uses fixtures/mocks; no real provider or game requests and no seed regeneration. |
| `npm run test:llm` | Build, then `llm.test`, `background.test` and `retry.test`. |
| `npm run test:controller` | Build, then `extension.test`. |
| `npm run test:browser` | Start the manual browser helper described above; this is a running local server. |
| `node --test dist/tests/merge.test.js` | Example of running one compiled test file after `npm run build`. Any test file below can be selected this way. |

| Test file | What it covers |
| --- | --- |
| `tests/seed.test.ts` | Archive/daily parsing, normalization, seed matching/ranking/exclusions, incremental imports, retryable failures, pagination loops and storage validation. |
| `tests/packs.test.ts` | Pack metadata/reveals, incomplete/locked/malformed responses, import status handling, no-op reruns, rate limits, provenance and database preservation. |
| `tests/merge.test.ts` | Shared/companion formats, complete counts and identity, hash idempotency, notes/timestamps/provenance, source conflicts/priority, exact restrictions and storage round trips. |
| `tests/extension.test.ts` | Protocol and gameplay controller: off-turn preparation, used answers/aliases, one submission, rejection backups, delayed Send, input ownership/manual edits, cancellation, stale results, learning and fallback retries. |
| `tests/auto-join.test.ts` | Join/replay/wake selection, timing/duplicate prevention, hidden/disabled controls, saved setting and production content Stop/Enable integration. |
| `tests/llm.test.ts` | Provider request shapes, candidate validation, cache identity/persistence/expiry, history, request deduplication and safe failures. |
| `tests/retry.test.ts` | Timeout growth, retry budgets/backoff, `Retry-After`, non-retryable errors, shared cancellation, cooldowns and worker recreation. |
| `tests/background.test.ts` | Production worker integration with mocked Chrome APIs: persisted batches, worker restart, private session keys and acceptance learning. |
| `tests/popup.test.ts` | Production popup configuration/key flow: saving, reopening, retaining keys, host scoping and forgetting keys. |
| `tests/messaging.test.ts` | Safe recovery messages for extension/worker/storage failures. |
| `tests/browser-harness.test.ts` | Bundles and runs the production bridge/content with the local helper in jsdom, verifying its automated check sequence without starting the HTTP server. |
| `tests/browser/harness.ts` | Interactive simulated game, fake socket/Chrome messaging, seed lookup, mock provider faults, disposable/persistent test cache namespaces, turn/used/rejection controls and automated checks. |
| `tests/browser/index.html` | Helper page markup, simulated answer UI and manual fault/timing controls. |
| `tests/fixtures/daily.html` | Reduced daily archive HTML fixture for parser tests. |

## Retained data and runtime storage

`data/` is present locally and ignored by Git. Its current files are:

| File | Responsibility |
| --- | --- |
| `data/seed.json` | Authoritative retained bank for packaging, about 80 MB. Stores daily snapshots, official chapters and imported collections. |
| `data/krillion-answers-2026-10-25 (2).json` | Original supplied question-keyed export consumed by the shared-file importer, about 92 MB. Kept separately from the merged bank. |
| `data/seed.report.json` | Latest daily-import counts and failures. |
| `data/seed.packs.report.json` | Official pack catalogue/chapter outcomes, including locked and failed chapters. |
| `data/seed.sources.report.json` | Companion source audit and verified answer-page/API URLs; also input to companion merging. |
| `data/seed.merge.report.json` | Latest merge's before/after coverage, imported/skipped/failed sources and preservation checks. |
| `data/seed.verification.json` | Recorded earlier pack preservation/no-op verification evidence. |
| `data/seed.merge.verification.json` | Recorded merge preservation, source coverage, packaged hash and no-op verification evidence. |

Gameplay does not write `data/seed.json`. Chrome `storage.local` holds settings, auto-join, confirmed/invalid history, generated suggestions and metrics. Chrome `storage.session` holds the host-scoped API credential and session request/retry state. Generated suggestions and confirmed history are separate from the seed and from each other. Session credentials are entered through the popup.

## Local audit helpers outside `scripts/`

These files exist under ignored `.cache/`; they are investigation artifacts, are not compiled by `tsconfig.json`, and have no npm aliases. Run them from the repository root after `npm run build` if their historical assumptions still fit.

| File | Purpose and limitations |
| --- | --- |
| `.cache/compare-shared-seed.mjs` | `node .cache/compare-shared-seed.mjs`: compares the hard-coded supplied export with daily/chapter seed snapshots; reports extra questions/answers, notes, score/tier differences and field/timestamp details to `.cache/shared-seed-comparison.json`. Deliberately indexes `days`/`chapters`, not merged `collections`, so it is a pre-merge comparison tool rather than a complete current-bank diff. Does not change the seed. |
| `.cache/verify-merged-seed.mjs` | `node .cache/verify-merged-seed.mjs`: historical, assertion-heavy merge audit; checks source preservation, packaged seed hash and no-op evidence, then writes `data/seed.merge.verification.json`. Assumes a seed at `HEAD:data/seed.json`, a saved `.cache/pre-merge-rerun.json`, the original source export and exact historical counts/examples. The current Git ignore policy excludes the seed, so this is not a general-purpose replacement for `seed:verify` and may need a different baseline. |

Other local cache contents:

- `.cache/archive/`: downloaded archive index and sample daily HTML.
- `.cache/packs/`: downloaded official/companion HTML, a site JavaScript bundle, and earlier baseline/import verification JSON.
- `.cache/party/`: downloaded game page/bundles, including prettified copies used to inspect the game integration. These are third-party inspection snapshots, not extension modules or maintained utilities.
- `.cache/shared-seed-comparison.json`: comparison helper output.
- `.cache/pre-merge-rerun.json`: saved hash/modification-time baseline for the historical merge audit.
- `.cache/isolated-browser-check.png`: local visual verification screenshot.
- `.cache/npm/`, `.cache/tests/`: local dependency/test scratch space.

## Assets, configuration, documentation and generated output

| Path | Responsibility |
| --- | --- |
| `extension-assets/manifest.json` | Chrome Manifest V3 source: permissions, provider host access, minimum Chrome version, worker/popup and content-script registration. |
| `extension-assets/popup.html` | Toolbar popup markup/styles, provider controls, request limits, auto-join and manual cache/LLM test. Loads packaged `popup.js`. |
| `package.json` | Node version requirement, npm commands and dependencies. Cheerio is the parser dependency; TypeScript/esbuild/jsdom and type packages support development. |
| `package-lock.json` | Locked dependency resolution for reproducible `npm ci`. |
| `tsconfig.json` | Strict ES2022/NodeNext TypeScript compilation; includes `src`, `scripts` and `tests`, emitting to `dist`. |
| `.gitignore` | Excludes dependencies, generated output, caches, local databases/reports, environment files and temporary artifacts. |
| `.env` | Local ignored environment file. The inspected source/scripts do not load dotenv or read `process.env`; extension credentials use the popup/session store. Its contents are not needed for the current runtime map. |
| `README.md` | Project overview, implementation checkpoints, data-source/merge policies and command examples. Some earlier test counts describe historical checkpoints. |
| `TESTING.md` | Browser helper, loading/reloading the unpacked extension, auto-join behavior, live seed checks and troubleshooting. |
| `LLM_TESTING.md` | LLM/cache/history/retry behavior, deterministic fault drills, provider setup, live verification and diagnostics. |
| `SPEC.md` | Product scope, architecture, initial implementation intent and deferred features. Use current code for exact behavior where later changes supersede the original plan. |
| `TODO_QUESTION_ENRICHMENT.md` | Proposed persistent discovery of observed questions and user-started advance enrichment. Explicitly not implemented; there is currently no enrichment CLI or durable question catalogue. |
| `dist/src/`, `dist/scripts/`, `dist/tests/` | Compiler-generated JavaScript mirroring the TypeScript sources; Node tools/tests run here. Edit TypeScript sources instead. |
| `build/extension/` | Chrome's load-unpacked directory: four JS bundles, manifest, popup HTML, copied seed and `build-info.json`. Rebuild to reflect source/seed changes. |
| `build/fixture.js` | Bundled local browser harness generated by `serve-test.ts`. |
| `node_modules/` | Installed dependencies; generated by npm. |
| `.git/` | Git repository metadata. |

## Where to make common changes

| Change | Start here |
| --- | --- |
| Answer timing, retries after rejection, stale submissions | `src/extension/controller.ts` |
| Game input/Send selectors or turn detection | `src/extension/adapter.ts` |
| WebSocket message format or patch reconstruction | `src/extension/bridge.ts`, `src/extension/protocol.ts` |
| Join/replay control recognition | `src/extension/auto-join.ts` |
| Provider request/prompt/schema/default settings | `src/llm/provider.ts` |
| Provider retry timing and attempt traces | `src/llm/retry.ts`, `src/llm/failure.ts` |
| Suggestion/history retention and fallback policies | `src/llm/cache.ts` |
| Source precedence, deduplication or seed ranking | `src/data/records.ts`, `src/resolver/seed-lookup.ts` |
| Daily source markup | `src/data/archive.ts` |
| Shared export format | `src/data/merge.ts` |
| Extension settings UI | `extension-assets/popup.html`, `src/extension/popup.ts` |
| New seed data | Explicit `seed:update`, `seed:packs` or `seed:merge`, then verify and rebuild |
