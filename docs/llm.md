# LLM configuration and testing

Configure an optional provider for questions without usable local answers. The extension supports Responses and compatible Chat Completions APIs.

## Answer resolution

Resolution order:

1. Exact matching seed answers.
2. Game-confirmed history for this exact question in Party mode.
3. Cached, unverified generated suggestions.
4. A new provider request only if no eligible local fallback remains.

Each request asks for up to 40 distinct candidate **strings**, aiming for 40 when reliable answers exist, with no generated types, rarity labels, scores, probabilities, or explanations. Validation retains at most 40 and deduplicates answer equivalents. The JSON shape is:

```json
{"candidates":["Gin","Rum","Vodka"]}
```

The adapter sends the exact question, simple parsed constraints and excluded answers. Code validates shape, maximum length (60 characters), duplicates, and recognized prefix/suffix, quoted-substring, word-length and letter-bank constraints. It cannot establish factual correctness or game acceptance. Actual game feedback does that.

The default output cap is 1,200 tokens. Saved limits are preserved; use **Maximum output tokens** to adjust the cap. Defaults are a **5-second initial attempt**, **up to 3 HTTP attempts per lookup**, and a **15-second total retry budget**. Use the popup's **Request limits** to change these settings. If a model spends its output budget on reasoning, use a faster text model or explicitly raise the cap. Provider capabilities and access must be checked against your account.

The prompt includes `excludedAnswers` (used, rejected, unconfirmed and recent invalid answers, expanded with known equivalents; up to 1,000 strings) and `previouslySuggestedAnswers` (unexpired cached suggestions and confirmed history, expanded with equivalents; up to 500 strings). The model is asked to avoid alternate names and spelling/plural variants and supply fresh alternatives. Shared requests still apply each caller's current exclusions locally when results arrive.

Answer matching handles accents/formatting plus a small category-specific set of country names, animal plurals, and vegetable equivalents. Source aliases are bidirectional and carry into fallback exclusions. Spelling/word/letter questions use strict spelling comparisons; symbols and numeric distinctions remain significant. This is deterministic matching, not general semantic or typo inference. Tests cover equivalent answers across seed/cache/history, used-answer changes during input preparation, repeat aliases, and second-batch prompt context.

## Retry policy

- Timeouts and connection failures, HTTP 408/409/429 and server errors can retry. Attempt deadlines double, constrained by the remaining total budget and a 15-second per-attempt cap. Thus an initial 2000 ms can grow to 4000 and 8000 ms when the budget permits.
- Backoff starts at 100 ms, doubles, and adds up to 25% jitter (100–125 ms before the second attempt, 200–250 ms before the third). After a transiently failed lookup, the next batch can retry after 250 ms. A provider's `Retry-After` is the minimum wait. Longer server delays are shown and scheduled outside the current lookup budget; they are also preserved across worker recreation within this browser session.
- Empty output and non-retryable failures have a 2.5-second local cooldown before another manual attempt (Test LLM / cache or Stop/Enable). These failures do not automatically retry; provider-required delays still take precedence.
- Authentication, request configuration, billing/quota, malformed JSON, incomplete output, and completed-but-empty output do **not** automatically retry. The precise failure remains visible, rather than conflating timeout with empty results. Saving corrected settings clears the local failure cooldown while respecting an outstanding server `Retry-After`.
- The active category can start at most **two lookup chains**, each with bounded attempts. Only retryable failures schedule another chain. Repeated page updates do not restart it. There are at most **100 HTTP attempts per browser session**, including retries; explicit Stop/Enable resets the category allowance but not the session cap.
- Simultaneous requests for the same cache key share a retry chain. Each caller can cancel; the provider is aborted when no callers remain. Stop/category changes cancel stale retries and prevent submission. Client cancellation/timeout cannot guarantee that the provider has stopped processing or billing an attempt.
- Cached candidates and confirmed history are checked before provider delays or new calls. Retry settings do not change the generated-answer cache identity.

## Deterministic tests: no key or paid calls

```powershell
npm run test:llm
npm run test:controller
npm test
npm run test:browser
```

