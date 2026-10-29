# Usage, testing, and troubleshooting

The on-page Krillion Bot panel can be moved by dragging its title bar. Its position is remembered in this browser for Krillion and kept inside the viewport on resize. You can also focus the title bar and use arrow keys (Shift for larger steps).

## Auto-join

Reload the extension and refresh Krillion after updating. In the popup, turn on **Automatically join and keep playing**; this toggle saves immediately, independently of provider settings. It starts off on a new install.

Open the Puffer Party room you want. Auto-join runs only inside a room at `/party/<room>`; it stays idle on the main `/party` page, including `/party/` and URLs with queries or fragments. Enter a room yourself first. Inside the room, auto-join uses visible Join/Join next game/Quick play/Find match/Play controls, then Play again, New opponent, Rematch, or Wake puffer when available. It stays in the mode exposed by the game; it does not choose a mode from menu cards. It waits one second for a stable control and at least three seconds between clicks. Returning from the main page starts a fresh one-second wait. Hidden and disabled controls are ignored, and replay/join controls are ignored during an active answer round.

**Stop** pauses auto-join in the current tab; **Enable** resumes the saved setting and enables the answer bot. Turning the toggle off disables auto-join. The toggle persists across page reloads; answer submission still requires Enable after a full page reload. With auto-join on, an already-enabled answer bot resumes after a game connection is replaced and a fresh game state arrives.

Rematch, Request rematch, and Accept rematch take precedence over New opponent and Find new opponent. After requesting a rematch, auto-join waits while a visible, enabled rematch control remains available; it does not switch opponents during that wait. New opponent becomes eligible when rematch is unavailable.

Local tests cover mocked join/replay/wake transitions, duplicate prevention, hidden/disabled controls, setting persistence, and the production content script's Stop/Enable behavior. Live button labels still need verification in Chrome.

## Automatic recovery and persistent logs

The popup's **Automatically recover stalled submissions** toggle saves immediately and defaults on. If Send receives no result within five seconds, the bot logs the circumstances, discards the pending submission, resets the same work state as Enable, and rechecks the category, turn, used answers and input before trying another eligible answer. It excludes unconfirmed answers for the current category without learning that they are invalid. Bot-owned abandoned input is cleared; manual edits are preserved. The existing three-submission limit per turn remains in force. At the limit the bot stays enabled and waits for another turn or category. If recovery is off, a timeout stops the bot until Enable is pressed.

Accepted-answer events or a changed turn can reconcile a missing acknowledgement without waiting five seconds. On a connection/state interruption, recovery waits for a complete observed game state before re-enabling, independently of auto-join. Stop always cancels recovery. Recovery does not refresh the page or force a socket reconnect; if the game never provides usable state or controls, manual intervention can still be necessary.

The popup's **Diagnostic logs** section has **View logs**, **Export JSON**, and **Clear logs**. History is kept in extension-local storage across tab reloads, worker restarts, and browser restarts. It retains up to 1,000 recent entries within a 1 MiB budget, dropping the oldest when full. Entries include timestamps, extension version, tab/frame when available, error or warning messages, submission/recovery actions, category and game version, turn, pending answer and elapsed time, used/unconfirmed/rejected answers, input/control readiness, recent bot events, and available provider attempt/failure diagnostics. Large contexts are bounded. API keys, authentication fields, chat, player data, URLs, and raw manual-input values are omitted or redacted. Logs stay local until you export and share them. If saving fails, the panel shows a logging warning; logging failure does not stop gameplay.

To reproduce locally, run the browser helper, enable the bot, select **Drop next submission (test five-second recovery)**, then choose **Your turn**. Expect a logged timeout and a different answer after five seconds. Inspect the attempt log. Real extension logs and export controls are tested in the popup; the helper's log is a simulation. In Chrome, reproduce the original stall, reopen the popup, export the JSON, and check `submission.recovery`, `bot.status`, and `provider.lookup` entries.

For provider configuration, cache behavior, and LLM fault scenarios, see the [LLM guide](llm.md).

Run commands from the root of your local `krillionbot` checkout in PowerShell. No publishing or Chrome developer account is needed.

## 1. Automated checks

```powershell
npm test
```

This compiles TypeScript, tests the data pipeline and bot controller, and exercises the production observer/content bundles in a simulated page. It does not contact Krillion or regenerate the seed database.

## 2. Try the local browser helper

```powershell
npm run test:browser
```

Open `http://127.0.0.1:4173/krillionbot-test/party/TEST` in Chrome and click **Run checks**. Expect **ALL LOCAL CHECKS PASSED**.

The helper loads the production browser scripts, substitutes a simulated game connection and extension messaging, and uses the retained seed database. You do not need to install the extension for this simulation. No answers or test messages are sent to Krillion.

It checks that the bot:

- Prepares an answer while it is someone else's turn.
- Submits on our turn and excludes an opponent's used answer.
- Avoids duplicate submissions on repeated state updates.
- Tries a different backup after an explicit rejection.
- Waits for delayed Send rendering and submits once.
- Stops when requested.
- Leaves an unknown category available for manual input.

