import type { LyricsProvider, LyricsQuery, LyricsResult } from '../types/types';
import { isValidResult } from '../types/types';
import { createBiniLyricsProvider } from './providers/binilyrics';
import { createLrclibProvider } from './providers/lrclib';
import { createSpotifyLyricsProvider } from './providers/spotify';
import { defaultCache } from '../storage/cache';
import { cleanTitle, getPrimaryArtist, createCleanQuery } from './cleaner';

export { cleanTitle, getPrimaryArtist, createCleanQuery };

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
  return [createBiniLyricsProvider(), createLrclibProvider(), createSpotifyLyricsProvider()];
}

export async function fetchLyrics(
  query: LyricsQuery,
  signal?: AbortSignal,
  cache = defaultCache,
): Promise<LyricsResult | null> {
  const cleanQ = createCleanQuery(query);
  const providers = createDefaultChain();
  const readCache = async (candidate: LyricsQuery) => {
    const entry = await cache.get(candidate);
    if (entry.result && !providers.some(provider => provider.id === entry.result!.source)) {
      return { hit: false, result: null };
    }
    return entry;
  };

  if (!query.skipCache && cache) {
    const cached = await readCache(query);
    if (cached.hit) {
      if (cached.result) return { ...cached.result, cached: true };
      if (cleanQ) {
        const cleanCached = await readCache(cleanQ);
        if (cleanCached.hit) {
          return cleanCached.result ? { ...cleanCached.result, cached: true } : null;
        }
      } else {
        return null;
      }
    } else if (cleanQ) {
      const cleanCached = await readCache(cleanQ);
      if (cleanCached.hit && cleanCached.result) {
        return { ...cleanCached.result, cached: true };
      }
    }
  }

  let result = await fetchLyricsChain(query, providers, signal);
  if (signal?.aborted) return null;

  if (!result && cleanQ) {
    result = await fetchLyricsChain(cleanQ, providers, signal);
    if (signal?.aborted) return null;
  }

  if (cache) {
    await cache.set(query, result);
    if (cleanQ) {
      await cache.set(cleanQ, result);
    }
  }

  return result;
}
