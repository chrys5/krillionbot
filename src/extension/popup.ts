import type { BotStatus } from './controller.js';
import { validateSettings, type LlmSettings } from '../llm/provider.js';
import { diagnosticError, diagnosticLevel, sendDiagnostic, VERSION } from './diagnostics.js';
import { extensionErrorMessage } from './messaging.js';

const label = document.querySelector<HTMLElement>('#status')!;
async function command(type: string) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
    const status: BotStatus = await chrome.tabs.sendMessage(tab.id, { type });
    label.textContent = status.message + (status.lastAnswer ? ` · Last answer: ${status.lastAnswer}` : '');
  } catch {
    label.textContent = 'Open Krillion Puffer Party and refresh its tab, then try again.';
  }
}
document.querySelector('#enable')!.addEventListener('click', () => { label.textContent = 'Loading local database…'; void command('KRILLIONBOT_ENABLE'); });
document.querySelector('#stop')!.addEventListener('click', () => { void command('KRILLIONBOT_STOP'); });
void command('KRILLIONBOT_STATUS');

const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;
const select = (id: string) => document.querySelector<HTMLSelectElement>(`#${id}`)!;
const providerStatus = document.querySelector<HTMLElement>('#provider-status')!;
const saveStatus = document.querySelector<HTMLElement>('#save-status')!;
for (const target of [label, providerStatus, saveStatus, document.querySelector('#auto-join-status')!, document.querySelector('#recovery-status')!]) {
  let previous = '';
  new MutationObserver(() => {
    const message = target.textContent ?? '';
    if (message === previous) return;
    previous = message;
    const level = diagnosticLevel(message);
    if (level) void sendDiagnostic({ level, event: 'popup.status', message: extensionErrorMessage(message),
      context: { operation: target.id, displayedMessage: message } }).catch(() => {
        document.querySelector('#logs-status')!.textContent = 'Diagnostic log could not be saved.';
      });
  }).observe(target, { childList: true, characterData: true, subtree: true });
}
const api = async (request: unknown) => {
  const response = await chrome.runtime.sendMessage(request);
  if (response?.error) throw new Error(response.error);
  return response;
};
const autoJoinStatus = document.querySelector<HTMLElement>('#auto-join-status')!;
const recoveryStatus = document.querySelector<HTMLElement>('#recovery-status')!;
void api({ type: 'KRILLIONBOT_RECOVERY_CONFIG' }).then(result => {
  input('auto-recovery').checked = result.enabled === true;
}).catch(() => { recoveryStatus.textContent = 'Could not load recovery settings.'; })
  .finally(() => { input('auto-recovery').disabled = false; });
input('auto-recovery').addEventListener('change', async () => {
  const checkbox = input('auto-recovery');
  checkbox.disabled = true;
  try {
    const result = await api({ type: 'KRILLIONBOT_SAVE_RECOVERY', enabled: checkbox.checked });
    if (result?.saved !== true) throw new Error('Recovery setting was not saved');
    recoveryStatus.textContent = result.enabled ? 'Automatic recovery on.' : 'Automatic recovery off.';
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'KRILLIONBOT_RECOVERY_CHANGED', enabled: result.enabled });
  } catch { recoveryStatus.textContent = 'Could not update recovery. Reopen the popup and refresh Krillion.'; }
  finally { checkbox.disabled = false; }
});
void api({ type: 'KRILLIONBOT_AUTO_JOIN_CONFIG' }).then(result => {
  input('auto-join').checked = result.enabled === true;
}).catch(() => { autoJoinStatus.textContent = 'Could not load auto-join settings.'; })
  .finally(() => { input('auto-join').disabled = false; });
input('auto-join').addEventListener('change', async () => {
  const checkbox = input('auto-join');
  checkbox.disabled = true;
  try {
    const result = await api({ type: 'KRILLIONBOT_SAVE_AUTO_JOIN', enabled: checkbox.checked });
    if (result?.saved !== true) throw new Error('Save failed');
    autoJoinStatus.textContent = result.enabled ? 'Auto-join on.' : 'Auto-join off.';
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'KRILLIONBOT_AUTO_JOIN_CHANGED', enabled: result.enabled });
  } catch { autoJoinStatus.textContent = 'Could not update auto-join in this tab. Reopen the popup and refresh Krillion.'; }
  finally { checkbox.disabled = false; }
});
function fillSettings(settings: LlmSettings, hasKey: boolean) {
  input('llm-enabled').checked = settings.enabled;
  input('base-url').value = settings.baseUrl; select('format').value = settings.format;
  input('model').value = settings.model; select('json-mode').value = settings.jsonMode;
  input('timeout').value = String(settings.timeoutMs); input('tokens').value = String(settings.maxOutputTokens);
  input('attempts').value = String(settings.maxAttempts); input('retry-budget').value = String(settings.retryBudgetMs);
  select('token-field').value = settings.chatTokenField;
  document.querySelector('#key-state')!.textContent = hasKey ? 'A key is set for this API host and browser session.' : 'No key set for this API host.';
}
void api({ type: 'KRILLIONBOT_CONFIG' }).then(result => {
  fillSettings(result.settings, result.hasKey);
  providerStatus.textContent = `${result.metrics.requests} LLM requests · ${result.metrics.cacheHits} cache hits`;
}).catch(() => { providerStatus.textContent = 'Could not load provider settings. Reload the extension.'; });

