# Krillion Bot

A local-first Chrome extension that plays [Krillion's Puffer Party](https://krillion.io/party). It prepares answers as soon as a question appears, filters out used or rejected answers, and submits through the game's existing input when it is your turn.

Answers come from a local answer bank, previously accepted answers, cached suggestions, and an optional LLM fallback. Settings, answer history, and diagnostics stay in extension storage; enabling LLM fallback sends questions and answer context to your configured provider.

## Get started

Requires **Node.js 20+**, npm, and **Chrome 111+**.

```sh
npm ci
```

The extension needs a local answer bank at `data/seed.json`. The `data/` directory is excluded from Git. If you already have a seed database, place it there; otherwise, create one from the [Daily answer archive](https://www.linkedinpinpointanswer.today/krillion-answers/archive):

```sh
npm run seed:update
```

The first import fetches the available Daily archive; later runs fetch only missing dates. Data imports are explicit: installing dependencies, building, testing, and playing do not refresh the bank.

Build the extension:

```sh
npm run build:extension
```

1. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
2. Choose **Load unpacked** and select this checkout's `build/extension` folder.
3. Open or refresh [Puffer Party](https://krillion.io/party), join a room, and click **Enable** in the Krillion Bot panel.
4. Click **Stop** to pause the bot. After reloading a tab, click **Enable** again.

The bot works with local answers without an API key. To enable new LLM suggestions, open the extension's toolbar popup and configure a provider, model, and API key. It supports Responses and compatible Chat Completions APIs; see the [provider setup guide](docs/llm.md#configure-your-provider). Keys are held in extension session storage and must be re-entered after a browser restart. Generated suggestions become confirmed history only after the game accepts them.

The popup also offers optional **Automatically join and keep playing**, automatic recovery for stalled submissions, and diagnostic log export. Auto-join operates inside a room you have opened. See the [usage and troubleshooting guide](docs/testing.md) for details. After rebuilding, reload the extension in Chrome and refresh Krillion.

## Architecture

The project is a TypeScript Chrome Manifest V3 extension with Node.js tools for data preparation and testing. Gameplay runs in the browser.

- **Page bridge** observes game WebSocket traffic and relays relevant state and results to the content script.
- **Content script and controller** track the question, turn, and used answers, prepare a queue, and recheck state before submitting through the game's input and Send button. Manual edits are preserved, and stale work is discarded.
- **Background worker** resolves answers in order: **seed → confirmed history → cached suggestions → new LLM batch**. It owns provider requests, credentials, and persistent storage. The build splits the seed into a question index and per-question files, so answers load on demand.
- **Popup and in-page panel** provide configuration, controls, status, and diagnostics.

Question matching normalizes Unicode, case, and whitespace while preserving punctuation and restrictions. Unknown or exhausted questions fall through to the next answer source. Archived scores guide ranking; live game results determine acceptance.

See the [architecture guide](docs/architecture.md) for file responsibilities and the [gameplay controller](src/extension/controller.ts) for the core loop.

## Development

```sh
npm ci
npm test
```

`npm test` compiles TypeScript into `dist/` and runs offline tests using fixtures and mocked game/provider responses. It does not require a seed database or API key.

With `data/seed.json` available, run the browser simulation:

```sh
npm run test:browser
```

Open [the local helper](http://127.0.0.1:4173/krillionbot-test/party/TEST) and click **Run checks**. It uses the production browser scripts with simulated game and provider responses. Stop the server with **Ctrl+C**.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and focused checks. Useful entry points:

| Area | Code / guide |
| --- | --- |
| Browser integration and submission | [Content script](src/extension/content.ts), [controller](src/extension/controller.ts), [DOM adapter](src/extension/adapter.ts) |
| Answer lookup and matching | [Seed resolver](src/resolver/seed-lookup.ts), [answer matching](src/data/answer-matching.ts) |
| LLM fallback and learning | [Provider adapter](src/llm/provider.ts), [cache/history](src/llm/cache.ts), [LLM testing](docs/llm.md) |
| Packaging | [Build script](scripts/build-extension.ts), [manifest](extension-assets/manifest.json) |
| Browser checks and troubleshooting | [Testing guide](docs/testing.md) |

## Answer bank tools

These commands maintain or inspect the local database independently of gameplay:

| Command | Purpose |
| --- | --- |
| `npm run seed:update` | Import missing Daily archive dates. |
| `npm run seed:packs` | Append available public themed-pack and Unlimited reveals; optionally select a mode with `-- --pack lexicon`. |
| `npm run seed:merge -- --input 'data/answers.json' --skip-companion` | Import a question-keyed JSON export without fetching companion pages. See the [merge implementation](src/data/merge.ts) for the accepted format. |
| `npm run seed:verify` | Check full-bank lookup coverage and used-answer filtering, and report local lookup timings. |
| `npm run lookup -- "Name a pasta dish"` | Inspect candidates; add repeated `--used` or `--rejected` flags to exclude answers. |

Importers preserve existing source snapshots and write reports under `data/`. No-op imports leave the seed unchanged. After updating the bank, rebuild and reload the extension to use it. The [data modules](src/data) and [architecture guide](docs/architecture.md) describe parsing, provenance, and source precedence.
