import type { LyricsProvider, LyricsQuery, LyricsResult } from '../types/types';
import { isValidResult } from '../types/types';
import { createBiniLyricsProvider } from './providers/binilyrics';
import { createLrclibProvider } from './providers/lrclib';
import { createBetterLyricsProvider } from './providers/betterlyrics';

import { defaultCache } from '../storage/cache';

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

export async function fetchLyrics(
  query: LyricsQuery,
  signal?: AbortSignal,
  cache = defaultCache,
): Promise<LyricsResult | null> {
  if (!query.skipCache && cache) {
    const cached = await cache.get(query);
    if (cached.hit) {
      if (cached.result === null) {
        return null;
      }
      return { ...cached.result, cached: true };
    }
  }

  const result = await fetchLyricsChain(query, createDefaultChain(), signal);
  if (signal?.aborted) return null;

  if (cache) {
    await cache.set(query, result);
  }

  return result;
}
