import type { LyricsProvider, LyricsQuery, LyricsResult } from '../types/types';
import { isValidResult } from '../types/types';
import { createBiniLyricsProvider } from './providers/binilyrics';
import { createLrclibProvider } from './providers/lrclib';
import { createBetterLyricsProvider } from './providers/betterlyrics';

export async function fetchLyricsChain(
  query: LyricsQuery,
  providers: LyricsProvider[],
  signal?: AbortSignal,
): Promise<LyricsResult | null> {
  for (const provider of providers) {
    if (signal?.aborted) return null;
    try {
      const result = await provider.fetch(query, signal);
      if (signal?.aborted) return null;
      if (isValidResult(result) && result.source === provider.id) return result;
    } catch {
      continue;
    }
  }
  return null;
}

export function createDefaultChain(): LyricsProvider[] {
  return [createBetterLyricsProvider(), createBiniLyricsProvider(), createLrclibProvider()];
}

export async function fetchLyrics(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsResult | null> {
  return fetchLyricsChain(query, createDefaultChain(), signal);
}
