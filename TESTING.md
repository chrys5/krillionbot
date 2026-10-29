# Test checkpoint 2 yourself

## Auto-join

Reload the extension and refresh Krillion after updating. In the popup, turn on **Automatically join and keep playing**; this toggle saves immediately, independently of provider settings. It starts off on a new install.

Open the Puffer Party mode you want. Auto-join uses visible Join/Quick play/Find match/Play controls, then Play again, New opponent, Rematch, or Wake puffer when available. It stays in the mode exposed by the game; it does not choose a mode from menu cards. It waits one second for a stable control and at least three seconds between clicks. Hidden and disabled controls are ignored, and replay/join controls are ignored during an active answer round.

**Stop** pauses auto-join in the current tab; **Enable** resumes the saved setting and enables the answer bot. Turning the toggle off disables auto-join. The toggle persists across page reloads; answer submission still requires Enable after a full page reload. With auto-join on, an already-enabled answer bot resumes after a game connection is replaced and a fresh game state arrives.

Local tests cover mocked join/replay/wake transitions, duplicate prevention, hidden/disabled controls, setting persistence, and the production content script's Stop/Enable behavior. Live button labels still need verification in Chrome.

Updated extension: the user confirmed seed gameplay works. For the new LLM/cache checkpoint, use [LLM_TESTING.md](LLM_TESTING.md). The steps below remain useful for base game controls.

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

Version 0.3.1 adds **Mock fault**, an attempt log, **Send render delay**, and **Keep Send unavailable**. Reproduction steps for retries, cancellation, and input cleanup are in [LLM_TESTING.md](LLM_TESTING.md). All helper acceptance is simulated.

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

Seed gameplay is user-confirmed. LLM fallback, cached suggestions and confirmed history are now implemented; configure/test them using LLM_TESTING.md. Automatic reconnect and reload recovery remain deferred.

Seed-based automatic submission has been verified by the user. LLM-generated answers require separate live acceptance checks. The extension uses normal DOM events and does not alter the game's input telemetry.

## If something fails

- **No panel:** check that the extension is enabled and refresh Krillion after loading/reloading it.
- **Waiting for a live category forever:** refresh Krillion once, join normally, and re-enable. The observer must load before the game's connection. This version reads the live WebSocket transport at `party.krillion.io`; a transport change/fallback may require an adapter update.
- **Ready but no submission:** ensure it is your turn and the input is empty. The bot preserves manually entered text.
- **No seed question match / Seed answers exhausted:** the bot next checks history/cache/LLM. Copy diagnostics for source/candidate/request counts. Check matching with `npm run lookup -- "exact prompt"`.
- **Three attempts this turn:** automatic retries are capped at three; you can still enter an answer manually.
- **Preparing answer; waiting for the Send button:** the controller is allowing the game's controlled input to render. It rechecks category, turn, used answers and manual edits before clicking. If Send stays unavailable for 1 second, it removes its own abandoned text and retries, up to three preparations per turn. It stays enabled and resumes on the next turn; manual edits are preserved.
- **Connection/state interrupted, incomplete used list, or no result:** stop, refresh, and enable again. Recovery is deferred.
- **Errors:** check the extension's **Errors** button at `chrome://extensions`, the service worker's **Inspect** link, or the Krillion tab's DevTools Console.
- **Message exceeded maximum allowed size of 64MiB:** rebuild, reload the extension card, and refresh every open Krillion tab. Confirm copied diagnostics show **0.3.2**. This version loads local answers per question and sends only a small index and candidate batches through extension messages.

Click **Copy diagnostics** in the in-page bot panel and paste the result back here with what you expected to happen. It includes the bot status, category, phase, and input placeholder; it excludes account credentials, chat, player lists, and socket URLs.

After a code update: run `npm run build:extension`, click **Reload** on the extension card, and refresh Krillion. Avoid Remove/reinstall for ordinary development updates.

After upgrading from the old stuck-input bug, clear any text left by that old version once before enabling. The new controller cannot safely claim ownership of text that predates it. Extension reload clears the session API key; re-enter it in the popup if another LLM request is needed. Confirm diagnostics show version **0.3.2**.

Report back with:

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
