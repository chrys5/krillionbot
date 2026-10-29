# Krillion Bot: Chrome extension MVP specification

Status: implementation authorized October 28, 2026. Work in checkpoints and pause after each feature is implemented and verified. Checkpoint 1 covers seed data and lookup; browser gameplay, accepted history, and LLM fallback are subsequent checkpoints.

## Goal and implementation principle

Build the smallest Chrome extension that can play Puffer Party in a normal, uninterrupted browser session. Its answer source order is:

1. Predetermined local database seeded from the user's historical Daily archive.
2. Locally saved prior game-confirmed answers for this exact question/mode.
3. Persistent, unverified LLM candidate batches.
4. A new LLM request only when no usable local candidate remains.

Prepare candidates as soon as the category appears, including during other players' turns. When it is our turn, submit an available answer immediately. Reliable acceptance and speed take priority over hunting for a rarer answer.

Deliver this core loop before investing in reconnects, recovery, advanced matching, infrastructure, or a polished UI. Later features listed below are explicitly not MVP requirements.

## Primary seed source

Use the user-provided [Krillion Answer Archive](https://www.linkedinpinpointanswer.today/krillion-answers/archive) as the initial database source.

Inspection during specification work confirmed:

- The archive lists dated dives, prompt counts, and daily-page links.
- It is paginated; an importer must follow subsequent archive pages rather than only reading the first page.
- The [October 27 sample](https://www.linkedinpinpointanswer.today/krillion-answers/2026-10-27) exposes seven prompts and tiered answer lists, with point values.

The archive describes its covered dates; we have not audited whether it contains every historical day or every accepted answer. This does not block using it as the starting dataset. The newest daily-page fetch failed during this spot check; an eventual import should report failed days instead of silently treating them as empty.

### One-time dataset preparation and incremental updates

1. Follow the archive pagination and collect unique daily-page links.
2. Read each daily page and extract the exact prompt, answer text, rarity tier, points when present, date, dive number, and source URL.
3. Capture aliases only if explicitly available. Do not infer them from similar spellings.
4. Remove surrounding explanation/UI text from answer strings, especially gem descriptions.
5. Group exact normalized prompts for lookup. Deduplicate identical answers while retaining dated source/score observations; points can differ between snapshots.
6. Write a local seed JSON artifact plus a short report of imported days, unique prompts, answer rows, failures, and missing fields. Preserve failed links for a manual rerun.
7. Bundle the artifact with the extension and build a prompt-to-answers lookup in memory. Add an offline index only if actual load/lookup measurements justify it.

Use the archive before play; no archive requests belong in the turn-critical path. Scheduled refresh, general-purpose import UI, transactional dataset swapping, and a continuous ingestion service are later work.

Create the seed database once and retain it as a bundled project artifact. Setup, dependency installation, builds, and gameplay must not regenerate it. An explicit update checks the archive listing and fetches only dates not yet imported, appending new daily questions and answers while preserving old records. Previously failed dates may be retried. A no-op update leaves the seed file unchanged; keep a separate report of coverage and failures. Data collection is part of development/update tooling, not each user's setup.

Daily-derived answers are usable seed candidates for an exact matching Party prompt in the MVP. Keep their Daily provenance and treat acceptance in Party as something learned from actual results. Do not require prior Party confirmation for every archive answer before trying it; that would prevent bootstrapping. Preserve prompt qualifiers and stop trying a candidate after a current-category rejection.

## MVP behavior

The user opens Krillion, joins a Puffer Party room, and enables the extension for that tab. The MVP does not create rooms or matchmake.

The extension must:

- Detect the current category, our turn, answer-input readiness, and accepted/rejected results.
- Read visible answers already used by the room and exclude them for this category instance.
- Look up exact normalized prompt matches in the seed database.
- Fall through to accepted history when seed candidates are missing, used, or rejected.
- Ask one LLM for a small batch of answers when both local sources are exhausted.
- Fill and submit through the game's existing input/form.
- Save answers actually accepted by the game, including observable answers from other players when they can be attributed to the category.
- Offer a simple Enable/Stop control and a compact status showing selected answer, source, and latest result.

A popup for configuration plus a small in-page status/control is sufficient. A side panel, full candidate browser, suggestion-only mode, analytics dashboard, and elaborate evidence badges are not required.

## Core loop

```text
Category appears
  -> normalize prompt without removing its constraints
  -> collect unused seed candidates
  -> if exhausted, consult accepted history
  -> if exhausted, request LLM candidates
  -> keep the next few candidates ready

Other player answers
  -> update current-category used set
  -> discard used candidate and known aliases
  -> refill using the same source order

Our turn + input enabled
  -> recheck category, turn, and used set
  -> submit the next candidate
  -> wait for a visible result
  -> accepted: record it and wait for the next turn
  -> explicitly rejected: exclude it and try the next answer if still allowed
```

Keep up to 10 candidates ready where available. Never delay a ready local answer for a remote alternative. Use one source tier at a time; exhausted seed answers must not prevent the history/LLM fallthrough.

### Essential correctness for the first version

These are part of making the basic loop work, not a general recovery system:

- Submit only when it is our turn and the answer input is ready.
- Allow only one submission in flight so repeated DOM changes cannot submit twice.
- Use a simple category/turn generation token to discard late LLM results for an old state.
- Track all players' used answers, not just our own. Reset that used set when a new category instance starts, even if its text repeats later.
- Exclude known aliases when provided by the seed data or canonical game result.
- On explicit invalid/duplicate results, try the next candidate only if the UI still permits it. A duplicate is used-answer evidence, not proof that the answer is invalid.
- If a submit result is unclear, or the page disconnects/reloads, stop and let the user re-enable. Automatic resynchronization comes later.
- Stop prevents new submissions immediately.

Do not assume a particular fuse or turn duration. Resolve promptly rather than estimating an unseen deadline. Verify the minimum selectors/events and form behavior needed for the core loop while building it; a comprehensive protocol/reconnect investigation is not a prerequisite.

## Matching, ranking, and learning

Normalize Unicode, whitespace, and case for prompt matching. Preserve numbers, negation, starting-letter conditions, dates, and other qualifiers. Use exact normalized matches initially. Fuzzy matching, embeddings, and automatic equivalence between differently worded prompts are later features; unmatched prompts can fall through to history or the LLM.

Within a source, prefer an exact spelling observed accepted in Party, then a higher archived score where comparable, then a shorter answer as a tie-breaker. Archived Daily scores are ranking hints, not guaranteed Party scores. Unknown scores stay unknown.

History affects exclusions even when choosing from Seed: do not keep submitting a seed answer that the current category has already rejected. Rejections need only remain in the current category's memory for the MVP; permanent negative-evidence scoring is deferred.

An LLM suggestion is not an accepted-history entry. Promote it only after a confirmed game acceptance. Persist positive history across browser sessions using extension-owned storage. A timeout, turn change, or network failure is not evidence that an answer is wrong.

The official [Krillion FAQ](https://krillion.io/faq) explains that answer sets are curated and fair answers can be absent. Therefore a plausible factual answer may still fail; observe the game's result.

## Minimal data model

| Record | MVP fields |
| --- | --- |
| Seed prompt | Raw text, normalized key, array of answers |
| Seed answer | Submission text, aliases if available, dated score/tier observations, source URL, source mode = Daily |
| Accepted history | Prompt key, successful answer text, canonical answer/aliases if returned, mode, last accepted time |
| Active category | Local generation, prompt key, current turn, used/rejected answer sets, prepared queue, pending submission |
| Settings | Enabled tab, provider endpoint/model, request timeout, provider credential configuration |

Load bundled seed JSON into an in-memory map once when enabling the bot. Save modest positive history and settings using chrome.storage.local. If measured corpus/history size requires IndexedDB or indexed shards, add that as a concrete storage optimization, not as a separate database platform. A content script must not use the site's localStorage as extension storage.

## Minimal architecture

Use TypeScript and a Manifest V3 extension with three small pieces:

1. **Content script:** observe the page, hold the active category and prepared queue, perform the local resolution loop, submit, and report outcomes. This keeps the prepared-answer path independent of worker/network latency.
2. **Service worker:** load/send bundled data, persist accepted history/settings, and make external-provider requests. Use request/response messages; the MVP can stop on an interrupted request instead of implementing durable jobs.
3. **Popup and compact in-page control:** enable/stop and provider settings, plus current status.

Use storage permission and only the host permissions needed for Krillion and the chosen provider. Package executable code with the extension. Keep provider credentials in extension contexts, never the game page, content-script messages, or bundled source. For a personal prototype, a user-provided credential held in extension session storage is sufficient if the provider supports direct extension requests; it is not a secure vault and must not be written into logs. Use a minimal local proxy only if the selected provider requires it. A hosted backend, authentication service, multi-provider abstraction framework, and shared database are not needed for this MVP.

Chrome's documentation describes [content-script isolation](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests), and [extension storage](https://developer.chrome.com/docs/extensions/reference/api/storage).

## LLM fallback in the MVP

Use small API adapters with configurable provider endpoint/model, starting with OpenAI Responses and compatible Chat Completions. Game logic and caching stay independent. Send the exact prompt, explicit constraints, and currently excluded answers. Ask for about 20 candidate strings in JSON, mixing reliable familiar answers with a few plausible obscure answers. Per the user's latest instruction, request text only: no type metadata, obscurity fields, tiers, scores or probabilities. The default output cap is 400 tokens.

- Deduplicate simultaneous requests by cache key. Request another batch only if seed, confirmed history and cached suggestions are exhausted; cap new batches at two per category instance.
- Use a configurable initial attempt timeout (5 seconds), maximum attempts (3), and total retry budget (15 seconds). Timeouts grow on retries, capped by the remaining budget and 15 seconds per attempt. Backoff starts at 250 ms with jitter and honors `Retry-After`.
- Validate output shape, reject empty/oversized strings, deduplicate, check simple explicit constraints, and remove used answers again when the response arrives.
- Discard stale responses and cancel abandoned lookups/backoff. Retry transient transport, timeout, rate-limit and server failures within the budget. Do not automatically retry bad credentials/settings, billing limits, malformed/incomplete output, or completed-but-empty batches. Preserve the cause and attempt details in diagnostics. At most two lookup chains per active category and 100 HTTP attempts per browser session; local answers bypass provider holds. This remains an in-extension retry loop, with no hosted retry service.
- Persist the entire batch separately from confirmed history. Use exact normalized question (constraints preserved), Party mode, provider/model/API format and prompt/schema version as identity; exclude the used-answer list from the key.
- Expire suggestions in 24 hours, or 1 hour for heuristically detected current-fact questions. Current-fact positive history also expires in 1 hour; stable-question history persists. Invalid evidence lasts 24 hours and is separate from duplicate responses.
- Promote answers only after actual acceptance. Exclude used/rejected candidates at selection, including after an asynchronous response. Expose answer source, counts, cache hits, requests, and safe errors without keys.

Google/web search remains an optional next provider. One working LLM path satisfies the requested external fallback for the MVP; search is not required before the bot can play.

## Performance target

The key optimization is doing work before our turn and keeping ready candidates in memory. Target p95 under 150 ms from detecting our enabled turn to invoking submit with a prepared answer. Measure this during implementation; it is not a guarantee. Track local action timing separately from the game's acknowledgement latency.

Do not build a performance dashboard, establish strict cold-start SLAs, or optimize every path before demonstrating the basic loop. Use simple local logs to identify actual bottlenecks.

## MVP implementation order and review checkpoints

1. Inspect a representative daily page and implement the one-time archive-to-seed conversion. Report real coverage; do not promise completeness from the index alone.
2. Implement and demonstrate the core local-database loop in one uninterrupted Party session, including excluding used answers and submitting on our turn.
3. Per updated user direction, combine structured text-only LLM fallback, persistent generated-batch caching, and game-confirmed history in the next checkpoint.
4. Verify generation, cache reuse/persistence, acceptance learning, invalid-vs-duplicate behavior and stale-result protection with a deterministic mock and simple user-run live instructions.
5. Verify the complete MVP through the checklist below before adding resilience work.

Pause after each implemented and verified checkpoint. The user-requested 0.3.1 follow-up adds bounded provider retries and stable input preparation. Wait briefly for the controlled input and Send handler to render; recheck current category, turn, manual edits and used answers before clicking. Abandoned bot text is cleared, preparation retries are bounded to three per turn, and manual edits are retained. Google search, related-category matching, deliberate gameplay delays and connection recovery remain deferred. Setup/live verification is documented in LLM_TESTING.md.

### MVP done means

- An unpacked extension can be loaded, enabled, and stopped.
- The archive is converted into a locally usable seed dataset with source links and an import report.
- A matching unused seed answer is selected and submitted on our turn.
- Used/rejected seed answers fall through to accepted history, then the LLM when needed.
- Accepted answers are saved and can be reused in a later session/category instance.
- It does not reuse visible used answers or known aliases, double-submit on repeated page events, or submit stale provider output for an old category/turn.
- Basic unknown-category, rejection, timeout, and exhausted-answer paths have a visible outcome without hanging the control.
- The core loop is demonstrated against the live game. Small fixture checks cover source precedence and stale-result/duplicate-submission logic; a large end-to-end resilience suite is unnecessary at this stage.

## After the MVP

Only after the core loop works, consider:

- Automatic reconnect and resynchronization of room-wide used answers.
- Reload recovery, worker-restart recovery, persistent in-flight jobs, and acknowledgement reconciliation.
- Search/Google integration and additional LLM providers.
- Fuzzy prompt matching or embeddings, guided by real misses.
- Rich alias reconciliation and permanent, version-aware rejection/conflict history.
- Scheduled archive refreshes, general import/export tooling, and dataset migrations.
- Full side panel, candidate browser, analytics, budgets dashboard, and polished configuration.
- Shared or hosted services, multi-tab coordination, and store publication.

Implementation status and reproduction steps are tracked in README.md. Reconnects and other deferred features must not delay the core MVP checkpoints.
