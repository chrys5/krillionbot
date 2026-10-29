# Architecture

Krillion Bot is a TypeScript Chrome Manifest V3 extension. Node.js tools build the extension, prepare its answer bank, and run tests. Gameplay runs in the browser without a hosted backend.

## Runtime flow

```text
Game WebSocket
  → page bridge and protocol observer
  → content script
  → gameplay controller
      ↔ background worker: seed → history → cache → provider
      → DOM adapter → game's input and Send button
      → game feedback → accepted / invalid answer history

Toolbar popup → settings, active-tab controls, and diagnostics
```

Chrome loads four bundles from `build/extension/`, built by [build-extension.ts](../scripts/build-extension.ts):

| Entry point | Responsibility |
| --- | --- |
| [bridge.ts](../src/extension/bridge.ts) | Runs in the page's MAIN world at document start. Observes WebSocket traffic and relays sanitized game state and results. |
| [content.ts](../src/extension/content.ts) | Runs as an isolated content script. Wires together observations, the controller, in-page controls, worker messages, and auto-join. |
| [background.ts](../src/extension/background.ts) | Service worker for seed loading, provider requests, credentials, settings, history, cache, and diagnostic persistence. |
| [popup.ts](../src/extension/popup.ts) | Toolbar UI for provider configuration, request limits, session keys, active-tab controls, and log export. |

The [controller](../src/extension/controller.ts) prepares candidates during other players' turns. Before submitting, it checks the question, turn, input readiness, and current exclusions. It permits one submission in flight, discards stale work, preserves manual input, and learns from observed game results.

The [protocol observer](../src/extension/protocol.ts) reconstructs state and correlates submission results. The [DOM adapter](../src/extension/adapter.ts) checks the game's controls and fills its existing input. These are the main integration points when the game changes.

## Answer resolution and storage

Candidates resolve in this order:

1. Bundled seed answers for the exact normalized question.
2. Answers previously accepted in Party mode.
3. Unexpired, unverified generated suggestions.
4. A new LLM batch if no usable local candidate remains.

The build partitions `data/seed.json` into `seed/index.json` and per-question files. The worker loads the index and fetches the matching local question file on demand, retaining the current question. Tabs receive question keys and small candidate batches. The [bundled-seed loader](../src/resolver/bundled-seed.ts) and [partitioning module](../src/data/shards.ts) implement this layout.

The [seed resolver](../src/resolver/seed-lookup.ts) combines matching source observations, filters used/rejected answers, and ranks candidates. Question identity preserves punctuation and restrictions. [Answer matching](../src/data/answer-matching.ts) handles formatting and known equivalents, with stricter identity for spelling questions.

Conflicting observations remain stored. Preferred source order is official reveal → Daily archive → shared file → companion, with newer observation dates breaking ties within a source class. Ranking uses the preferred score, then answer length and text. Source scores do not guarantee live acceptance.

| Storage | Contents |
| --- | --- |
| `data/seed.json` | Local source database for packaging and maintenance tools; ignored by Git. Gameplay does not modify it. |
| Chrome `storage.local` | Settings, auto-join/recovery preferences, accepted/invalid history, generated suggestions, metrics, and bounded diagnostic logs. |
| Chrome `storage.session` | Host-scoped API credential and session request/retry state. Credentials remain in trusted extension contexts. |

See the [LLM guide](llm.md) for provider formats, cache identity, expiry, retries, and learning rules.

## Source layout

| Directory | Purpose |
| --- | --- |
| [src/extension/](../src/extension) | Chrome integration, gameplay controller, protocol/DOM adapters, auto-join, draggable panel, messaging, and diagnostics. |
| [src/resolver/](../src/resolver) | Seed loading, candidate lookup, and ranking. |
| [src/llm/](../src/llm) | Provider adapter, constraints, cache/history, retries, and failure handling. |
| [src/data/](../src/data) | Schema, normalization, source parsing, incremental imports, merging, partitioning, and coverage checks. |
| [extension-assets/](../extension-assets) | Source manifest and popup HTML. |
| [scripts/](../scripts) | Build, data maintenance, lookup, verification, and browser-helper commands. |
| [tests/](../tests) | Offline tests, reduced fixtures, and the browser simulation. |

Generated `dist/` contains compiled JavaScript; `build/extension/` is the loadable extension. Both are ignored by Git. Edit TypeScript sources and rebuild.

## Data tools

Imports run only through explicit maintenance commands. They preserve source snapshots, validate incoming data, and leave the seed unchanged on no-op reruns.

| Command | Source / output |
| --- | --- |
| `npm run seed:update` | [Daily importer](../scripts/update-seed.ts); fetches missing dates and writes an import report. Supports `--max-new-days N` and `--output PATH`. |
| `npm run seed:packs` | [Public chapter importer](../scripts/update-packs.ts); reports imported, skipped, locked, unavailable, and failed chapters. Supports repeated `--pack NAME` and `--output PATH`. |
| `npm run seed:merge` | [Merge tool](../scripts/merge-seed.ts); imports question-keyed exports and companion sources. Supports repeated `--input PATH`, `--skip-companion`, `--companion-report PATH`, and `--output PATH`. |
| `npm run seed:verify` | [Verifier](../scripts/verify-seed.ts); checks full-bank lookup/exclusions and prints coverage and local timings. |
| `npm run lookup -- "exact question"` | [Lookup CLI](../scripts/lookup.ts); supports repeated `--used` / `--rejected` and `--database PATH`. Uses seed answers only. |

For a file-only merge, use `npm run seed:merge -- --input 'data/answers.json' --skip-companion`. The [shared-file parser](../src/data/merge.ts) defines the accepted format. Companion merging requires a source report; create one with `npm run build` followed by `node dist/scripts/inspect-pack-sources.js`. This explicit network audit writes `data/seed.sources.report.json` without modifying the bank.

`--output` selects the database to read and update; a missing path starts an empty database. After updating the bank, verify it, rebuild the extension, reload its Chrome extension card, and refresh the game tab.