For the browser helper, open `http://127.0.0.1:4173/krillionbot-test/party/TEST` and click **Run checks**. In addition to the seed tests, expect checks for:

- An unseeded spirits question getting a structured text batch from the mock provider.
- The same question reusing that batch with the mock call count staying at one.
- Simulated acceptance promoting an answer into confirmed history.
- Delayed Send rendering while the controller retains a single pending preparation.
- Timeout, 429, 503 and network recovery; bad key, malformed JSON, empty output and repeated-timeout failures with bounded attempts.

These are **simulated** provider responses and game acceptances. The production provider adapter, cache and browser scripts are used, but the helper makes no requests to a real LLM or Krillion. Manual controls include a question selector, rejection feedback and a Mock LLM switch; controls are disabled until setup finishes and during the automated sequence. Manual submission is checked against the helper's seed/mock lists, so arbitrary text is not automatically accepted. That simulated validation is not the real game's validator.

To try manual mock generation: choose **Unseeded spirits question**, turn **Mock LLM** on, click **Enable**, and leave it on the other player's turn until the bot is ready. Use **Your turn** to simulate submission. Reset the same question to observe history/cache reuse. The helper uses its own localStorage namespace; it does not access the actual extension's history or API key. The automated sequence clears only its disposable check namespace; the manual namespace persists across page reloads.

Node tests also exercise a restarted worker with retained local storage and a cleared session key, cache expiry, simultaneous request deduplication, question/model/provider separation, acceptance learning, scoped invalid evidence, duplicate handling, errors and stale-response protection.

### Fault scenarios

1. Click **Unseeded spirits question**, switch **Mock LLM** on, and choose **First attempt times out** under **Mock fault**.
2. Click **Reset mock cache/history and failures**, then **Enable**. Expect attempt 1 to time out, attempt 2 to succeed, and the attempt log to explain the retry. Resetting the question again should use the cached batch without another call.
3. Repeat with **429 once**, **503 once**, **Connection failure once**, **401 bad key**, **Malformed JSON**, **Empty candidates**, or **Every attempt times out**. Reset mock data before each scenario so a cache hit does not hide it. All calls and acceptance here are simulated.
4. For Send readiness, select the pasta question, set **Send render delay** to `200`, reset the question, Enable and choose **Your turn**. Expect one submission after the short render delay, without stopping.
5. Check **Keep Send unavailable** and start a fresh turn. The bot waits up to 1 second per preparation, clears abandoned bot text and retries after 250 ms. After 3 failed preparations it remains enabled, leaves the field empty and waits for the next turn or manual entry. Uncheck it, use **Other player's turn**, then **Your turn**: submission should resume.
6. During a delayed preparation, edit the input or press **Stop**. Manual edits must remain; abandoned bot text must be removed. Changing turns must prevent the old click.

These controls use a 3-second total mock LLM budget and a 300 ms initial mock timeout by default, to keep local drills quick. They do not change your real extension settings.

## Build and reload the extension

```powershell
npm run build:extension
```

Reload the existing unpacked extension at `chrome://extensions`, then refresh Krillion. Select the extension folder inside your local repository checkout:

`build/extension`

The extension requests storage and OpenAI API host access. Other HTTPS API hosts are requested only when you save that host in the popup. Do not remove/reinstall for routine updates: removal clears extension storage.

## Configure your provider

Open the extension's toolbar popup:

1. Set **API base URL** to `https://api.openai.com/v1` for OpenAI.
2. Choose **Responses** and **Strict JSON Schema** for the initial OpenAI path.
3. Enter a fast text **model ID available to your API account**. The model is deliberately not hard-coded.
4. Paste your key into **API key — this browser session only**. Do not paste it into chat or game controls.
5. Check **Allow new LLM requests**, then click **Save settings**.

For another compatible provider, change base URL, model and API format. Chat Completions supports strict schema, JSON-object mode, or prompted JSON. The token-limit field can be switched between `max_completion_tokens` and `max_tokens`. Capabilities vary: a proprietary API or different authentication scheme needs another small adapter; this is not universal API compatibility. HTTPS endpoints only. No model-specific extra fields or tools are automatically added.