document.querySelector('#save')!.addEventListener('click', async () => {
  const button = document.querySelector<HTMLButtonElement>('#save')!;
  button.disabled = true;
  saveStatus.textContent = 'Saving settings…';
  try {
    const settings = validateSettings({
      enabled: input('llm-enabled').checked, baseUrl: input('base-url').value.trim(), format: select('format').value,
      model: input('model').value.trim(), jsonMode: select('json-mode').value,
      chatTokenField: select('token-field').value, timeoutMs: Number(input('timeout').value), maxOutputTokens: Number(input('tokens').value),
      maxAttempts: Number(input('attempts').value), retryBudgetMs: Number(input('retry-budget').value),
    });
    const apiKey = input('api-key').value;
    // Called directly from the user's click. Only the selected API host is granted.
    const granted = await chrome.permissions.request({ origins: [`${new URL(settings.baseUrl).origin}/*`] });
    if (!granted) throw new Error('API host access was not granted.');
    const result = await api({ type: 'KRILLIONBOT_SAVE_CONFIG', settings, apiKey });
    if (result?.saved !== true || typeof result.hasKey !== 'boolean' || (apiKey.trim() && !result.hasKey)) {
      throw new Error('Could not confirm the API key was saved. Reload the extension and try again.');
    }
    input('api-key').value = '';
    fillSettings(settings, result.hasKey);
    saveStatus.textContent = 'Settings saved.' + (settings.enabled && !settings.model ? ' Enter a model ID and save again before making LLM requests.' : '');
    providerStatus.textContent = 'Saved. Stop/Enable the bot to retry an existing miss.';
  } catch (error) { saveStatus.textContent = error instanceof Error ? error.message : 'Could not save settings'; }
  finally { button.disabled = false; }
});
document.querySelector('#forget-key')!.addEventListener('click', () => {
  void api({ type: 'KRILLIONBOT_FORGET_KEY' }).then(() => {
    input('api-key').value = ''; document.querySelector('#key-state')!.textContent = 'Key removed.';
  }).catch(() => { providerStatus.textContent = 'Could not remove the key'; });
});
document.querySelector('#clear-cache')!.addEventListener('click', () => {
  void api({ type: 'KRILLIONBOT_CLEAR_CACHE' }).then(() => {
    providerStatus.textContent = 'Generated suggestions cleared. Confirmed history is retained. Stop/Enable to reload.';
  }).catch(() => { providerStatus.textContent = 'Could not clear suggestions'; });
});
document.querySelector('#test-llm')!.addEventListener('click', async () => {
  const button = document.querySelector<HTMLButtonElement>('#test-llm')!;
  button.disabled = true; providerStatus.textContent = 'Checking persistent cache, then LLM if needed…';
  try {
    const result = await api({ type: 'KRILLIONBOT_TEST_LLM', prompt: input('test-question').value.trim(), excluded: [] });
    providerStatus.textContent = JSON.stringify({ message: result.message, source: result.candidates[0]?.source,
      candidates: result.candidates, llmRequests: result.requests, cacheHits: result.cacheHits,
      retryAt: result.retryAt, diagnostics: result.diagnostics }, null, 2);
  } catch (error) { providerStatus.textContent = error instanceof Error ? error.message : 'Test failed'; }
  finally { button.disabled = false; }
});

const logsStatus = document.querySelector<HTMLElement>('#logs-status')!;
const logsOutput = document.querySelector<HTMLElement>('#logs-output')!;
const readLogs = async () => {
  const result = await api({ type: 'KRILLIONBOT_GET_LOGS' });
  if (!Array.isArray(result?.entries)) throw new Error('Diagnostic logs unavailable');
  logsStatus.textContent = `${result.entries.length} saved entries. Newest entries appear last.`;
  return result.entries;
};
document.querySelector('#view-logs')!.addEventListener('click', () => {
  void readLogs().then(entries => { logsOutput.textContent = JSON.stringify(entries, null, 2); })
    .catch(() => { logsStatus.textContent = 'Could not load logs. Reload the extension and try again.'; });
});
document.querySelector('#export-logs')!.addEventListener('click', async () => {
  try {
    const entries = await readLogs();
    const blob = new Blob([JSON.stringify({ version: VERSION, exportedAt: new Date().toISOString(), entries }, null, 2)],
      { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `krillionbot-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logsStatus.textContent = `Exported ${entries.length} entries.`;
  } catch (error) {
    logsStatus.textContent = 'Could not export logs. Reload the extension and try again.';
    void sendDiagnostic({ level: 'error', event: 'logs.export', message: logsStatus.textContent,
      context: { error: diagnosticError(error) } }).catch(() => {});
  }
});
document.querySelector('#clear-logs')!.addEventListener('click', () => {
  void api({ type: 'KRILLIONBOT_CLEAR_LOGS' }).then(result => {
    if (result?.cleared !== true) throw new Error('Clear not confirmed');
    logsOutput.textContent = ''; logsStatus.textContent = 'Logs cleared.';
  }).catch(() => { logsStatus.textContent = 'Could not clear logs.'; });
});
window.addEventListener('error', event => {
  void sendDiagnostic({ level: 'error', event: 'popup.exception', message: 'Unhandled popup exception.',
    context: { error: diagnosticError(event.error), line: event.lineno, column: event.colno } }).catch(() => {});
});
window.addEventListener('unhandledrejection', event => {
  void sendDiagnostic({ level: 'error', event: 'popup.unhandled-rejection', message: 'Unhandled popup promise rejection.',
    context: { error: diagnosticError(event.reason) } }).catch(() => {});
});
