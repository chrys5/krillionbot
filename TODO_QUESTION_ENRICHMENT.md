# TODO: Question discovery and background answer enrichment

Status: proposed follow-up checkpoint; not implemented.

## Goal

Persist every newly encountered Party question, including questions absent from the
seed database. Later, outside the live game's response deadline, generate a larger
pool of text candidates so future games can answer from local storage.

Keep this separate from the small, latency-sensitive LLM requests used during play.
Recording a question must never require a paid request.

## Current behavior and gap

- Exact seed membership is available through `SeedLookup.hasPrompt()` and the
  controller's `seedMatched` status.
- Answer provenance is tracked as `seed`, `history`, `cache`, or `llm`.
- Generated batches and accepted/invalid answer history persist in extension storage.
- There is no persistent catalogue of every observed question. A question with no
  generated batch or recorded game feedback can be lost after the session.
- Generated suggestions currently expire after 24 hours, or 1 hour for questions
  identified as involving current facts. Each generated cache entry retains at
  most 100 candidates. These policies need review for advance enrichment.

Seed membership is not proof that every valid answer is known. Preserve archive
provenance without setting an unsupported `allAnswersKnown` flag. Game acceptance
confirms an individual answer, not completeness of the question's answer set.

## Persistent question catalogue

Create an extension-owned catalogue independent of generated caches and provider
settings. Use exact normalized question plus game mode as its identity; preserve
constraints, numbers, dates, negation, and other qualifiers.

Suggested record:

| Field | Meaning |
| --- | --- |
| `key`, `mode` | Normalized question identity and game mode |
| `text` | Original question text used for generation |
| `firstSeenAt`, `lastSeenAt` | Discovery and most recent encounter |
| `encounterCount` | Number of distinct category occurrences observed |
| `seedMatched` | Whether the current bundled seed contains this exact question |
| `enrichment.status` | `pending`, `running`, `ready`, or `failed` |
| `enrichment.lastAttemptAt`, `lastCompletedAt` | Progress timestamps |
| `enrichment.lastError` | Safe, credential-free error summary |

Expose confirmed-answer and usable-suggestion counts by querying existing answer
stores, rather than maintaining conflicting copies of those counts. Generated
counts remain specific to the selected provider/model/cache configuration.

- Record a valid observed category immediately, before resolving answers.
- Discovery must not depend on successful generation, acceptance, an API key, or
  automatic submission being enabled.
- Deduplicate repeated state updates: count a category occurrence once, not every
  observer tick. Do not persist player identities or chat to identify encounters.
- Reconcile seed membership when the bundled seed changes. A previously unseeded
  question may become seeded after an incremental daily archive update.
- Catalogue records do not expire when suggestions expire or are cleared.
- Keep recording lightweight and asynchronous so it does not delay submission.

## Enrichment pass

For the MVP, provide an explicit user-started enrichment pass. Persist the queue
and progress, but do not introduce scheduled jobs or an always-running service.
Chrome service-worker suspension must not cause a job to remain permanently
`running`; an interrupted job can be made eligible on the next explicit run.

1. Select unseeded questions that have fewer usable candidates than the target.
2. Prioritize frequently encountered questions, then questions with no candidates.
3. Recheck existing history and fresh suggestions before making a paid request.
4. Request additional text candidates in bounded batches, excluding already stored
   answers and applicable invalid evidence. Aim initially for about 100 usable
   candidates per question; make the target configurable.
5. Validate, merge, and deduplicate the whole batch using the existing pipeline.
6. Persist progress after each batch. Stop at the target, configured budget, an
   error, or a batch that adds no usable candidates.

Use the existing provider adapter and settings. Generation stays text-only:
`{"candidates":["answer one","answer two"]}`. Send the exact question and its
constraints. Do not request rarity, word type, official tiers, scores, acceptance
probabilities, or explanations. Actual gameplay validates answers.

Do not generate an entire pool from scratch on each run. Resume from stored
coverage and request only additions. Keep simultaneous requests for the same cache
key deduplicated, including overlap with live resolution.

## Gameplay, cost, and storage rules

- Preserve resolution order: seed -> game-confirmed history -> cached suggestions
  -> a new live LLM batch when no usable local answer remains.
- Pause dispatch of enrichment requests during active gameplay. An already-started
  request may finish and save its result, but must not trigger a game submission.
- Give the pass an explicit request/token budget and a stop control. Do not silently
  turn discovery into paid generation or run unlimited retries.
- Generated candidates remain unverified regardless of batch size. Promote only
  after actual game acceptance; keep invalid evidence separate from duplicates.
- Keep provider/model and prompt/schema versions in generated-cache identity.
  Keep used-answer lists out of that identity and filter them at selection time.
- Keep API keys outside the game page, catalogue, source files, and diagnostics.
- Keep the retained seed artifact separate. Neither discovery nor enrichment
  rebuilds or overwrites it.

The catalogue persists indefinitely. Before implementation, choose an explicit
longer freshness policy for stable-question enriched suggestions; retain short
expiry for current-fact questions. Merely reading a batch must not extend its
freshness. Review the existing 100-candidate retention cap together with the
chosen target so a larger target cannot cause repeated requests that never fit.

## TODO / acceptance checks

- [ ] Add persistent question catalogue and immediate observation recording.
- [ ] Verify discovery without an API key, with generation disabled, and after a
      provider failure; every observed question remains discoverable after reload.
- [ ] Verify repeated updates do not inflate encounter counts and exact constraints
      and game modes remain distinct.
- [ ] Verify seed updates reconcile membership without losing discovery history.
- [ ] Add user-started enrichment with progress, budget, and stop controls.
- [ ] Use a deterministic mock to demonstrate a larger batch, persistence, and a
      second pass making no request when the target is already satisfied.
- [ ] Verify incremental top-up, expiry, invalid filtering, and request deduplication.
- [ ] Verify interrupted jobs are recoverable and active gameplay pauses new work.
- [ ] Verify enriched suggestions enter the existing cache path and gain confirmed
      status only after game acceptance. Clearly label simulated acceptance in tests.
- [ ] Document a simple user-run live check with visible request counts and costs.
- [ ] Pause and report after implementation and verification of this checkpoint.

Out of scope: Google search, related-question matching, automatic scheduling,
reconnect handling, and claims of exhaustive answer coverage.