Use the question selector and **Reset selected question** to start a fresh category instance. **Unseeded spirits question** and **Mock LLM** exercise generation/cache without a paid API. Controls wait for setup and are disabled during the checks. **Disconnect** stops the bot; refresh to start a new simulation. Stop the server with **Ctrl+C** when finished.

The helper includes **Mock fault**, an attempt log, **Send render delay**, and **Keep Send unavailable**. See the [LLM fault scenarios](llm.md#fault-scenarios) for retry, cancellation, and input-cleanup checks. All helper acceptance is simulated.

If port 4173 is occupied, stop the earlier helper server before starting another one.

## 3. Load the real Chrome extension

```powershell
npm run build:extension
```

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the `build/extension` folder inside your local repository checkout.
5. Open or refresh `https://krillion.io/party` **after loading the extension**. A small Krillion Bot control panel should appear.

The build partitions the existing database into a question index and local question files. It does not scrape the archive or modify `data/seed.json`. Enabling reads only the index; matching answers load in the background worker as categories appear. A browser popup is also available from the extension toolbar icon. The panel starts Off in each fresh tab; Enable applies only to that tab.

## 4. Verify a real game

Use a private room with a second player/browser session so you can control the pace. A different browser profile avoids reusing the same seat. Join and start the game normally.

1. Click **Enable** in the bot panel. Expect local database loading followed by a waiting/ready status.
2. On a category present in the database, confirm it waits while someone else holds the puffer.
3. On your turn, expect one answer to be entered and sent through the existing **Send answer** button.
4. Confirm the game accepts the answer and passes the puffer. Watch the panel's last-answer/submission count.
5. Have another player use a known answer before your next turn; confirm the bot chooses a different answer.
6. Click **Stop** while waiting for a turn. Confirm the next turn does not trigger a submission.
7. For unknown/exhausted categories, check the source/status and provider configuration; with LLM requests disabled and no usable cache/history, manual entry remains available.

Recovery can re-enable after a submission timeout or a restored complete game state. It does not force a reconnect or resume answer submission after a full page reload.

The extension uses normal DOM events. Real game acceptance must be checked separately from simulated acceptance in the local helper.

## If something fails

- **No panel:** check that the extension is enabled and refresh Krillion after loading/reloading it.
- **Waiting for a live category forever:** refresh Krillion once, join normally, and re-enable. The observer must load before the game's connection. This version reads the live WebSocket transport at `party.krillion.io`; a transport change/fallback may require an adapter update.
- **Ready but no submission:** ensure it is your turn and the input is empty. The bot preserves manually entered text.
- **No seed question match / Seed answers exhausted:** the bot next checks history/cache/LLM. Copy diagnostics for source/candidate/request counts. Check matching with `npm run lookup -- "exact prompt"`.
- **Three attempts this turn:** automatic retries are capped at three; you can still enter an answer manually.
- **Preparing answer; waiting for the Send button:** the controller is allowing the game's controlled input to render. It rechecks category, turn, used answers and manual edits before clicking. If Send stays unavailable for 1 second, it removes its own abandoned text and retries, up to three preparations per turn. It stays enabled and resumes on the next turn; manual edits are preserved.
- **No submission result:** with automatic recovery on, expect a logged reset and another eligible answer, capped at three submissions per turn. With recovery off, Enable retries manually. Export logs if it repeats.
- **Connection/state interrupted or incomplete used list:** the bot requires complete game state before submitting. After an interruption it can resume when complete state arrives; if none arrives, refresh and enable again. Export logs before refreshing when investigating.
- **Errors:** check the extension's **Errors** button at `chrome://extensions`, the service worker's **Inspect** link, or the Krillion tab's DevTools Console.
- **Message exceeded maximum allowed size of 64MiB:** rebuild, reload the extension card, and refresh every open Krillion tab. Confirm copied diagnostics show the version in `extension-assets/manifest.json`. The worker loads local answers per question and sends only a small index and candidate batches through extension messages.

When reporting a problem, include the expected behavior, reproduction steps, and output from **Copy diagnostics** in the in-page panel. It includes the bot status, category, phase, and input placeholder; it excludes account credentials, chat, player lists, and socket URLs.

After a code update: run `npm run build:extension`, click **Reload** on the extension card, and refresh Krillion. Avoid Remove/reinstall for ordinary development updates.

Clear any existing input before enabling; the bot preserves text it did not enter. Reloading the extension clears the session API key, so re-enter it in the popup before making new LLM requests.

Include these results in a bug report:

```text
Automated checks: pass/fail
Local browser helper: pass/fail
Extension loaded and panel visible: yes/no
Live category:
Submitted only on my turn: yes/no
Game accepted and passed the puffer: yes/no
Stop prevented further submissions: yes/no
Diagnostics if needed:
```