The key is held in `chrome.storage.session`, confined to trusted extension contexts and bound to the chosen host. It is cleared when Chrome restarts or the extension is reloaded/updated/disabled. Model/settings, cached batches and history use `chrome.storage.local`. Keys never go to the content script, game page, source, cache keys or diagnostics. The popup displays only whether a key is set.

## Verify a real API call and cache reuse

Leave the game bot stopped while doing this test:

1. In the popup, choose an exact question with no usable seed/history/cache candidates. The default spirits question may be seeded; a `seed` or `history` result correctly avoids the API.
2. Click **Test LLM / cache**. On a fresh unseeded question, expect a candidates list, source `llm` and the request count to increase. It increases once per HTTP attempt, including retries. This can incur API charges.
3. Click the same test again. Expect source `cache`, a larger cache-hit count, and **no increase in LLM request count**.
4. Close/reopen the popup and repeat. The cached batch should still be used.
5. Optionally restart Chrome, reopen the popup and repeat before entering a new key. A fresh cached batch should work without a key; a new API call requires re-entering it.

If the test uses `history` immediately, an answer was already confirmed for that question. Choose another genuinely unseeded question for the generation test. If every cached answer is used/rejected, expiry has elapsed, or you change model/provider/format, a new call can be appropriate.

**Clear suggestions** removes only generated caches. Confirmed history stays. Stop the bot and let pending requests finish before clearing; an already-running request can still save its result. **Forget key** removes the session credential.

## Verify real game acceptance and learning

1. Join a private Party room and Enable the bot normally.
2. On an unseeded question, expect **No seed question match. Checking history/cache/LLM…**, followed by a ready status showing the source. Preparation happens during opponents' turns.
3. On your turn, a candidate is submitted immediately, subject to the existing checks. Check whether the actual game accepts it and passes the puffer.
4. Actual accepted answers enter confirmed history. A factual miss is separate question/mode-scoped negative evidence; an already-used/duplicate response does not permanently invalidate an answer.
5. On a later instance of the exact question, expect history or cache before another API call. Used answers remain excluded for the current category instance.

The observer also learns visible canonical answers from actual pass events while the bot is enabled. That means another player's accepted answer can become useful history in a later game. Merely generating or submitting a candidate does not confirm it.

## Cache policy and diagnostics

- Cache identity includes normalized question (constraints preserved), Party mode, API base/format, model, JSON/token format, and prompt/schema version. Current used answers are not part of the key.
- Entire batches persist, with at most 100 merged suggestions per generated cache entry.
- Generated suggestions expire after **24 hours**. A heuristic marks current-fact questions (current/today/latest/monthly listeners/subscribers/followers, etc.) for **1 hour** expiry. Confirmed history for those questions also expires after 1 hour; stable-question positive history persists until invalidated.
- Invalid evidence lasts **24 hours**, scoped to exact question and Party mode. Confirmed later acceptance can restore an answer. Duplicate responses are round exclusions only.
- One in-flight retry chain is shared per cache key. A stale result cannot submit for an old category. Another active caller can keep a shared request alive; otherwise Stop attempts to abort it.
- **Seed answers exhausted** and **No seed question match** are different messages. The panel shows queued count, answer source, total LLM request attempts and cache hits. `llm` means a new provider batch; `cache` suggestions remain unverified; `history` is game-confirmed evidence.
- **Copy diagnostics** includes recent status events, queue preview, counts, input preparation failures, current retry progress and the last lookup's attempt deadlines, elapsed times, failure kinds/statuses, retry delays and retry availability. Model/API format and token limits are included; response bodies and credentials are excluded.
- After correcting settings for a current miss, **Save settings**, then Stop/Enable to retry. Transient errors have bounded automatic retries. For repeated failures, diagnostics distinguish timeout, network, rate limit, authentication, invalid JSON, incomplete output and empty output.

Automated tests use deterministic mocks. Real provider availability, latency, and game acceptance require the live checks above.

Official API references used for the adapter: [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses), [API errors](https://developers.openai.com/api/docs/guides/error-codes), [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), and [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage).
