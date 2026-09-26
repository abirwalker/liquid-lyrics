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
  stopOnLine = false,
): Promise<LyricsResult | null> {
  let best: LyricsResult | null = null;
  for (const provider of providers) {
    if (signal?.aborted) return null;
    try {
      const result = await provider.fetch(query, signal);
      if (signal?.aborted) return null;
      if (!isValidResult(result) || result.source !== provider.id) continue;
      const quality = lyricQuality(result);
      if (quality === 3 || (stopOnLine && quality === 2)) return result;
      if (quality > lyricQuality(best)) best = result;
    } catch {
      continue;
    }
  }
  return best;
}

function createProviderTiers(): { primary: LyricsProvider[]; fallback: LyricsProvider[] } {
  return {
    primary: [createBiniLyricsProvider(), createLyricsPlusProvider()],
    fallback: [createSpotifyLyricsProvider(), createAmllProvider(), createLrclibProvider()],
  };
}

export function createDefaultChain(): LyricsProvider[] {
  const { primary, fallback } = createProviderTiers();
  return [...primary, ...fallback];
}

export async function fetchLyrics(
  query: LyricsQuery,
  signal?: AbortSignal,
  cache = defaultCache,
): Promise<LyricsResult | null> {
  const cleanQ = createCleanQuery(query);
  const { primary, fallback } = createProviderTiers();
  const providers = [...primary, ...fallback];
  const fetchPreferred = async (candidate: LyricsQuery): Promise<LyricsResult | null> => {
    const preferred = await fetchLyricsChain(candidate, primary, signal);
    if (signal?.aborted || lyricQuality(preferred) >= 2) return preferred;
    const fallbackResult = await fetchLyricsChain(candidate, fallback, signal, true);
    return lyricQuality(fallbackResult) > lyricQuality(preferred) ? fallbackResult : preferred;
  };
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

  let result = await fetchPreferred(query);
  if (signal?.aborted) return null;

  if (lyricQuality(result) < 3 && cleanQ) {
    const cleanResult = await fetchPreferred(cleanQ);
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
