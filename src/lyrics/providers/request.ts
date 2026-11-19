// "Could not reach the server" is kept apart from "has no lyrics": the chain does not cache a
// weaker result while a provider was down, and the controller retries the track.
export class ProviderUnavailable extends Error {
  constructor(provider: string, reason: string) {
    super(`${provider} unreachable: ${reason}`);
    this.name = 'ProviderUnavailable';
  }
}

// A stop requested by the caller (the track changed) still rejects as an abort, which providers
// read as no result. A network error, the provider's own timeout, 429 and 5xx become ProviderUnavailable.
export async function fetchFrom(
  provider: string,
  url: string | URL,
  init: RequestInit,
  callerSignal?: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    throw new ProviderUnavailable(provider, error instanceof Error ? error.message : String(error));
  }
  if (response.status === 429 || response.status >= 500) {
    throw new ProviderUnavailable(provider, `HTTP ${response.status}`);
  }
  return response;
}

// For a provider's catch block. Its own deadline can also fire while the body is still downloading.
export function rethrowIfUnreachable(
  provider: string,
  error: unknown,
  deadline: AbortSignal,
  callerSignal?: AbortSignal,
): void {
  if (callerSignal?.aborted) return;
  if (error instanceof ProviderUnavailable) throw error;
  if (deadline.aborted) throw new ProviderUnavailable(provider, 'timed out');
}
