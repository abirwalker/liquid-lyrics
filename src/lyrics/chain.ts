import type { LyricsProvider, LyricsQuery, LyricsResult } from '../types/types';
import { hasSyncedLyrics, isValidResult } from '../types/types';
import { createLyricsPlusProvider } from './providers/lyricsplus';
import { createBiniLyricsProvider } from './providers/binilyrics';
import { createAmllProvider } from './providers/amll';
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
  let staticFallback: LyricsResult | null = null;
  let instrumentalFallback: LyricsResult | null = null;
  for (const provider of providers) {
    if (signal?.aborted) return null;
    try {
      const result = await provider.fetch(query, signal);
      if (signal?.aborted) return null;
      if (!isValidResult(result) || result.source !== provider.id) continue;
      if (hasSyncedLyrics(result)) return result;
      if (result.instrumental) {
        instrumentalFallback ??= result;
        continue;
      }
      staticFallback ??= result;
    } catch {
      continue;
    }
  }
  return staticFallback ?? instrumentalFallback;
}

export function createDefaultChain(): LyricsProvider[] {
  return [createBiniLyricsProvider(), createLyricsPlusProvider(), createAmllProvider(), createLrclibProvider(), createSpotifyLyricsProvider()];
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

  let cachedFallback: LyricsResult | null = null;
  if (!query.skipCache && cache) {
    const cached = await readCache(query);
    if (cached.hit) {
      if (cached.result && hasSyncedLyrics(cached.result)) return { ...cached.result, cached: true };
      cachedFallback = cached.result;
      if (cleanQ) {
        const cleanCached = await readCache(cleanQ);
        if (cleanCached.hit && cleanCached.result && hasSyncedLyrics(cleanCached.result)) {
          return { ...cleanCached.result, cached: true };
        }
        cachedFallback ??= cleanCached.result;
      }
    } else if (cleanQ) {
      const cleanCached = await readCache(cleanQ);
      if (cleanCached.hit && cleanCached.result) {
        if (hasSyncedLyrics(cleanCached.result)) return { ...cleanCached.result, cached: true };
        cachedFallback = cleanCached.result;
      }
    }
  }

  let result = await fetchLyricsChain(query, providers, signal);
  if (signal?.aborted) return null;

  if ((!result || !hasSyncedLyrics(result)) && cleanQ) {
    const cleanResult = await fetchLyricsChain(cleanQ, providers, signal);
    if (signal?.aborted) return null;
    if (cleanResult && (!result || hasSyncedLyrics(cleanResult))) result = cleanResult;
  }

  if (cache) {
    if (result !== null) {
      await cache.set(query, result);
      if (cleanQ) await cache.set(cleanQ, result);
    }
  }

  return result ?? (cachedFallback ? { ...cachedFallback, cached: true } : null);
}
