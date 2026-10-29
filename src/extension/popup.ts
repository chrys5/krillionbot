import type { BotStatus } from './controller.js';
import { validateSettings, type LlmSettings } from '../llm/provider.js';

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
const api = async (request: unknown) => {
  const response = await chrome.runtime.sendMessage(request);
  if (response?.error) throw new Error(response.error);
  return response;
};
const autoJoinStatus = document.querySelector<HTMLElement>('#auto-join-status')!;
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
