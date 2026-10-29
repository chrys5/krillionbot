// Only expose known extension failures: arbitrary error text can contain provider credentials.
export function extensionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/extension context invalidated/i.test(message)) {
    return 'Extension was reloaded or updated. Refresh the Krillion tab, then enable the bot again.';
  }
  if (/message exceeded maximum allowed size/i.test(message)) {
    return 'Extension message is too large. Reload the updated extension, refresh the Krillion tab, then enable again.';
  }
  if (/receiving end does not exist|could not establish connection|message (?:port|channel).*closed|background did not respond/i.test(message)) {
    return 'Extension background is unavailable. Reload the extension, refresh the Krillion tab, then enable again.';
  }
  if (/quota|QUOTA_BYTES/i.test(message)) {
    return 'Extension storage is full. Clear generated suggestions in the popup, then Stop/Enable to retry.';
  }
  if (/access.*(?:denied|not allowed)|not allowed.*access/i.test(message)) {
    return 'Extension storage access was denied. Reload the extension and refresh the Krillion tab.';
  }
  return 'Extension request failed. Reload the extension and refresh the Krillion tab.';
}

export class ExtensionRequestError extends Error {
  constructor(error: unknown) { super(extensionErrorMessage(error)); }
}

export async function backgroundRequest(request: unknown): Promise<any> {
  try {
    const response = await chrome.runtime.sendMessage(request);
    if (!response) throw new Error('Background did not respond');
    if (response.error) throw new Error(response.error);
    return response;
  } catch (error) { throw new ExtensionRequestError(error); }
}

export const requestFailureMessage = (error: unknown): string =>
  error instanceof ExtensionRequestError ? error.message : extensionErrorMessage(error);
