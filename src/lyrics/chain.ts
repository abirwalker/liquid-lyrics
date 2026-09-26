import type { LyricsProvider, LyricsQuery, LyricsResult } from '../types/types';
import { isValidResult } from '../types/types';
import { createLyricsPlusProvider } from './providers/lyricsplus';
import { createBiniLyricsProvider } from './providers/binilyrics';
import { createAmllProvider } from './providers/amll';
import { createLrclibProvider } from './providers/lrclib';
import { createSpotifyLyricsProvider } from './providers/spotify';
import { defaultCache } from '../storage/cache';
import { cleanTitle, getPrimaryArtist, createCleanQuery } from './cleaner';

export { cleanTitle, getPrimaryArtist, createCleanQuery };

function lyricQuality(result: LyricsResult | null): number {
  if (!result) return -1;
  if (result.instrumental) return 0;
  if (result.lines.some(line => line.timing === 'word')) return 3;
  if (result.lines.some(line => line.timing === 'line')) return 2;
  return 1;
}

export async function fetchLyricsChain(
  query: LyricsQuery,
  providers: LyricsProvider[],
  signal?: AbortSignal,
): Promise<LyricsResult | null> {
  let best: LyricsResult | null = null;
  for (const provider of providers) {
    if (signal?.aborted) return null;
    try {
      const result = await provider.fetch(query, signal);
      if (signal?.aborted) return null;
      if (!isValidResult(result) || result.source !== provider.id) continue;
      if (lyricQuality(result) === 3) return result;
      if (lyricQuality(result) > lyricQuality(best)) best = result;
    } catch {
      continue;
    }
  }
  return best;
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
    for (const candidate of cleanQ ? [query, cleanQ] : [query]) {
      const cached = await readCache(candidate);
      if (!cached.hit || !cached.result) continue;
      if (lyricQuality(cached.result) === 3) return { ...cached.result, cached: true };
      if (lyricQuality(cached.result) > lyricQuality(cachedFallback)) cachedFallback = cached.result;
    }
    if (cachedFallback && lyricQuality(cachedFallback) === 2) return { ...cachedFallback, cached: true };
  }

  let result = await fetchLyricsChain(query, providers, signal);
  if (signal?.aborted) return null;

  if (lyricQuality(result) < 3 && cleanQ) {
    const cleanResult = await fetchLyricsChain(cleanQ, providers, signal);
    if (signal?.aborted) return null;
    if (lyricQuality(cleanResult) > lyricQuality(result)) result = cleanResult;
  }

  if (cachedFallback && lyricQuality(cachedFallback) > lyricQuality(result)) {
    return { ...cachedFallback, cached: true };
  }

  if (cache) {
    if (result !== null) {
      await cache.set(query, result);
      if (cleanQ) await cache.set(cleanQ, result);
    }
  }

  return result;
}
