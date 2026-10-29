# Contributing

Start with the [README](README.md) for installation and usage, and the [architecture guide](docs/architecture.md) for runtime flow and source responsibilities.

## Local setup

Use Node.js 20+ and run commands from the repository root:

```sh
npm ci
npm test
```

Tests use fixtures and mocked Chrome, game, and provider APIs. They require neither a local answer bank nor an API key and make no real provider or game requests.

To build the extension or run the browser helper, first provide `data/seed.json` as described in the [setup guide](README.md#get-started).

## Development loop

1. Edit TypeScript under `src/`, `scripts/`, or `tests/`, or extension assets under `extension-assets/`.
2. Run the relevant checks below.
3. For browser changes, run `npm run build:extension`, reload the unpacked extension at `chrome://extensions`, and refresh Krillion.
4. Follow the [browser checks](docs/testing.md) for gameplay changes or the [LLM checks](docs/llm.md) for provider/cache changes.

Reloading the extension clears its session API key. Re-enter it in the popup before testing new provider requests.

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile and type-check source, scripts, and tests into `dist/`. |
| `npm test` | Compile and run the full offline test suite. |
| `npm run test:controller` | Run gameplay controller and protocol tests. |
| `npm run test:llm` | Run provider, cache/history, worker, and retry tests. |
| `npm run test:browser` | Build and serve the interactive browser simulation; requires the seed database. |

For one test file, run `npm run build`, then e.g. `node --test dist/tests/answer-matching.test.js`.

The browser helper runs at [127.0.0.1:4173](http://127.0.0.1:4173/krillionbot-test/party/TEST). Click **Run checks**; use its turn, rejection, and provider-fault controls to reproduce behavior. Its acceptance results are simulated. Real API calls and game acceptance require separate manual checks.

## Changes and reports

Keep changes focused and explain the resulting behavior and validation. Add regression coverage for behavior changes, especially turn/category transitions, answer exclusions, manual-input preservation, and provider failures. Keep executable browser code bundled with the extension and credentials in trusted extension contexts.

For bug reports, include reproduction steps, expected and actual behavior, extension version, and relevant test results. The [troubleshooting guide](docs/testing.md#if-something-fails) explains diagnostic capture and log export.

Generated output, local databases, import reports, environment files, personal notes, and credentials are excluded from Git. Run data imports explicitly, verify the resulting bank, then rebuild; setup and tests do not refresh data. See the [data tooling reference](docs/architecture.md#data-tools) for commands and formats.
